import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createChatGraph, type AssistantModel } from "../src/graph.js";
import { createApp } from "../src/server.js";
import { ToolRegistry } from "../src/tools/index.js";
import { MemoryFixture } from "./helpers.js";

const context = { organizationId: "org-1", employeeId: "employee-1", userId: "user-1", sessionId: "session-1" };
function setup() {
  const memory = new MemoryFixture();
  const model: AssistantModel = {
    preparePromptAndIntent: async ({ prompt }) => ({ polishedPrompt: prompt, intent: prompt === "Hello" ? "task" : "semantic" }),
    semanticCandidates: async () => ["Jazz", "Remote work"],
    checkSemanticScopeBatch: async (items) => items.map(({ candidateId }) => ({ candidateId, supported: true })),
    selectTools: async () => [], planTask: async () => ({ response: "Hello", calls: [] }),
    summarizeEpisode: async () => ({ text: "Hello", intent: "task", steps: [], resolvedAmbiguity: [], outcome: "Hello" }),
  };
  const graph = createChatGraph({ model, memory, tools: new ToolRegistry(), checkpointer: new MemorySaver() });
  return { app: createApp({ graph, memory }), memory, graph };
}
type Review = { reviewId: string; items: { candidateId: string; version: number }[] };
function decide(review: Review, index: number, action = "create", extra = {}) {
  return { candidateId: review.items[index].candidateId, version: review.items[index].version, action, ...extra };
}

