import { MemorySaver } from "@langchain/langgraph";
import { AIMessageChunk } from "@langchain/core/messages";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createChatGraph, type AssistantModel } from "../src/graph.js";
import { createApp } from "../src/server.js";
import { ToolRegistry } from "../src/tools/index.js";
import { BedrockAssistantModel } from "../src/llm.js";
import { MemoryFixture } from "./helpers.js";

const context = { organizationId: "org-1", employeeId: "employee-1", userId: "u1", sessionId: "session-1" };

const model: AssistantModel = {
  preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "semantic" }),
  semanticCandidates: async () => ["I prefer jazz"],
  checkSemanticScopeBatch: async (items) => items.map(({ candidateId }) => ({ candidateId, supported: true })),
  selectTools: async () => [],
  planTask: async () => ({ response: "Done", calls: [] }),
  summarizeEpisode: async () => ({ text: "", intent: "", steps: [], resolvedAmbiguity: [], outcome: "" }),
};

function setup(assistantModel: AssistantModel = model, tools = new ToolRegistry()) {
  const memory = new MemoryFixture();
  const graph = createChatGraph({ model: assistantModel, memory, tools, checkpointer: new MemorySaver() });
  return { app: createApp({ graph, memory }), memory, graph };
}

function approve(review: { items: { candidateId: string; version: number }[] }) {
  return { candidateId: review.items[0].candidateId, version: review.items[0].version, action: "create" };
}

