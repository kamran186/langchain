import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { BedrockAssistantModel } from "../src/llm.js";
import { PostgresMemory } from "../src/memory.js";
import { ToolRegistry } from "../src/tools/index.js";
import { createMemoryBatch } from "../src/memory-review.js";

const context = { organizationId: "org-1", employeeId: "employee-1", userId: "user-1", sessionId: "session-1" };
class Store {
  items = new Map<string, Record<string, unknown>>();
  async put(namespace: string[], key: string, value: Record<string, unknown>) {
    this.items.set(JSON.stringify([namespace, key]), structuredClone(value));
  }
  async get(namespace: string[], key: string) {
    const value = this.items.get(JSON.stringify([namespace, key]));
    return value ? { key, value: structuredClone(value) } : null;
  }
  async search(namespace: string[]) {
    return [...this.items.entries()].flatMap(([key, value]) => {
      const [ns, id] = JSON.parse(key);
      return JSON.stringify(ns) === JSON.stringify(namespace) ? [{ key: id, value, score: 0.9 }] : [];
    });
  }
}

describe("generic core contracts", () => {
  it("prepares prompt and intent using one model invocation with current history", async () => {
    const messages: unknown[] = [];
    const model = new BedrockAssistantModel({ invoke: async (input) => {
      messages.push(input);
      return new AIMessageChunk({ content: JSON.stringify({ polishedPrompt: "Get the time", intent: "task" }) });
    } });
    const history = [{ role: "user" as const, content: "Use UTC" }];
    expect(await model.preparePromptAndIntent({ prompt: "time pls", history }))
      .toEqual({ polishedPrompt: "Get the time", intent: "task" });
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0])).toContain("Use UTC");
  });

  it("sends only names and descriptions for tool selection", async () => {
    let payload = "";
    const model = new BedrockAssistantModel({ invoke: async (input) => {
      payload = JSON.stringify(input);
      return new AIMessageChunk({ content: '{"names":["read_note"]}' });
    } });
    await model.selectTools("Read note", [{ name: "read_note", description: "Read a note", effect: "read",
      schema: z.object({ secretField: z.string() }), run: async () => ({}) }]);
    expect(payload).toContain("read_note");
    expect(payload).not.toContain("secretField");
    expect(payload).not.toContain('"schema"');
  });

  it("isolates Semantic Memory by organization and session while sharing within the same session", async () => {
    const memory = new PostgresMemory(new Store() as unknown as PostgresStore);
    const saved = await memory.createSemantic(context, "I prefer jazz");
    expect(await memory.searchSemantic({ ...context, userId: "someone-else" }, "jazz")).toHaveLength(1);
    expect(await memory.searchSemantic({ ...context, sessionId: "session-2" }, "jazz")).toEqual([]);
    await expect(memory.updateSemantic({ ...context, sessionId: "session-2" }, [saved.id], "rock"))
      .rejects.toThrow(/not found/i);
    expect(await memory.searchSemantic({ ...context, organizationId: "another" }, "jazz")).toEqual([]);
  });

  it("keeps Procedural and Episodic Memory organization scoped and records the source session", async () => {
    const memory = new PostgresMemory(new Store() as unknown as PostgresStore);
    await memory.saveProcedural(context, "Use concise replies");
    await memory.saveEpisode(context, { text: "Read time", intent: "task", steps: ["server_time"], resolvedAmbiguity: [], outcome: "Answered" });
    expect(await memory.searchProcedural({ ...context, sessionId: "session-2" }, "concise")).toHaveLength(1);
    expect((await memory.searchEpisodic({ ...context, sessionId: "session-2" }, "time"))[0].sourceSessionId).toBe("session-1");
  });

  it("binds frozen write approvals to the current session", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "write_note", description: "Write", effect: "write", schema: z.object({ text: z.string() }),
      preview: ({ text }) => ({ target: "notes", fields: { text }, effect: "Create" }), run: async () => ({}) });
    const toolContext = { ...context, threadId: "thread-1" };
    const proposal = registry.prepareWrites([{ id: "one", name: "write_note", args: { text: "hello" } }], toolContext);
    await expect(registry.executeApprovedWrites(proposal, proposal.id, { ...toolContext, sessionId: "session-2" }))
      .rejects.toThrow(/approval/i);
  });

  it("persists review proposals across memory adapter instances without indexing them as memories", async () => {
    const store = new Store() as unknown as PostgresStore;
    const memory = new PostgresMemory(store);
    const proposal = createMemoryBatch("procedural", ["Test first", "Use concise replies"], context);
    await memory.saveReview(context, proposal);
    expect(await new PostgresMemory(store).getReview(context, proposal.batchId)).toEqual(proposal);
    expect(await memory.getReview({ ...context, organizationId: "other" }, proposal.batchId)).toBeNull();
    expect(await memory.searchProcedural(context, "Test")).toEqual([]);
  });

  it("does not overwrite a prior idempotent create with different text", async () => {
    const memory = new PostgresMemory(new Store() as unknown as PostgresStore);
    await memory.createSemantic(context, "Original", "write-1");
    await expect(memory.createSemantic(context, "Changed", "write-1")).rejects.toThrow(/retry|write|conflict/i);
    expect((await memory.getSemantic(context, ["write-1"]))[0].text).toBe("Original");
  });
});
