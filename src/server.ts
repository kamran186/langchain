import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Command } from "@langchain/langgraph";
import { ChatBedrockConverse } from "@langchain/aws";
import express from "express";
import { z } from "zod";
import { connectPostgres } from "./db/postgres.js";
import { createChatGraph } from "./graph.js";
import { BedrockAssistantModel, ModelOutputError } from "./llm.js";
import type { MemoryPort } from "./memory.js";
import { ToolRegistry, type ToolResult } from "./tools/index.js";
import { serverTimeTool } from "./tools/server-time.js";
import { registerCustomerTools } from "./tools/customers.js";
import { requestContext, requestContextSchema, sessionContext, sessionContextSchema } from "./context.js";
import { applyReviewDecisions, batchReady, createMemoryBatch, describeMemoryOutcomes, fingerprint,
  memoryDecisionsSchema, reviewPayload, type MemoryBatch } from "./memory-review.js";
import { applyApprovedMemoryBatch, assertSemanticTargets } from "./memory-batch.js";

type Graph = ReturnType<typeof createChatGraph>;
const textInput = z.string().trim().min(1).max(20_000);
const chatInput = sessionContextSchema.extend({ prompt: textInput, threadId: z.string().uuid().optional() });
const reviewInput = sessionContextSchema.extend({
  decision: z.enum(["approve", "decline"]).optional(), proposalId: z.string().optional(),
  reviewId: z.string().optional(), decisions: memoryDecisionsSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.decision === undefined) === (value.decisions === undefined)) ctx.addIssue({ code: "custom", message: "Provide a tool-write decision or memory decisions, not both" });
  if (value.decisions && !value.reviewId) ctx.addIssue({ code: "custom", path: ["reviewId"], message: "reviewId is required" });
});
const memoryInput = requestContextSchema.extend({
  text: textInput.optional(), items: z.array(z.object({ text: textInput }).strict()).min(1).max(100).optional(),
}).refine((value) => (value.text === undefined) !== (value.items === undefined), "Provide text or items, not both");
const memoryApproval = requestContextSchema.extend({
  proposalId: z.string().min(1), reviewId: z.string().optional(),
  text: textInput.optional(), decisions: memoryDecisionsSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.text === undefined) === (value.decisions === undefined)) ctx.addIssue({ code: "custom", message: "Provide legacy text or decisions, not both" });
  if (value.decisions && !value.reviewId) ctx.addIssue({ code: "custom", path: ["reviewId"], message: "reviewId is required" });
});

export function createApp({ graph, memory }: { graph: Graph; memory: MemoryPort }) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const busy = new Set<string>();
  async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (busy.has(key)) throw httpError(409, "This thread or proposal is already running");
    busy.add(key);
    try { return await action(); } finally { busy.delete(key); }
  }

  app.post("/chat", async (req, res) => {
    try {
      const input = chatInput.parse(req.body), threadId = input.threadId ?? randomUUID();
      const result = await exclusive(threadId, async () => {
        const config = { configurable: { thread_id: threadId } };
        const saved = await graph.getState(config);
        if (saved.values.threadId && saved.values.organizationId === undefined) throw httpError(409, "Start a new thread with organization and session context");
        if (saved.values.organizationId !== undefined && saved.values.organizationId !== input.organizationId) throw httpError(403, "Thread belongs to another organization");
        if (saved.values.threadId && saved.values.sessionId === undefined) throw httpError(409, "Start a new thread with session context");
        if (saved.values.sessionId !== undefined && saved.values.sessionId !== input.sessionId) throw httpError(409, "Thread belongs to another session; start a new thread");
        if (saved.next.length) throw httpError(409, "This thread is waiting for a review decision");
        return graph.invoke({ ...sessionContext(input), threadId, prompt: input.prompt }, config);
      });
      sendGraphResult(res, threadId, input.sessionId, result);
    } catch (error) { sendError(res, error); }
  });

  app.post("/chat/:threadId/resume", async (req, res) => {
    try {
      const input = reviewInput.parse(req.body), threadId = z.string().uuid().parse(req.params.threadId);
      const result = await exclusive(threadId, async () => {
        const config = { configurable: { thread_id: threadId } };
        const saved = await graph.getState(config);
        if (saved.values.organizationId === undefined) throw httpError(404, "Thread not found");
        if (saved.values.organizationId !== input.organizationId) throw httpError(403, "Thread belongs to another organization");
        if (saved.values.sessionId === undefined) throw httpError(409, "Start a new thread with session context");
        if (saved.values.sessionId !== input.sessionId) throw httpError(409, "Thread belongs to another session; start a new thread");
        const batch = saved.values.semanticBatch;
        if (batch && saved.next.length && saved.next.every((node) =>
          node === "applyApprovedSemanticBatch" || node === "composeSemanticOutcome" || node === "finalizeResponse")) {
          // Approval is already checkpointed. Only the same submitted choices may retry execution.
          applyReviewDecisions({ ...batch, completed: true }, input.reviewId, input.decisions);
          return graph.invoke(null, config);
        }
        if (saved.next.includes("reviewSemanticBatch") || (!saved.next.length && batch?.completed && input.reviewId === batch.reviewId)) {
          // Invalid approvals must never enter an interrupt's persisted resume stream.
          const checked = applyReviewDecisions(batch!, input.reviewId, input.decisions);
          if (batchReady(checked) && !checked.completed) await assertSemanticTargets(memory, checked);
          if (!saved.next.length) return saved.values;
        } else {
          if (!saved.next.length) throw httpError(409, "Thread has no pending review");
          if (!saved.next.includes("reviewToolWrite") || !input.decision || input.decisions) throw httpError(400, "Expected the pending tool-write decision");
          if (input.decision === "approve" && input.proposalId !== saved.values.writeProposal?.id) throw httpError(400, "Write approval does not match the frozen proposal");
        }
        const { organizationId: _org, employeeId: _employee, userId: _user, sessionId: _session, ...answer } = input;
        return graph.invoke(new Command({ resume: answer, update: { lastRequestContext: sessionContext(input) } }), config);
      });
      sendGraphResult(res, threadId, input.sessionId, result);
    } catch (error) { sendError(res, error); }
  });

  app.post("/memory", async (req, res) => {
    try {
      const input = memoryInput.parse(req.body);
      const batch = createMemoryBatch("procedural", input.items?.map((item) => item.text) ?? [input.text!], requestContext(input));
      if (input.text !== undefined) batch.legacyText = input.text;
      await memory.saveReview(requestContext(input), batch);
      sendProceduralResult(res, batch);
    } catch (error) { sendError(res, error); }
  });

  app.post("/memory/approve", async (req, res) => {
    try {
      const input = memoryApproval.parse(req.body), context = requestContext(input);
      const result = await exclusive(`memory:${fingerprint(input.organizationId)}:${input.proposalId}`, async () => {
        const stored = await memory.getReview(context, input.proposalId);
        if (!stored || stored.kind !== "procedural") throw httpError(404, "Procedural Memory proposal not found");
        let reviewId = input.reviewId, decisions: unknown = input.decisions;
        if (input.text !== undefined) {
          if (stored.legacyText !== input.text || stored.items.length !== 1 || stored.items[0].version !== 1) throw httpError(400, "Procedural Memory approval does not match preview");
          reviewId = stored.reviewId;
          decisions = [{ candidateId: stored.items[0].candidateId, version: 1, action: "create" }];
        }
        const batch = applyReviewDecisions(stored, reviewId, decisions);
        await memory.saveReview(context, batch);
        if (!batchReady(batch) || batch.completed) return batch;
        return applyApprovedMemoryBatch(memory, batch, (progress) => memory.saveReview(context, progress));
      });
      sendProceduralResult(res, result);
    } catch (error) { sendError(res, error); }
  });
  return app;
}

