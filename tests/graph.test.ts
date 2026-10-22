import { randomUUID } from "node:crypto";
import { Command, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createChatGraph, type AssistantModel } from "../src/graph.js";
import { ToolRegistry } from "../src/tools/index.js";

import { MemoryFixture } from "./helpers.js";

function model(overrides: Partial<AssistantModel> = {}): AssistantModel {
  return {
    preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "semantic" }),
    semanticCandidates: async () => ["I prefer jazz"],
    checkSemanticScopeBatch: async (items) => items.map(({ candidateId }) => ({ candidateId, supported: true })),
    selectTools: async (_prompt, tools) => tools.map((tool) => tool.name),
    planTask: async () => ({ response: "Done", calls: [] }),
    summarizeEpisode: async (input) => ({
      text: input.outcome,
      intent: input.prompt,
      steps: input.steps,
      resolvedAmbiguity: [],
      outcome: input.outcome,
    }),
    ...overrides,
  };
}

function setup(memory = new MemoryFixture(), assistantModel = model(), tools = new ToolRegistry()) {
  const graph = createChatGraph({ model: assistantModel, memory, tools, checkpointer: new MemorySaver() });
  const threadId = randomUUID();
  const config = { configurable: { thread_id: threadId } };
  const input = { organizationId: "org-1", employeeId: "employee-1", userId: "user-1", sessionId: "session-1", threadId, prompt: "Remember I prefer jazz" };
  return { graph, memory, tools, input, config };
}

function interruptValue(result: unknown): Record<string, unknown> {
  const value = (result as { __interrupt__?: { value: Record<string, unknown> }[] }).__interrupt__?.[0]?.value;
  if (!value) throw new Error("Expected graph interrupt");
  return value;
}

function decide(review: Record<string, unknown>, index: number, action: string, extra = {}) {
  const item = (review.items as { candidateId: string; version: number }[])[index];
  return { candidateId: item.candidateId, version: item.version, action, ...extra };
}

