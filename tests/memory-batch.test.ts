import { describe, expect, it } from "vitest";
import { applyApprovedMemoryBatch } from "../src/memory-batch.js";
import { applyReviewDecisions, createMemoryBatch, itemWriteId, refreshReview } from "../src/memory-review.js";
import { MemoryFixture } from "./helpers.js";

const context = { organizationId: "org-1", employeeId: "employee-1", userId: "user-1", sessionId: "session-1" };
function prepared(kind: "semantic" | "procedural" = "semantic") {
  const batch = createMemoryBatch(kind, ["Jazz", "Remote work"], context);
  batch.items.forEach((item) => { item.prepared = true; item.scope = { supported: true }; });
  refreshReview(batch);
  return applyReviewDecisions(batch, batch.reviewId, batch.items.map(({ candidateId, version }) => ({ candidateId, version, action: "create" })));
}

describe("approved memory batch execution", () => {
  it("returns per-candidate success/failure outcomes and continues after a failed write", async () => {
    const memory = new MemoryFixture();
    const save = memory.createSemantic.bind(memory);
    memory.createSemantic = async (ctx, text, id) => {
      if (text === "Jazz") throw new Error("database unavailable");
      return save(ctx, text, id);
    };
    const done = await applyApprovedMemoryBatch(memory, prepared());
    expect(done.completed).toBe(true);
    expect(done.outcomes.map((item) => item.status)).toEqual(["failed", "saved"]);
    expect(done.outcomes[1].memoryIds).toHaveLength(1);
    expect(memory.semantic.map((item) => item.text)).toEqual(["Remote work"]);
    expect(await applyApprovedMemoryBatch(memory, done)).toEqual(done);
  });

  it("replays a checkpoint without duplicating writes after the first result was not persisted", async () => {
    const memory = new MemoryFixture();
    const batch = prepared();
    await memory.createSemantic(context, batch.items[0].text, itemWriteId(batch, batch.items[0]));
    const done = await applyApprovedMemoryBatch(memory, batch);
    expect(done.outcomes.map((item) => item.status)).toEqual(["saved", "saved"]);
    expect(memory.semantic).toHaveLength(2);
  });

  it("resumes persisted Procedural progress after a failure to save the review state", async () => {
    const memory = new MemoryFixture();
    const batch = prepared("procedural");
    await expect(applyApprovedMemoryBatch(memory, batch, async () => { throw new Error("checkpoint unavailable"); }))
      .rejects.toThrow(/checkpoint/);
    expect(memory.procedural).toEqual(["Jazz"]);
    const done = await applyApprovedMemoryBatch(memory, batch);
    expect(done.outcomes.map((item) => item.status)).toEqual(["saved", "saved"]);
    expect(memory.procedural).toEqual(["Jazz", "Remote work"]);
  });

  it("skips completed update targets during retry validation", async () => {
    const memory = new MemoryFixture(); memory.semantic = [{ id: "old", text: "Original" }];
    const batch = prepared();
    batch.items[0].matches = await memory.searchSemantic(context, "Original");
    batch.items[0].decision = { action: "update", targetIds: ["old"] };
    let persisted = batch;
    await expect(applyApprovedMemoryBatch(memory, batch, async (progress) => {
      persisted = structuredClone(progress); throw new Error("connection lost");
    })).rejects.toThrow();
    await memory.updateSemantic(context, ["old"], "Newer change");
    const done = await applyApprovedMemoryBatch(memory, persisted);
    expect(done.outcomes.map((item) => item.status)).toEqual(["updated", "saved"]);
    expect(memory.semantic.find((item) => item.id === "old")?.text).toBe("Newer change");
  });
});
