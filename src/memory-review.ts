import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { RequestContext } from "./context.js";
import type { SemanticMatch } from "./semantic.js";

export type MemoryScope = { supported: boolean; limitation?: string; eligiblePreference?: string };
export type StoredDecision = { action: "create" | "update" | "skip"; targetIds: string[] };
export type MemoryReviewItem = {
  candidateId: string;
  version: number;
  text: string;
  matches: SemanticMatch[];
  prepared: boolean;
  scope?: MemoryScope;
  error?: string;
  decision?: StoredDecision;
};
export type MemoryOutcome = {
  candidateId: string;
  version: number;
  text: string;
  action: StoredDecision["action"];
  status: "saved" | "updated" | "skipped" | "failed";
  memoryIds: string[];
  error?: string;
};
export type MemoryBatch = {
  batchId: string;
  kind: "semantic" | "procedural";
  context: RequestContext & { sessionId?: string; threadId?: string };
  revision: number;
  reviewId: string;
  items: MemoryReviewItem[];
  outcomes: MemoryOutcome[];
  completed: boolean;
  legacyText?: string;
};

export const memoryDecisionSchema = z.object({
  candidateId: z.string().min(1),
  version: z.number().int().positive(),
  action: z.enum(["create", "update", "skip", "edit", "preference", "approve", "deny", "decline"])
    .transform((action) => action === "approve" ? "create" as const : action === "deny" || action === "decline" ? "skip" as const : action),
  targetIds: z.array(z.string().min(1)).max(100).optional(),
  text: z.string().trim().min(1).max(20_000).optional(),
}).strict();
export const memoryDecisionsSchema = z.array(memoryDecisionSchema).min(1).max(100);

export class ReviewError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "ReviewError"; }
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createMemoryBatch(kind: MemoryBatch["kind"], texts: string[], context: MemoryBatch["context"]): MemoryBatch {
  const values = z.array(z.string().trim().min(1).max(20_000)).min(1).max(100).parse(texts);
  return refreshReview({
    batchId: randomUUID(), kind, context: structuredClone(context), revision: 1, reviewId: "",
    completed: false, outcomes: [],
    items: values.map((text) => ({ candidateId: randomUUID(), version: 1, text, matches: [],
      prepared: kind === "procedural", ...(kind === "procedural" ? { scope: { supported: true } } : {}) })),
  });
}

export function refreshReview(batch: MemoryBatch): MemoryBatch {
  batch.reviewId = fingerprint([batch.batchId, batch.kind, batch.context, batch.revision,
    batch.items.map(({ candidateId, version, text, matches, scope, error }) => ({ candidateId, version, text, matches, scope, error }))]);
  return batch;
}

function allowedActions(batch: MemoryBatch, item: Pick<MemoryReviewItem, "scope" | "error" | "matches">): string[] {
  if (batch.kind === "procedural") return ["approve", "skip", "edit"];
  if (item.error || !item.scope?.supported) {
    return ["skip", "edit", ...(!item.error && item.scope?.eligiblePreference?.trim() ? ["preference"] : [])];
  }
  return ["create", ...(item.matches.length ? ["update"] : []), "skip", "edit"];
}

export function reviewPayload(batch: MemoryBatch) {
  return {
    type: `${batch.kind}_batch`, batchId: batch.batchId, reviewId: batch.reviewId,
    items: batch.items.map(({ prepared: _prepared, ...item }) => ({ ...item, allowedActions: allowedActions(batch, item) })),
  };
}

export function batchReady(batch: MemoryBatch): boolean {
  return batch.items.length > 0 && batch.items.every((item) => item.prepared && item.decision !== undefined);
}

/** Validate the entire submission before changing even an in-memory decision. */
export function applyReviewDecisions(batch: MemoryBatch, reviewId: string | undefined, input: unknown): MemoryBatch {
  if (reviewId !== batch.reviewId) throw new ReviewError("Memory review has changed; use the latest reviewId", 409);
  const parsed = memoryDecisionsSchema.safeParse(input);
  if (!parsed.success) throw new ReviewError("Invalid memory decisions");
  const result = structuredClone(batch);
  const seen = new Set<string>();
  let changedText = false;
  let changedDecisions = false;
  for (const answer of parsed.data) {
    if (seen.has(answer.candidateId)) throw new ReviewError("Duplicate candidateId");
    seen.add(answer.candidateId);
    const item = result.items.find((value) => value.candidateId === answer.candidateId);
    if (!item) throw new ReviewError("Unknown candidateId");
    if (answer.version !== item.version) throw new ReviewError("Candidate version has changed", 409);
    if (!item.prepared) throw new ReviewError("Candidate is not ready for review", 409);
    const { action } = answer;
    if (answer.text !== undefined && action !== "edit") throw new ReviewError("Use edit to change the proposed text");
    if (answer.targetIds !== undefined && action !== "update") throw new ReviewError("Only update accepts targetIds");
    if (batch.outcomes.length || batch.completed) {
      if (action === "edit" || action === "preference" || !item.decision ||
        fingerprint(item.decision) !== fingerprint({ action, targetIds: [...(answer.targetIds ?? [])].sort() })) {
        throw new ReviewError("Batch execution has started; decisions cannot be changed", 409);
      }
      continue;
    }
    if (action === "edit" || action === "preference") {
      const text = action === "edit" ? answer.text : item.error ? undefined : item.scope?.eligiblePreference?.trim();
      if (!text) throw new ReviewError(action === "edit" ? "Edited text is required" : "No eligible preference is available");
      item.text = text;
      item.version += 1;
      item.prepared = batch.kind === "procedural";
      item.matches = [];
      delete item.decision; delete item.error;
      if (batch.kind === "semantic") delete item.scope;
      changedText = true;
      continue;
    }
    if (action !== "skip" && (item.error || !item.scope?.supported)) throw new ReviewError("Unsupported candidate cannot be approved");
    if (action === "update") {
      if (batch.kind !== "semantic" || !answer.targetIds?.length) throw new ReviewError("Update requires selected matching memory IDs");
      const targets = new Set(answer.targetIds);
      if (targets.size !== answer.targetIds.length || answer.targetIds.some((id) => !item.matches.some((match) => match.id === id))) {
        throw new ReviewError("Invalid or duplicate update target");
      }
    }
    const decision = { action, targetIds: [...(answer.targetIds ?? [])].sort() };
    if (!item.decision || fingerprint(item.decision) !== fingerprint(decision)) changedDecisions = true;
    item.decision = decision;
  }
  const targets = new Set<string>();
  for (const item of result.items) {
    for (const id of item.decision?.targetIds ?? []) {
      if (targets.has(id)) throw new ReviewError("Conflicting updates target the same memory ID", 409);
      targets.add(id);
    }
  }
  // A partial review is a new snapshot; a final approval keeps its token for safe retries.
  if (changedText || (changedDecisions && !batchReady(result))) { result.revision += 1; refreshReview(result); }
  return result;
}

export function itemWriteId(batch: MemoryBatch, item: MemoryReviewItem): string {
  return fingerprint([batch.batchId, item.candidateId, item.version]);
}

export function describeMemoryOutcomes(batch: MemoryBatch): string {
  return batch.outcomes.map((item) => `${item.status === "saved" ? "Saved" : item.status === "updated" ? "Updated" : item.status === "skipped" ? "Skipped" : "Failed"} ${batch.kind === "semantic" ? "Semantic" : "Procedural"} Memory: ${item.text}${item.error ? ` (${item.error})` : ""}`).join("\n");
}