function sendProceduralResult(res: express.Response, batch: MemoryBatch): void {
  if (batch.completed) {
    res.json({ status: "completed", kind: "procedural", proposalId: batch.batchId, reviewId: batch.reviewId,
      response: describeMemoryOutcomes(batch), outcomes: batch.outcomes });
  } else {
    res.status(202).json({ status: "approval_required", kind: "procedural", proposalId: batch.batchId, reviewId: batch.reviewId,
      review: reviewPayload(batch), preview: batch.legacyText !== undefined ? { ...batch.context, text: batch.items[0].text } : { items: reviewPayload(batch).items } });
  }
}

function sendGraphResult(res: express.Response, threadId: string, sessionId: string, result: unknown): void {
  const data = result as { __interrupt__?: { value: unknown }[]; response?: string; toolResults?: ToolResult[]; semanticBatch?: MemoryBatch | null };
  const review = data.__interrupt__?.[0]?.value;
  if (review) res.status(202).json({ status: "approval_required", sessionId, threadId, review });
  else res.json({ status: "completed", sessionId, threadId, response: data.response ?? "", results: data.toolResults ?? [],
    ...(data.semanticBatch ? { memoryOutcomes: data.semanticBatch.outcomes } : {}) });
}

function httpError(status: number, message: string) { return Object.assign(new Error(message), { status }); }
function sendError(res: express.Response, error: unknown): void {
  if (error instanceof ModelOutputError) { res.status(502).json({ error: error.message }); return; }
  if (error instanceof z.ZodError) { res.status(400).json({ error: "Invalid request", details: error.issues }); return; }
  const status = error instanceof Error && "status" in error ? Number(error.status) : 500;
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(status).json({ error: status === 500 ? "Request failed" : message });
  if (status === 500) console.error(error);
}

async function start(): Promise<void> {
  await import("dotenv/config");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const region = process.env.BEDROCK_REGION ?? "us-east-1";
  const { memory, checkpointer, customers } = await connectPostgres({
    databaseUrl, region, bedrockApiKey: process.env.BEDROCK_API_KEY,
    embeddingModel: process.env.BEDROCK_EMBEDDING_MODEL,
    embeddingDimensions: Number(process.env.BEDROCK_EMBEDDING_DIMENSIONS ?? 512),
  });
  const model = new BedrockAssistantModel(new ChatBedrockConverse({
    model: process.env.BEDROCK_MODEL ?? "qwen.qwen3-32b-v1:0",
    region, bedrockBearerToken: process.env.BEDROCK_API_KEY,
  }));
  const tools = new ToolRegistry();
  tools.register(serverTimeTool);
  registerCustomerTools(tools, customers);
  const graph = createChatGraph({ model, memory, tools, checkpointer });
  const app = createApp({ graph, memory });
  app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? "127.0.0.1", () => console.log("Chat API ready"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((error) => { console.error(error); process.exitCode = 1; });
}