describe("session and memory batch HTTP contracts", () => {
  it("requires sessionId, echoes it and rejects cross-session continuation or resume", async () => {
    const { app } = setup();
    const { sessionId: _, ...withoutSession } = context;
    expect((await request(app).post("/chat").send({ ...withoutSession, prompt: "Hello" })).status).toBe(400);
    const start = await request(app).post("/chat").send({ ...context, prompt: "Remember my preferences" });
    expect(start.status).toBe(202);
    expect(start.body.sessionId).toBe(context.sessionId);
    const other = { ...context, sessionId: "another-session" };
    expect((await request(app).post("/chat").send({ ...other, threadId: start.body.threadId, prompt: "Hello" })).status).toBe(409);
    expect((await request(app).post(`/chat/${start.body.threadId}/resume`).send({ ...other,
      reviewId: start.body.review.reviewId, decisions: [decide(start.body.review, 0)] })).status).toBe(409);
    const fresh = await request(app).post("/chat").send({ ...other, prompt: "Hello" });
    expect(fresh.status).toBe(200); expect(fresh.body.threadId).not.toBe(start.body.threadId);
    expect(fresh.body.sessionId).toBe(other.sessionId);
  });

  it("rejects a legacy checkpoint with organization but no session", async () => {
    const { app, graph } = setup(); const threadId = randomUUID();
    await graph.updateState({ configurable: { thread_id: threadId } }, { organizationId: context.organizationId, threadId });
    expect((await request(app).post("/chat").send({ ...context, threadId, prompt: "Hello" })).status).toBe(409);
  });

  it("rejects bad decisions without consuming the pending interrupt, then accepts a valid batch and retry", async () => {
    const { app, memory } = setup();
    const start = await request(app).post("/chat").send({ ...context, prompt: "Remember facts" });
    const review: Review = start.body.review;
    const url = `/chat/${start.body.threadId}/resume`;
    const one = decide(review, 0);
    for (const body of [
      { reviewId: review.reviewId, decisions: [one, one] },
      { reviewId: review.reviewId, decisions: [{ ...one, candidateId: "unknown" }] },
      { reviewId: review.reviewId, decisions: [decide(review, 0, "update", { targetIds: ["elsewhere"] })] },
    ]) expect((await request(app).post(url).send({ ...context, ...body })).status).toBe(400);
    expect((await request(app).post(url).send({ ...context, reviewId: review.reviewId, decisions: [{ ...one, version: 99 }] })).status).toBe(409);
    expect(memory.semantic).toEqual([]);
    const body = { ...context, reviewId: review.reviewId, decisions: [one, decide(review, 1, "skip")] };
    const done = await request(app).post(url).send(body);
    expect(done.status).toBe(200); expect(done.body.memoryOutcomes.map((item: { status: string }) => item.status)).toEqual(["saved", "skipped"]);
    expect(done.body.memoryOutcomes[0].memoryIds).toHaveLength(1);
    expect((await request(app).post(url).send(body)).status).toBe(200);
    expect(memory.semantic).toHaveLength(1);
  });

  it("detects stale target data before any new fact is saved", async () => {
    const { app, memory } = setup(); memory.semantic = [{ id: "old-1", text: "Original" }];
    const start = await request(app).post("/chat").send({ ...context, prompt: "Remember facts" });
    const review: Review = start.body.review;
    await memory.updateSemantic(context, ["old-1"], "Changed by another request");
    const done = await request(app).post(`/chat/${start.body.threadId}/resume`).send({ ...context, reviewId: review.reviewId,
      decisions: [decide(review, 0, "create"), decide(review, 1, "update", { targetIds: ["old-1"] })] });
    expect(done.status).toBe(409);
    expect(memory.semantic).toEqual([{ id: "old-1", text: "Changed by another request" }]);
  });

  it("can retry an approved execution after a transient preflight failure without changing its decisions", async () => {
    const { app, memory } = setup(); memory.semantic = [{ id: "old-1", text: "Original" }];
    const first = await request(app).post("/chat").send({ ...context, prompt: "Remember facts" });
    const review: Review = first.body.review;
    const body = { ...context, reviewId: review.reviewId,
      decisions: [decide(review, 0, "update", { targetIds: ["old-1"] }), decide(review, 1, "skip")] };
    const get = memory.getSemantic.bind(memory); let reads = 0;
    memory.getSemantic = async (...args) => {
      if (++reads === 2) throw new Error("Transient database error");
      return get(...args);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = `/chat/${first.body.threadId}/resume`;
    try {
      expect((await request(app).post(url).send(body)).status).toBe(500);
      expect((await request(app).post(url).send({ ...body,
        decisions: [decide(review, 0, "skip"), decide(review, 1, "skip")] })).status).toBe(409);
      const retry = await request(app).post(url).send(body);
      expect(retry.status).toBe(200);
      expect(retry.body.memoryOutcomes.map((item: { status: string }) => item.status)).toEqual(["updated", "skipped"]);
      expect(memory.semantic).toHaveLength(1);
      expect(memory.semantic[0].text).toBe("Jazz");
    } finally { log.mockRestore(); }
  });

  it("persists a Procedural batch edit, retains other approvals and saves once after a simulated app restart", async () => {
    const { app, memory, graph } = setup();
    const first = await request(app).post("/memory").send({ ...context, items: [{ text: "Test first" }, { text: "Be brief" }] });
    expect(first.status).toBe(202); const review: Review = first.body.review;
    const edited = await request(app).post("/memory/approve").send({ ...context, proposalId: first.body.proposalId,
      reviewId: review.reviewId, decisions: [decide(review, 0, "approve"), decide(review, 1, "edit", { text: "Use concise replies" })] });
    expect(edited.status).toBe(202); expect(memory.procedural).toEqual([]);
    expect(edited.body.review.items[0].decision.action).toBe("create");
    expect(edited.body.review.items[1].version).toBe(2);
    const restartedApp = createApp({ graph, memory });
    const body = { ...context, proposalId: first.body.proposalId, reviewId: edited.body.review.reviewId,
      decisions: [decide(edited.body.review, 1, "approve")] };
    const saved = await request(restartedApp).post("/memory/approve").send(body);
    expect(saved.status).toBe(200); expect(saved.body.outcomes).toHaveLength(2);
    expect(memory.procedural).toEqual(["Test first", "Use concise replies"]);
    expect((await request(restartedApp).post("/memory/approve").send(body)).status).toBe(200);
    expect(memory.procedural).toHaveLength(2);
  });

  it("keeps a partial Procedural review pending and rejects cross-org approval", async () => {
    const { app, memory } = setup();
    const first = await request(app).post("/memory").send({ ...context, items: [{ text: "A" }, { text: "B" }] });
    const base = { ...context, proposalId: first.body.proposalId, reviewId: first.body.review.reviewId };
    expect((await request(app).post("/memory/approve").send({ ...base, organizationId: "other", decisions: [decide(first.body.review, 0, "approve")] })).status).toBe(404);
    const partial = await request(app).post("/memory/approve").send({ ...base, decisions: [decide(first.body.review, 0, "approve")] });
    expect(partial.status).toBe(202); expect(memory.procedural).toEqual([]);
    const done = await request(app).post("/memory/approve").send({ ...base, reviewId: partial.body.review.reviewId,
      decisions: [decide(partial.body.review, 1, "deny")] });
    expect(done.status).toBe(200); expect(memory.procedural).toEqual(["A"]);
    expect(done.body.outcomes.map((item: { status: string }) => item.status)).toEqual(["saved", "skipped"]);
  });
});
