import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { BedrockAssistantModel } from "../src/llm.js";

function assistant(content: string) {
  return new BedrockAssistantModel({
    invoke: async () => new AIMessageChunk({ content }),
  });
}

async function scope(output: Record<string, unknown>, text = "I prefer jazz") {
  return (await assistant(JSON.stringify({ results: [{ candidateId: "candidate-1", ...output }] }))
    .checkSemanticScopeBatch([{ candidateId: "candidate-1", text }], []))[0];
}

describe("Bedrock response parsing", () => {
  it("checks all candidate scopes in one call and keeps their IDs", async () => {
    let calls = 0;
    const model = new BedrockAssistantModel({ invoke: async () => {
      calls += 1;
      return new AIMessageChunk({ content: JSON.stringify({ results: [
        { candidateId: "a", supported: true }, { candidateId: "b", supported: false, limitation: "No matching tool" },
      ] }) });
    } });
    const result = await model.checkSemanticScopeBatch([{ candidateId: "a", text: "Jazz" }, { candidateId: "b", text: "Play music" }], []);
    expect(calls).toBe(1);
    expect(result.map((item) => item.candidateId)).toEqual(["a", "b"]);
  });

  it.each([
    [],
    [{ candidateId: "wrong", supported: true }],
    [{ candidateId: "candidate-1", supported: true }, { candidateId: "candidate-1", supported: true }],
  ].map((results) => ({ results })))("rejects missing, foreign or duplicate batch scope IDs: %j", async ({ results }) => {
    await expect(assistant(JSON.stringify({ results })).checkSemanticScopeBatch([{ candidateId: "candidate-1", text: "Jazz" }], []))
      .rejects.toMatchObject({ name: "ModelOutputError" });
  });

  it("returns a model error when extracted memory candidates exceed the batch limit", async () => {
    await expect(assistant(JSON.stringify({ candidates: Array(101).fill("fact") })).semanticCandidates("Remember facts"))
      .rejects.toMatchObject({ name: "ModelOutputError" });
  });
  it.each([
    { supported: true },
    { supported: true, limitation: null, eligiblePreference: null },
    { supported: true, limitation: null },
    { supported: true, eligiblePreference: null },
  ])("accepts absent or null optional scope fields: %j", async (output) => {
    const result = await scope(output);
    expect(result.supported).toBe(true);
    expect(result.limitation).toBeUndefined();
    expect(result.eligiblePreference).toBeUndefined();
  });

  it("preserves a real limitation when no separate preference was found", async () => {
    const result = await scope({
      supported: false, limitation: "No Spotify operation is registered", eligiblePreference: null,
    }, "Play music on Spotify");
    expect(result.supported).toBe(false);
    expect(result.limitation).toBe("No Spotify operation is registered");
    expect(result.eligiblePreference).toBeUndefined();
  });

  it("preserves a separate preference for the scope limitation review", async () => {
    const result = await scope({
      supported: false, limitation: "No Spotify tool", eligiblePreference: "I prefer jazz",
    }, "Play Spotify; I prefer jazz");
    expect(result).toEqual({ candidateId: "candidate-1", supported: false, limitation: "No Spotify tool", eligiblePreference: "I prefer jazz" });
  });

  it("accepts a null optional task response while keeping tool calls intact", async () => {
    const result = await assistant(JSON.stringify({
      response: null, calls: [{ id: "read-1", name: "server_time", args: {} }],
    })).planTask({ prompt: "What time is it?", sessionId: "session-1", semantic: [], procedural: [], episodic: [],
      results: [], tools: [], writeDeclined: false, history: [] });
    expect(result.response).toBeUndefined();
    expect(result.calls).toEqual([{ id: "read-1", name: "server_time", args: {} }]);
  });

  it.each([
    '{"results":[{"candidateId":"candidate-1","supported":true,"limitation":123}]}',
    '{"results":[{"candidateId":"candidate-1","supported":null}]}',
    'not JSON',
  ])("reports malformed model output as a model error: %s", async (output) => {
    await expect(assistant(output).checkSemanticScopeBatch([{ candidateId: "candidate-1", text: "I prefer jazz" }], []))
      .rejects.toMatchObject({ name: "ModelOutputError" });
  });
});
