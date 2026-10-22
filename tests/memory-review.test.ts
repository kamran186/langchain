import { describe, expect, it } from "vitest";
import { applyReviewDecisions, batchReady, createMemoryBatch, refreshReview, reviewPayload } from "../src/memory-review.js";

const context = { organizationId: "org", employeeId: "e", userId: "u", sessionId: "s", threadId: "t" };
function batch(texts = ["Jazz", "Remote work"]) {
  const value = createMemoryBatch("semantic", texts, context);
  value.items.forEach((item) => { item.scope = { supported: true }; item.prepared = true; });
  return refreshReview(value);
}
function decision(value: ReturnType<typeof batch>, index: number, action = "create", extra = {}) {
  return { candidateId: value.items[index].candidateId, version: value.items[index].version, action, ...extra };
}

describe("versioned memory batch review", () => {
  it("shows every candidate in one combined review", () => {
    const value = batch();
    const review = reviewPayload(value);
    expect(review.type).toBe("semantic_batch");
    expect(review.items).toHaveLength(2);
    expect(new Set(review.items.map((item) => item.candidateId)).size).toBe(2);
    expect(batchReady(value)).toBe(false);
  });

  it("preserves unchanged approvals and stable IDs when one item is edited", () => {
    const value = batch();
    const edited = applyReviewDecisions(value, value.reviewId, [decision(value, 0), decision(value, 1, "edit", { text: "Hybrid work" })]);
    expect(edited.items[0].decision?.action).toBe("create");
    expect(edited.items[0].version).toBe(1);
    expect(edited.items[1]).toMatchObject({ candidateId: value.items[1].candidateId, text: "Hybrid work", version: 2, prepared: false });
    expect(edited.items[1].decision).toBeUndefined();
    expect(edited.reviewId).not.toBe(value.reviewId);
    expect(value.items[1].text).toBe("Remote work");
  });

  it("collects missing decisions without declaring the batch ready", () => {
    const value = batch();
    const partial = applyReviewDecisions(value, value.reviewId, [decision(value, 0)]);
    expect(batchReady(partial)).toBe(false);
    const complete = applyReviewDecisions(partial, partial.reviewId, [decision(partial, 1, "skip")]);
    expect(batchReady(complete)).toBe(true);
  });

  it.each(["unknown", "duplicate", "stale-version", "stale-review", "invalid-target", "conflicting-target"])("rejects %s before changing decisions", (kind) => {
    const value = batch();
    value.items.forEach((item) => item.matches = [{ id: "old", text: "Original" }]);
    refreshReview(value);
    let decisions = [decision(value, 0)];
    let reviewId = value.reviewId;
    if (kind === "unknown") decisions = [{ ...decision(value, 0), candidateId: "unknown" }];
    if (kind === "duplicate") decisions.push(decision(value, 0));
    if (kind === "stale-version") decisions = [{ ...decision(value, 0), version: 9 }];
    if (kind === "stale-review") reviewId = "old-review";
    if (kind === "invalid-target") decisions = [decision(value, 0, "update", { targetIds: ["elsewhere"] })];
    if (kind === "conflicting-target") decisions = [decision(value, 0, "update", { targetIds: ["old"] }), decision(value, 1, "update", { targetIds: ["old"] })];
    expect(() => applyReviewDecisions(value, reviewId, decisions)).toThrow();
    expect(value.items.every((item) => !item.decision)).toBe(true);
  });

  it("does not allow an unsupported operation to be saved as a fact", () => {
    const value = batch(["Play music on Spotify"]);
    value.items[0].scope = { supported: false, limitation: "No Spotify tool", eligiblePreference: "I like jazz" };
    refreshReview(value);
    expect(() => applyReviewDecisions(value, value.reviewId, [decision(value, 0)])).toThrow(/unsupported/i);
    const preference = applyReviewDecisions(value, value.reviewId, [decision(value, 0, "preference")]);
    expect(preference.items[0]).toMatchObject({ text: "I like jazz", version: 2, prepared: false });
    expect(batchReady(preference)).toBe(false);
  });

  it("rejects replacement text hidden inside a create approval", () => {
    const value = batch();
    expect(() => applyReviewDecisions(value, value.reviewId, [decision(value, 0, "create", { text: "Different fact" })])).toThrow();
  });

  it("changes reviewId when a partial decision changes so stale approvals cannot overwrite it", () => {
    const value = batch();
    const first = applyReviewDecisions(value, value.reviewId, [decision(value, 0)]);
    expect(first.reviewId).not.toBe(value.reviewId);
    expect(() => applyReviewDecisions(first, value.reviewId, [decision(value, 0, "skip")])).toThrow(/review.*changed/i);
  });
});
