import type { MemoryPort } from "./memory.js";
import type { SessionContext } from "./context.js";
import { batchReady, itemWriteId, ReviewError, type MemoryBatch, type MemoryOutcome } from "./memory-review.js";

/** Check all approved update targets before any batch write is dispatched. */
export async function assertSemanticTargets(memory: MemoryPort, batch: MemoryBatch): Promise<void> {
  if (batch.kind !== "semantic") return;
  const updates = batch.items.filter((item) => item.decision?.action === "update" &&
    !batch.outcomes.some((outcome) => outcome.candidateId === item.candidateId));
  const ids = updates.flatMap((item) => item.decision!.targetIds);
  if (!ids.length) return;
  const current = await memory.getSemantic(batch.context as SessionContext, ids);
  for (const item of updates) {
    for (const id of item.decision!.targetIds) {
      const row = current.find((value) => value.id === id), expected = item.matches.find((value) => value.id === id);
      if (row?.writeId === itemWriteId(batch, item) && row.text === item.text) continue;
      if (!row || !expected || (expected.version ? expected.version !== row.version : expected.text !== row.text)) {
        throw new ReviewError("Semantic Memory changed since review; edit the affected candidate to refresh its matches", 409);
      }
    }
  }
}

export async function applyApprovedMemoryBatch(
  memory: MemoryPort,
  input: MemoryBatch,
  persist?: (batch: MemoryBatch) => Promise<void>,
): Promise<MemoryBatch> {
  if (!batchReady(input)) throw new ReviewError("Every candidate needs a decision before writing", 409);
  const batch = structuredClone(input);
  if (batch.completed) return batch;
  await assertSemanticTargets(memory, batch);
  for (const item of batch.items) {
    if (batch.outcomes.some((outcome) => outcome.candidateId === item.candidateId)) continue;
    const decision = item.decision!;
    let outcome: MemoryOutcome;
    try {
      let memoryIds: string[] = [];
      if (decision.action === "create") {
        const record = batch.kind === "semantic"
          ? await memory.createSemantic(batch.context as SessionContext, item.text, itemWriteId(batch, item))
          : await memory.saveProcedural(batch.context, item.text, itemWriteId(batch, item));
        memoryIds = [record.id];
      } else if (decision.action === "update") {
        memoryIds = (await memory.updateSemantic(batch.context as SessionContext, decision.targetIds, item.text,
          itemWriteId(batch, item), item.matches)).map((record) => record.id);
      }
      outcome = { candidateId: item.candidateId, version: item.version, text: item.text, action: decision.action,
        status: decision.action === "create" ? "saved" : decision.action === "update" ? "updated" : "skipped", memoryIds };
    } catch {
      outcome = { candidateId: item.candidateId, version: item.version, text: item.text, action: decision.action,
        status: "failed", memoryIds: [], error: "Memory write could not be completed; inspect this item before starting another proposal." };
    }
    batch.outcomes.push(outcome);
    if (persist) await persist(batch);
  }
  batch.completed = true;
  if (persist) await persist(batch);
  return batch;
}
