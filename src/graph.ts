import { Annotation, interrupt, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { createHash } from "node:crypto";
import type { MemoryPort, Episode } from "./memory.js";
import type { RegisteredTool, ToolCall, ToolRegistry, ToolResult } from "./tools/index.js";
import { applyReviewDecisions, batchReady, createMemoryBatch, describeMemoryOutcomes, refreshReview, reviewPayload, type MemoryBatch, type MemoryScope } from "./memory-review.js";
import { applyApprovedMemoryBatch } from "./memory-batch.js";
import { describeReadResults, prepareWriteProposal, recordEpisode } from "./task.js";
import type { WriteProposal } from "./tools/index.js";
import { z } from "zod";
import { sessionContext, type SessionContext } from "./context.js";

export type Intent = "semantic" | "procedural" | "task";
export type ScopeResult = MemoryScope;
export type TaskPlan = { response?: string; calls: ToolCall[] };
export type TaskModelInput = {
  prompt: string;
  sessionId: string;
  semantic: string[];
  procedural: string[];
  episodic: Episode[];
  results: ToolResult[];
  tools: RegisteredTool[];
  writeDeclined: boolean;
  history: { role: "user" | "assistant"; content: string }[];
};
export interface AssistantModel {
  preparePromptAndIntent(input: { prompt: string; history: History }): Promise<{ polishedPrompt: string; intent: Intent }>;
  semanticCandidates(prompt: string): Promise<string[]>;
  checkSemanticScopeBatch(candidates: { candidateId: string; text: string }[], tools: RegisteredTool[]): Promise<(ScopeResult & { candidateId: string })[]>;
  selectTools(prompt: string, tools: RegisteredTool[]): Promise<string[]>;
  planTask(input: TaskModelInput): Promise<TaskPlan>;
  summarizeEpisode(input: { prompt: string; steps: string[]; outcome: string }): Promise<Episode>;
}
export type GraphDependencies = {
  model: AssistantModel;
  memory: MemoryPort;
  tools: ToolRegistry;
  checkpointer: BaseCheckpointSaver;
};

export type History = { role: "user" | "assistant"; content: string }[];
const State = Annotation.Root({
  organizationId: Annotation<string>,
  employeeId: Annotation<string>,
  userId: Annotation<string>,
  sessionId: Annotation<string>,
  lastRequestContext: Annotation<SessionContext>,
  threadId: Annotation<string>,
  prompt: Annotation<string>,
  polishedPrompt: Annotation<string>,
  intent: Annotation<Intent>,
  response: Annotation<string>,
  history: Annotation<History>,
  semanticBatch: Annotation<MemoryBatch | null>,
  semantic: Annotation<string[]>,
  procedural: Annotation<string[]>,
  episodic: Annotation<Episode[]>,
  selectedTools: Annotation<string[]>,
  toolCalls: Annotation<ToolCall[]>,
  toolResults: Annotation<ToolResult[]>,
  readCache: Annotation<Record<string, ToolResult>>,
  toolSteps: Annotation<string[]>,
  writeProposal: Annotation<WriteProposal | null>,
  approvedProposalId: Annotation<string>,
  writeDeclined: Annotation<boolean>,
  taskTurns: Annotation<number>,
});
type ChatState = typeof State.State;

export function createChatGraph({ model, memory, tools, checkpointer }: GraphDependencies) {
  const context = (s: ChatState) => ({ ...sessionContext(s), threadId: s.threadId });
  const taskInput = (s: ChatState): TaskModelInput => ({
    prompt: s.polishedPrompt,
    sessionId: s.sessionId,
    semantic: s.semantic ?? [],
    procedural: s.procedural ?? [],
    episodic: s.episodic ?? [],
    results: s.toolResults ?? [],
    tools: (s.selectedTools ?? []).map((name) => tools.get(name, context(s))),
    writeDeclined: s.writeDeclined ?? false,
    history: s.history ?? [],
  });

  const graph = new StateGraph(State)
    .addNode("preparePromptAndIntent", async (s) => {
      return {
        ...await model.preparePromptAndIntent({ prompt: s.prompt, history: s.history ?? [] }),
        lastRequestContext: sessionContext(s),
        response: "", semanticBatch: null,
        toolResults: [], readCache: {}, toolSteps: [], toolCalls: [], selectedTools: [],
        writeProposal: null, approvedProposalId: "", writeDeclined: false, taskTurns: 0,
      };
    })

    .addNode("prepareSemanticBatch", async (s) => {
      const texts = (await model.semanticCandidates(s.polishedPrompt)).map((value) => value.trim()).filter(Boolean);
      return { semanticBatch: texts.length ? createMemoryBatch("semantic", texts, context(s)) : null };
    })
    .addNode("checkSemanticToolScopeBatch", async (s) => {
      const batch = structuredClone(s.semanticBatch!);
      const pending = batch.items.filter((item) => !item.prepared);
      const scopes = await model.checkSemanticScopeBatch(pending.map(({ candidateId, text }) => ({ candidateId, text })), tools.list(context(s)));
      if (scopes.length !== pending.length || new Set(scopes.map((scope) => scope.candidateId)).size !== pending.length ||
        scopes.some((scope) => !pending.some((item) => item.candidateId === scope.candidateId))) throw new Error("Invalid scope batch from model");
      for (const item of pending) {
        const { candidateId: _id, ...scope } = scopes.find((value) => value.candidateId === item.candidateId)!;
        item.scope = scope;
      }
      return { semanticBatch: batch };
    })
    .addNode("searchSimilarSemanticBatch", async (s) => {
      const batch = structuredClone(s.semanticBatch!);
      const pending = batch.items.filter((item) => !item.prepared);
      const results = await memory.searchSemanticBatch(context(s), pending.filter((item) => item.scope?.supported)
        .map(({ candidateId, text }) => ({ candidateId, text })));
      for (const item of pending) {
        const found = results.find((value) => value.candidateId === item.candidateId);
        item.matches = found?.matches ?? [];
        if (found?.error) item.error = found.error;
        else if (item.scope?.supported && !found) item.error = "Could not search existing Semantic Memory; edit to retry or skip.";
        item.prepared = true;
      }
      return { semanticBatch: refreshReview(batch) };
    })
    .addNode("reviewSemanticBatch", (s) => {
      const answer = interrupt(reviewPayload(s.semanticBatch!)) as { reviewId?: string; decisions?: unknown };
      return { semanticBatch: applyReviewDecisions(s.semanticBatch!, answer.reviewId, answer.decisions) };
    })
    .addNode("applyApprovedSemanticBatch", async (s) => ({
      semanticBatch: await applyApprovedMemoryBatch(memory, s.semanticBatch!),
    }))
    .addNode("composeSemanticOutcome", (s) => ({
      response: s.semanticBatch ? describeMemoryOutcomes(s.semanticBatch) : "No Semantic Memory was saved.",
    }))
    .addNode("respondWithMemoryApi", () => ({
      response: "For Procedural Memory, use the /memory API. Submit all instructions as items and review their IDs together.",
    }))

    // For Our Tools Calling
    .addNode("loadRelevantMemories", async (s) => {
      const [semantic, procedural, episodic] = await Promise.all([
        memory.searchSemantic(context(s), s.polishedPrompt),
        memory.searchProcedural(context(s), s.polishedPrompt),
        memory.searchEpisodic(context(s), s.polishedPrompt),
      ]);
      return { semantic: semantic.map((item) => item.text), procedural, episodic };
    })
    .addNode("selectRelevantTools", async (s) => {
      const available = tools.list(context(s));
      const names = await model.selectTools(s.polishedPrompt, available);
      return { selectedTools: [...new Set(names)].filter((name) => available.some((tool) => tool.name === name)) };
    })
    .addNode("agentModel", async (s) => {
      if ((s.taskTurns ?? 0) >= 8) return { response: "Tool step limit reached.", toolCalls: [], taskTurns: s.taskTurns + 1 };
      const plan = await model.planTask(taskInput(s));
      if (plan.calls.length > 0 && plan.calls.every((call) =>
        s.selectedTools.includes(call.name) && tools.get(call.name, context(s)).effect === "read")) {
        const cache = s.readCache ?? {};
        const pending = plan.calls.filter((call) => !cache[tools.readKey(call, context(s))]);
        if (pending.length === 0) {
          const results = plan.calls.map((call) => cache[tools.readKey(call, context(s))]);
          return { response: describeReadResults(results), toolCalls: [], taskTurns: (s.taskTurns ?? 0) + 1 };
        }
        return { response: plan.response ?? "", toolCalls: pending, taskTurns: (s.taskTurns ?? 0) + 1 };
      }
      return { response: plan.response ?? "", toolCalls: plan.calls, taskTurns: (s.taskTurns ?? 0) + 1 };
    })
    .addNode("authorizeToolCalls", (s) => {
      for (const call of s.toolCalls) {
        if (!s.selectedTools.includes(call.name)) throw new Error(`Tool not selected for this request: ${call.name}`);
        tools.get(call.name, context(s));
      }
      return {};
    })
    .addNode("prepareWriteProposal", async (s) => {
      try {
        const prepared = await prepareWriteProposal(s.toolCalls, tools, context(s), model, taskInput(s));
        return {
          writeProposal: prepared.proposal,
          response: prepared.response ?? s.response,
          toolResults: [...s.toolResults, ...prepared.readResults],
          toolSteps: [...s.toolSteps, ...prepared.readResults.map((result) => result.name)],
        };
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
        const fields = [...new Set(error.issues.map((issue) => issue.path.join(".") || "input"))];
        return { writeProposal: null, response: `I need these write inputs before asking for approval: ${fields.join(", ")}.` };
      }
    })
    .addNode("reviewToolWrite", (s) => {
      if (!s.writeProposal) throw new Error("No write proposal to review");
      const answer = interrupt({
        type: "tool_write", proposalId: s.writeProposal.id,
        calls: s.writeProposal.calls, previews: s.writeProposal.previews,
        choices: ["approve", "decline"],
      }) as { decision?: string; proposalId?: string };
      if (answer.decision === "approve" && answer.proposalId === s.writeProposal.id) {
        return { approvedProposalId: answer.proposalId, writeDeclined: false };
      }
      if (answer.decision === "decline") return { approvedProposalId: "", writeDeclined: true };
      throw new Error("Write approval does not match the frozen proposal");
    })
    .addNode("executeRegisteredTools", async (s) => {
      const writing = Boolean(s.approvedProposalId && s.writeProposal);
      const results = s.approvedProposalId && s.writeProposal
        ? await tools.executeApprovedWrites(s.writeProposal, s.approvedProposalId, context(s))
        : await tools.executeReads(s.toolCalls, context(s));
      const readCache = writing ? {} : { ...(s.readCache ?? {}) };
      if (!writing) {
        results.forEach((result, index) => { readCache[tools.readKey(s.toolCalls[index], context(s))] = result; });
      }
      return {
        toolResults: [...s.toolResults, ...results],
        readCache,
        toolSteps: [...s.toolSteps, ...results.map((result) => result.name)],
        writeProposal: null, approvedProposalId: "",
      };
    })
    .addNode("composeTaskResponse", (s) => ({
      response: s.response || (s.writeDeclined ? "Write cancelled." : "Done."),
    }))
    .addNode("recordEpisode", async (s) => {
      try {
        await recordEpisode(model, memory, context(s), {
          prompt: s.polishedPrompt, steps: s.toolSteps, outcome: s.response,
        }, createHash("sha256").update(JSON.stringify([s.threadId, s.history?.length ?? 0, s.prompt])).digest("hex"));
        return {};
      } catch {
        return { response: `${s.response}\nEpisodic Memory could not be saved.` };
      }
    })
    .addNode("finalizeResponse", (s) => ({
      history: [...(s.history ?? []), { role: "user" as const, content: s.prompt },
      { role: "assistant" as const, content: s.response }],
    }))
    .addEdge("__start__", "preparePromptAndIntent")
    .addConditionalEdges("preparePromptAndIntent", (s) => s.intent, {
      semantic: "prepareSemanticBatch", procedural: "respondWithMemoryApi", task: "loadRelevantMemories",
    })
    .addConditionalEdges("prepareSemanticBatch", (s) => s.semanticBatch ? "review" : "done", {
      review: "checkSemanticToolScopeBatch", done: "composeSemanticOutcome",
    })
    .addEdge("checkSemanticToolScopeBatch", "searchSimilarSemanticBatch")
    .addEdge("searchSimilarSemanticBatch", "reviewSemanticBatch")
    .addConditionalEdges("reviewSemanticBatch", (s) => s.semanticBatch!.items.some((item) => !item.prepared) ? "edited" : batchReady(s.semanticBatch!) ? "ready" : "missing", {
      edited: "checkSemanticToolScopeBatch", ready: "applyApprovedSemanticBatch", missing: "reviewSemanticBatch",
    })
    .addEdge("applyApprovedSemanticBatch", "composeSemanticOutcome")
    .addEdge("composeSemanticOutcome", "finalizeResponse")
    .addEdge("respondWithMemoryApi", "finalizeResponse")
    .addEdge("loadRelevantMemories", "selectRelevantTools")
    .addEdge("selectRelevantTools", "agentModel")
    .addConditionalEdges("agentModel", (s) => s.toolCalls.length ? "calls" : "respond", {
      calls: "authorizeToolCalls", respond: "composeTaskResponse",
    })
    .addConditionalEdges("authorizeToolCalls", (s) => s.toolCalls.some((call) => tools.get(call.name, context(s)).effect === "write") ? "write" : "read", {
      write: "prepareWriteProposal", read: "executeRegisteredTools",
    })
    .addConditionalEdges("prepareWriteProposal", (s) => s.writeProposal ? "write" : "respond", {
      write: "reviewToolWrite", respond: "composeTaskResponse",
    })
    .addConditionalEdges("reviewToolWrite", (s) => s.writeDeclined ? "declined" : "approved", {
      declined: "agentModel", approved: "executeRegisteredTools",
    })
    .addEdge("executeRegisteredTools", "agentModel")
    .addEdge("composeTaskResponse", "recordEpisode")
    .addEdge("recordEpisode", "finalizeResponse")
    .addEdge("finalizeResponse", "__end__");
  // Each planning turn spans multiple nodes; allow the application limit to finish normally.
  return graph.compile({ checkpointer }).withConfig({ recursionLimit: 100 });
}