describe("HTTP API", () => {
  it("includes actual customer rows and pagination even when the model only returns an introduction", async () => {
    const customers = Array.from({ length: 5 }, (_, index) => ({
      id: `customer-${index + 1}`, name: `Customer ${index + 1}`, city: "Karachi", country: "Pakistan",
      age: 25 + index, email: `customer${index + 1}@example.com`, gender: "other", network: "Jazz",
      organizationId: "org-1", createdBy: "u1",
    }));
    const tools = new ToolRegistry();
    tools.register({
      name: "get_customers", description: "Get customers", effect: "read",
      schema: z.object({ city: z.string(), limit: z.number().default(5), offset: z.number().default(0) }),
      run: async () => ({ customers, limit: 5, offset: 0 }),
    });
    const { app } = setup({ ...model,
      preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }), selectTools: async () => ["get_customers"],
      planTask: async ({ results }) => results.length
        ? { response: "Here are 5 customers from Karachi, Pakistan:", calls: [] }
        : { calls: [{ id: "read-1", name: "get_customers", args: { city: "Karachi", limit: 5 } }] },
    }, tools);
    const response = await request(app).post("/chat").send({ ...context, prompt: "Get five Karachi customers" });
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([
      { id: "read-1", name: "get_customers", result: { customers, limit: 5, offset: 0 } },
    ]);
    expect(response.body.results[0].result.customers).toHaveLength(5);
  });

  it("completes an empty organization lookup even if the model keeps requesting the same read", async () => {
    let reads = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "get_customers", description: "Get customers", effect: "read",
      schema: z.object({ city: z.string(), limit: z.number().default(5), offset: z.number().default(0) }),
      run: async (_args, toolContext) => {
        expect(toolContext.organizationId).toBe("org-with-no-data");
        reads += 1;
        return { customers: [], limit: 5, offset: 0 };
      },
    });
    let plans = 0;
    const { app } = setup({ ...model,
      preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: "task" }), selectTools: async () => ["get_customers"],
      planTask: async () => ({ calls: [{ id: `read-${++plans}`, name: "get_customers", args: { city: "Karachi" } }] }),
    }, tools);
    const response = await request(app).post("/chat").send({
      ...context, organizationId: "org-with-no-data", prompt: "Get customers from Karachi",
    });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("completed");
    expect(response.body.response).toMatch(/no matching records/i);
    expect(response.body.results).toEqual([
      { id: "read-1", name: "get_customers", result: { customers: [], limit: 5, offset: 0 } },
    ]);
    expect(reads).toBe(1);
  });

  it("reaches Semantic Memory approval when the model returns null scope details", async () => {
    const adapter = new BedrockAssistantModel({
      invoke: async (input) => {
        const payload = JSON.parse((input as unknown as string[][])[1][1]);
        return new AIMessageChunk({ content: JSON.stringify({ results: payload.candidates.map((item: { candidateId: string }) => ({ candidateId: item.candidateId, supported: true, limitation: null, eligiblePreference: null })) }) });
      },
    });
    const { app, memory } = setup({ ...model, checkSemanticScopeBatch: adapter.checkSemanticScopeBatch.bind(adapter) });
    const response = await request(app).post("/chat").send({ ...context, prompt: "Remember I prefer jazz" });
    expect(response.status).toBe(202);
    expect(response.body.review.type).toBe("semantic_batch");
    expect(memory.semantic).toEqual([]);
  });

  it("returns 502 for malformed model output rather than blaming the request body", async () => {
    const adapter = new BedrockAssistantModel({
      invoke: async () => new AIMessageChunk({ content: '{"supported":true,"limitation":123}' }),
    });
    const { app, memory } = setup({ ...model, checkSemanticScopeBatch: adapter.checkSemanticScopeBatch.bind(adapter) });
    const response = await request(app).post("/chat").send({ ...context, prompt: "Remember I prefer jazz" });
    expect(response.status).toBe(502);
    expect(response.body.error).toBe("Model returned an invalid response");
    expect(memory.semantic).toEqual([]);
  });

  it("stores the supplied request IDs in the checkpoint without trimming metadata", async () => {
    const { app, graph } = setup();
    const start = await request(app).post("/chat").send({
      organizationId: "", employeeId: "employee-1", userId: "  user value  ", sessionId: "session-1", prompt: "Remember I prefer jazz",
    });
    expect(start.status).toBe(202);
    const saved = await graph.getState({ configurable: { thread_id: start.body.threadId } });
    expect(saved.values).toMatchObject({ organizationId: "", employeeId: "employee-1", userId: "  user value  " });
  });

  it("accepts an empty userId while requiring all three context keys", async () => {
    const { app } = setup();
    const start = await request(app).post("/chat").send({
      organizationId: "", employeeId: "employee-1", userId: "", sessionId: "session-1", prompt: "Remember I prefer jazz",
    });
    expect(start.status).toBe(202);
    const missingContext = await request(app).post("/chat").send({ userId: "u1", prompt: "Remember I prefer jazz" });
    expect(missingContext.status).toBe(400);
  });

  it("starts /chat, exposes the pending Semantic review, and resumes after approval", async () => {
    const { app, memory } = setup();
    const start = await request(app).post("/chat").send({ ...context, prompt: "Remember I prefer jazz" });
    expect(start.status).toBe(202);
    expect(start.body.review.type).toBe("semantic_batch");
    expect(memory.semantic).toEqual([]);

    const resume = await request(app).post(`/chat/${start.body.threadId}/resume`).send({
      ...context, reviewId: start.body.review.reviewId, decisions: [approve(start.body.review)],
    });
    expect(resume.status).toBe(200);
    expect(resume.body.response).toMatch(/saved/i);
    expect(memory.semantic.map((item) => item.text)).toEqual(["I prefer jazz"]);
    expect(memory.semanticContexts[0]).toMatchObject(context);
  });

  it("rejects another organization's attempt to resume a checkpoint", async () => {
    const { app, memory } = setup();
    const start = await request(app).post("/chat").send({ ...context, prompt: "Remember I prefer jazz" });
    const resume = await request(app).post(`/chat/${start.body.threadId}/resume`).send({
      ...context, organizationId: "another-org", reviewId: start.body.review.reviewId, decisions: [approve(start.body.review)],
    });
    expect(resume.status).toBe(403);
    expect(memory.semantic).toEqual([]);
  });

  it("previews Procedural Memory before saving exact approved text", async () => {
    const { app, memory } = setup();
    const staged = await request(app).post("/memory").send({ ...context, text: "Always test migrations" });
    expect(staged.status).toBe(202);
    expect(staged.body.preview.text).toBe("Always test migrations");
    expect(memory.procedural).toEqual([]);
    const approved = await request(app).post("/memory/approve").send({
      ...context, text: "Always test migrations", proposalId: staged.body.proposalId,
    });
    expect(approved.status).toBe(200);
    expect(memory.procedural).toEqual(["Always test migrations"]);
  });

  it("resumes an empty-organization checkpoint and stores the resume actor metadata", async () => {
    const { app, memory, graph } = setup();
    const start = await request(app).post("/chat").send({
      organizationId: "", employeeId: "", userId: "", sessionId: "session-1", prompt: "Remember I prefer jazz",
    });
    expect(start.status).toBe(202);
    const resumedBy = { organizationId: "", employeeId: "second employee", userId: "  ", sessionId: "session-1" };
    const resumed = await request(app).post(`/chat/${start.body.threadId}/resume`).send({
      ...resumedBy, reviewId: start.body.review.reviewId, decisions: [approve(start.body.review)],
    });
    expect(resumed.status).toBe(200);
    expect(memory.semantic).toHaveLength(1);
    const saved = await graph.getState({ configurable: { thread_id: start.body.threadId } });
    expect(saved.values.lastRequestContext).toEqual(resumedBy);
  });

  it("does not assign an old unscoped thread to a supplied organization", async () => {
    const { app, graph } = setup();
    const threadId = randomUUID();
    await graph.updateState({ configurable: { thread_id: threadId } }, { threadId, userId: "legacy-user" });
    const result = await request(app).post("/chat").send({ ...context, threadId, prompt: "Hello" });
    expect(result.status).toBe(409);
  });
});