describe("chat graph", () => {
  it("prepares each request once using current-thread history and supplies resolved tool definitions", async () => {
    const preparations: { prompt: string; history: unknown[] }[] = [];
    const tools = new ToolRegistry();
    tools.register({ name: "read_note", description: "Read note", effect: "read", schema: z.object({ noteId: z.string() }), run: async () => ({}) });
    const { graph, input, config } = setup(new MemoryFixture(), model({
      preparePromptAndIntent: async (value) => { preparations.push(value); return { polishedPrompt: value.prompt, intent: "task" }; },
      planTask: async ({ tools: selected, sessionId }) => {
        expect(selected[0].schema.safeParse({ noteId: "one" }).success).toBe(true);
        expect(sessionId).toBe("session-1");
        return { response: "Explained", calls: [] };
      },
    }), tools);
    await graph.invoke({ ...input, prompt: "Explain notes" }, config);
    await graph.invoke({ ...input, prompt: "Explain again" }, config);
    expect(preparations).toHaveLength(2);
    expect(preparations[0].history).toEqual([]);
    expect(preparations[1].history).toEqual([{ role: "user", content: "Explain notes" }, { role: "assistant", content: "Explained" }]);
  });
  it("confirms every fact in one combined review before writing", async () => {
    const { graph, memory, input, config } = setup();
    const approval = interruptValue(await graph.invoke(input, config));
    expect(approval.type).toBe("semantic_batch");
    expect(approval.items).toHaveLength(1);
    expect(memory.semantic).toEqual([]);
    const done = await graph.invoke(new Command({ resume: { reviewId: approval.reviewId,
      decisions: [decide(approval, 0, "create")] } }), config);
    expect(memory.semantic.map((item) => item.text)).toEqual(["I prefer jazz"]);
    expect(done.response).toMatch(/saved/i);
    expect(done.semanticBatch?.outcomes[0].memoryIds).toHaveLength(1);
  });

  it("collects mixed decisions for all IDs before applying the batch", async () => {
    const memory = new MemoryFixture();
    memory.semantic = [{ id: "old-1", text: "I like jazz" }];
    const { graph, input, config } = setup(memory, model({ semanticCandidates: async () => ["I prefer jazz", "I work remotely", "I like tea"] }));
    const approval = interruptValue(await graph.invoke(input, config));
    expect(approval.items).toHaveLength(3);
    const partial = interruptValue(await graph.invoke(new Command({ resume: { reviewId: approval.reviewId,
      decisions: [decide(approval, 0, "update", { targetIds: ["old-1"] })] } }), config));
    expect(memory.semantic).toEqual([{ id: "old-1", text: "I like jazz" }]);
    const done = await graph.invoke(new Command({ resume: { reviewId: partial.reviewId,
      decisions: [decide(partial, 1, "create"), decide(partial, 2, "skip")] } }), config);
    expect(memory.semantic.map((item) => item.text)).toEqual(["I prefer jazz", "I work remotely"]);
    expect(done.semanticBatch?.outcomes.map((item) => item.status)).toEqual(["updated", "saved", "skipped"]);
  });

  it("reprocesses only an edited fact while retaining the other approval", async () => {
    const scoped: string[][] = [];
    const { graph, memory, input, config } = setup(new MemoryFixture(), model({
      semanticCandidates: async () => ["Jazz", "Remote work"],
      checkSemanticScopeBatch: async (items) => { scoped.push(items.map((item) => item.text)); return items.map(({ candidateId }) => ({ candidateId, supported: true })); },
    }));
    const first = interruptValue(await graph.invoke(input, config));
    const second = interruptValue(await graph.invoke(new Command({ resume: { reviewId: first.reviewId,
      decisions: [decide(first, 0, "create"), decide(first, 1, "edit", { text: "Hybrid work" })] } }), config));
    expect(scoped).toEqual([["Jazz", "Remote work"], ["Hybrid work"]]);
    expect(memory.searches).toEqual(["Jazz", "Remote work", "Hybrid work"]);
    expect((second.items as { version: number }[])[1].version).toBe(2);
    expect(memory.semantic).toEqual([]);
    await graph.invoke(new Command({ resume: { reviewId: second.reviewId, decisions: [decide(second, 1, "create")] } }), config);
    expect(memory.semantic.map((item) => item.text)).toEqual(["Jazz", "Hybrid work"]);
  });

  it("includes limitations in the batch and reviews exact preference text before saving", async () => {
    const memory = new MemoryFixture();
    const scopedModel = model({
      semanticCandidates: async () => ["Play music on Spotify; I prefer jazz"],
      checkSemanticScopeBatch: async (items) => items.map(({ candidateId, text }) => ({ candidateId,
        ...(text.includes("Spotify") ? { supported: false, limitation: "No Spotify tool", eligiblePreference: "I prefer jazz" } : { supported: true }) })),
    });
    const { graph, input, config } = setup(memory, scopedModel);
    const first = interruptValue(await graph.invoke(input, config));
    expect((first.items as { scope: unknown }[])[0].scope).toMatchObject({ supported: false, limitation: "No Spotify tool" });
    const second = interruptValue(await graph.invoke(new Command({ resume: { reviewId: first.reviewId, decisions: [decide(first, 0, "preference")] } }), config));
    expect((second.items as { text: string }[])[0].text).toBe("I prefer jazz");
    expect(memory.searches).toEqual(["I prefer jazz"]);
    expect(memory.semantic).toEqual([]);
    await graph.invoke(new Command({ resume: { reviewId: second.reviewId, decisions: [decide(second, 0, "create")] } }), config);
    expect(memory.semantic[0].text).toBe("I prefer jazz");
  });

  it("executes registered read tools and records one episode", async () => {
    const memory = new MemoryFixture();
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup_city", description: "Look up a city", effect: "read",
      schema: z.object({ code: z.string() }),
      run: async ({ code }) => ({ city: code === "NYC" ? "New York" : "Unknown" }),
    });
    let turns = 0;
    const taskModel = model({
      preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }),
      planTask: async ({ results }) => {
        turns += 1;
        return results.length === 0
          ? { calls: [{ id: "read-1", name: "lookup_city", args: { code: "NYC" } }] }
          : { response: "NYC is New York", calls: [] };
      },
    });
    const { graph, input, config } = setup(memory, taskModel, tools);
    const done = await graph.invoke(input, config);
    expect(done.response).toBe("NYC is New York");
    expect(turns).toBe(2);
    expect(memory.episodes).toHaveLength(1);
    expect(memory.episodes[0].steps).toContain("lookup_city");
  });

  it("stops repeated equivalent reads while allowing changed filters and fresh reads on the next request", async () => {
    const reads: string[] = [];
    const tools = new ToolRegistry();
    tools.register({ name: "lookup_city", description: "Look up cities", effect: "read",
      schema: z.object({ city: z.string(), limit: z.number().default(5) }),
      run: async ({ city }) => { reads.push(city); return { cities: [city] }; },
    });
    const taskModel = model({ preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }),
      planTask: async ({ results }) => results.length === 0
        ? { calls: [{ id: "one", name: "lookup_city", args: { city: "Karachi" } }] }
        : { calls: [{ id: "next", name: "lookup_city", args: results.length === 1
          ? { limit: 5, city: "Lahore" } : { city: "Lahore" } }] },
    });
    const { graph, input, config } = setup(new MemoryFixture(), taskModel, tools);
    const done = await graph.invoke(input, config);
    expect(reads).toEqual(["Karachi", "Lahore"]);
    expect(done.toolResults).toHaveLength(2);
    await graph.invoke({ ...input, prompt: "Look up cities again" }, config);
    expect(reads).toEqual(["Karachi", "Lahore", "Karachi", "Lahore"]);
  });

  it("permits a fresh read after an approved write changes the data", async () => {
    let value = 0;
    const observed: number[] = [];
    const tools = new ToolRegistry();
    tools.register({ name: "read_counter", description: "Read counter", effect: "read", schema: z.object({}),
      run: async () => { observed.push(value); return { value }; },
    });
    tools.register({ name: "increment_counter", description: "Increment counter", effect: "write", schema: z.object({}),
      preview: () => ({ target: "counter", fields: { increment: 1 }, effect: "Increment" }),
      run: async () => ({ value: ++value }),
    });
    const taskModel = model({ preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }),
      planTask: async ({ results }) => {
        if (results.length === 0) return { calls: [{ id: "read-1", name: "read_counter", args: {} }] };
        if (results.length === 1) return { calls: [{ id: "write-1", name: "increment_counter", args: {} }] };
        if (results.length === 2) return { calls: [{ id: "read-2", name: "read_counter", args: {} }] };
        return { response: "Counter is 1", calls: [] };
      },
    });
    const { graph, input, config } = setup(new MemoryFixture(), taskModel, tools);
    const approval = interruptValue(await graph.invoke(input, config));
    const done = await graph.invoke(new Command({ resume: { decision: "approve", proposalId: approval.proposalId } }), config);
    expect(observed).toEqual([0, 1]);
    expect(done.response).toBe("Counter is 1");
  });

  it("reaches the application planning limit before the graph recursion limit", async () => {
    let reads = 0;
    const tools = new ToolRegistry();
    tools.register({ name: "lookup_page", description: "Read a page", effect: "read",
      schema: z.object({ offset: z.number() }),
      run: async () => { reads += 1; return { items: [] }; },
    });
    const taskModel = model({ preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }),
      planTask: async ({ results }) => ({ calls: [{ id: `read-${results.length}`, name: "lookup_page", args: { offset: results.length } }] }),
    });
    const { graph, input, config } = setup(new MemoryFixture(), taskModel, tools);
    const done = await graph.invoke(input, config);
    expect(done.response).toBeTruthy();
    expect(reads).toBe(8);
  });

  it("previews a write and executes it only after exact approval", async () => {
    const writes: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "create_note", description: "Create a note", effect: "write",
      schema: z.object({ text: z.string() }),
      preview: ({ text }) => ({ target: "notes", fields: { text }, effect: "Create note" }),
      run: async ({ text }) => { writes.push(text); return { id: "n1" }; },
    });
    const taskModel = model({
      preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }),
      planTask: async ({ results }) => results.length === 0
        ? { calls: [{ id: "write-1", name: "create_note", args: { text: "hello" } }] }
        : { response: "Note created", calls: [] },
    });
    const { graph, input, config } = setup(new MemoryFixture(), taskModel, tools);
    const paused = await graph.invoke(input, config);
    const approval = interruptValue(paused);
    expect(approval.type).toBe("tool_write");
    expect(writes).toEqual([]);

    const done = await graph.invoke(new Command({
      resume: { decision: "approve", proposalId: approval.proposalId },
    }), config);
    expect(done.response).toBe("Note created");
    expect(writes).toEqual(["hello"]);
  });

  it("does not execute a declined tool write", async () => {
    const writes: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "create_note", description: "Create a note", effect: "write",
      schema: z.object({ text: z.string() }),
      preview: ({ text }) => ({ target: "notes", fields: { text }, effect: "Create note" }),
      run: async ({ text }) => { writes.push(text); return { id: "n1" }; },
    });
    const taskModel = model({
      preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }),
      planTask: async ({ writeDeclined }) => writeDeclined
        ? { response: "Write cancelled", calls: [] }
        : { calls: [{ id: "write-1", name: "create_note", args: { text: "hello" } }] },
    });
    const { graph, input, config } = setup(new MemoryFixture(), taskModel, tools);
    await graph.invoke(input, config);
    const done = await graph.invoke(new Command({ resume: { decision: "decline" } }), config);
    expect(done.response).toBe("Write cancelled");
    expect(writes).toEqual([]);
  });

  it("executes every approved batch entry even when the model repeats its call ID", async () => {
    const records = new Map<string, string>();
    const tools = new ToolRegistry();
    tools.register({
      name: "create_note", description: "Create a note", effect: "write",
      schema: z.object({ text: z.string() }),
      preview: ({ text }) => ({ target: "notes", fields: { text }, effect: "Create note" }),
      run: async ({ text }, context) => {
        const key = context.idempotencyKey!;
        if (!records.has(key)) records.set(key, text);
        return { text: records.get(key) };
      },
    });
    const calls = Array.from({ length: 10 }, (_, index) => ({
      id: "same-id", name: "create_note", args: { text: `Note ${index + 1}` },
    }));
    const taskModel = model({
      preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }),
      planTask: async ({ results }) => results.length ? { response: "Created 10 notes", calls: [] } : { calls },
    });
    const { graph, input, config, memory } = setup(new MemoryFixture(), taskModel, tools);
    const approval = interruptValue(await graph.invoke(input, config));
    expect(approval.previews).toHaveLength(10);
    expect(records.size).toBe(0);
    const done = await graph.invoke(new Command({
      resume: { decision: "approve", proposalId: approval.proposalId },
    }), config);
    expect(done.toolResults).toHaveLength(10);
    expect(records.size).toBe(10);
    expect(new Set(done.toolResults.map((result) => (result.result as { text: string }).text)).size).toBe(10);
    expect(memory.episodes).toHaveLength(1);
  });

  it("uses registered read results to fill the frozen write preview", async () => {
    const writes: string[] = [];
    const tools = new ToolRegistry();
    tools.register({ name: "read_name", description: "Read name", effect: "read",
      schema: z.object({}), run: async () => ({ name: "Mina" }) });
    tools.register({ name: "create_note", description: "Create note", effect: "write",
      schema: z.object({ text: z.string() }),
      preview: ({ text }) => ({ target: "notes", fields: { text }, effect: "Create note" }),
      run: async ({ text }) => { writes.push(text); return { id: "n1" }; } });
    const taskModel = model({
      preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }),
      planTask: async ({ results }) => results.length === 0
        ? { calls: [
          { id: "r1", name: "read_name", args: {} },
          { id: "w1", name: "create_note", args: { text: "placeholder" } },
        ] }
        : results.some((result) => result.name === "create_note")
          ? { response: "Note created", calls: [] }
          : { calls: [{ id: "w1", name: "create_note", args: { text: "Mina" } }] },
    });
    const { graph, input, config } = setup(new MemoryFixture(), taskModel, tools);
    const paused = await graph.invoke(input, config);
    const approval = interruptValue(paused);
    expect(approval.previews).toEqual([{ target: "notes", fields: { text: "Mina" }, effect: "Create note" }]);
    expect(writes).toEqual([]);
    await graph.invoke(new Command({ resume: { decision: "approve", proposalId: approval.proposalId } }), config);
    expect(writes).toEqual(["Mina"]);
  });

  it("returns a response without write approval if a read resolves the request", async () => {
    const tools = new ToolRegistry();
    tools.register({ name: "read_name", description: "Read name", effect: "read",
      schema: z.object({}), run: async () => ({ name: "Mina" }) });
    tools.register({ name: "create_note", description: "Create note", effect: "write",
      schema: z.object({ text: z.string() }),
      preview: ({ text }) => ({ target: "notes", fields: { text }, effect: "Create note" }),
      run: async () => ({ id: "n1" }) });
    const taskModel = model({ preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }),
      planTask: async ({ results }) => results.length
        ? { response: "The name is Mina", calls: [] }
        : { calls: [
          { id: "r1", name: "read_name", args: {} },
          { id: "w1", name: "create_note", args: { text: "placeholder" } },
        ] },
    });
    const { graph, input, config } = setup(new MemoryFixture(), taskModel, tools);
    const done = await graph.invoke(input, config);
    expect(done.response).toBe("The name is Mina");
  });

  it("asks for missing write inputs before offering approval", async () => {
    const tools = new ToolRegistry();
    tools.register({ name: "create_note", description: "Create note", effect: "write",
      schema: z.object({ text: z.string() }),
      preview: ({ text }) => ({ target: "notes", fields: { text }, effect: "Create note" }),
      run: async () => ({ id: "n1" }) });
    const taskModel = model({ preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }),
      planTask: async () => ({ calls: [{ id: "w1", name: "create_note", args: {} }] }),
    });
    const { graph, input, config } = setup(new MemoryFixture(), taskModel, tools);
    const done = await graph.invoke(input, config);
    expect(done.response).toMatch(/need these write inputs.*text/i);
    expect((done as { __interrupt__?: unknown }).__interrupt__).toBeUndefined();
  });
});
