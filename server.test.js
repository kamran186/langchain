import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { RunnableLambda } from "@langchain/core/runnables";
import { arithmeticTools, calculate, createApiHandler, createCalculatorGraph, evaluateExpression, langChainTools } from "./server.js";

test("exports four described, schema-validated LangChain tools", async () => {
  assert.deepEqual(Object.keys(arithmeticTools), ["add", "subtract", "multiply", "divide"]);
  for (const [name, definition] of Object.entries(arithmeticTools)) {
    assert.equal(typeof definition.description, "string");
    assert.ok(definition.description.length > 0);
    assert.equal(definition.args.safeParse({ a: 2, b: 3 }).success, true);
    assert.equal(definition.args.safeParse({ a: "2", b: 3 }).success, false);
    assert.equal(langChainTools[name].description, definition.description);
  }
  assert.equal(await langChainTools.add.invoke({ a: 2, b: 3 }), 5);
  assert.equal(await langChainTools.subtract.invoke({ a: 8, b: 3 }), 5);
  assert.equal(await langChainTools.multiply.invoke({ a: 2, b: 3 }), 6);
  assert.equal(await langChainTools.divide.invoke({ a: 8, b: 2 }), 4);
});

test("calculates all four operations", () => {
  assert.equal(calculate({ a: 12, b: 3, operation: "divide" }), 4);
  assert.equal(calculate({ a: 12, b: 3, operation: "multiply" }), 36);
  assert.equal(calculate({ a: 12, b: 3, operation: "add" }), 15);
  assert.equal(calculate({ a: 12, b: 3, operation: "subtract" }), 9);
  assert.throws(() => calculate({ a: 12, b: 0, operation: "divide" }), /Division by zero/);
});

test("calculates multiple operations with precedence and parentheses", async () => {
  assert.deepEqual((await evaluateExpression("5+7*2")).steps, [
    { a: 7, b: 2, operation: "multiply", result: 14 },
    { a: 5, b: 14, operation: "add", result: 19 },
  ]);
  assert.equal((await evaluateExpression("5+7*2")).result, 19);
  assert.equal((await evaluateExpression("(5+7)*2")).result, 24);
  assert.equal((await evaluateExpression("20/2-3")).result, 7);
  assert.equal((await evaluateExpression("-3+5")).result, 2);
  assert.deepEqual((await evaluateExpression("-(5+7)")).steps, [
    { a: 5, b: 7, operation: "add", result: 12 },
    { operation: "negate", a: 12, result: -12 },
  ]);
  await assert.rejects(() => evaluateExpression("8/(3-3)"), /Division by zero/);
  await assert.rejects(() => evaluateExpression("5**2"), /valid arithmetic/);
});

const mockModel = RunnableLambda.from(async (messages) => {
  const prompt = messages.messages.at(-1).content;
  if (prompt.includes("subtract 3 from 10")) {
    return { content: '{"expression":"10-3"}' };
  }
  if (prompt.includes("8 / 0")) {
    return { content: '{"expression":"8/0"}' };
  }
  if (prompt.includes("5 + 7 * 2")) {
    return { content: '{"expression":"5+7*2"}' };
  }
  if (prompt.includes("add 5 and 7, then multiply by 2")) {
    return { content: '{"expression":"(5+7)*2"}' };
  }
  if (prompt.includes("8 / (3 - 3)")) {
    return { content: '{"expression":"8/(3-3)"}' };
  }
  if (prompt.includes("5 + 7")) {
    return { content: '{"expression":"5+7"}' };
  }
  if (prompt.includes("5 + 8")) {
    return { content: '{"expression":"5+7"}' };
  }
  return { content: '{"error":"unsupported"}' };
});

const handler = createApiHandler(createCalculatorGraph(mockModel));

async function query(body) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = "POST";
  request.url = "/query";
  const response = {
    writeHead(status) { this.status = status; },
    end(payload) { this.body = JSON.parse(payload); },
  };
  await handler(request, response);
  return { status: response.status, body: response.body };
}

test("query API handles operand order and addition", async () => {
  assert.deepEqual(await query({ prompt: "subtract 3 from 10" }), {
    status: 200,
    body: {
      operation: "subtract", a: 10, b: 3, result: 7,
      steps: [{ a: 10, b: 3, operation: "subtract", result: 7 }],
      explanation: "First, 10 - 3 = 7. The final result is 7.",
    },
  });
  assert.deepEqual(await query({ prompt: "5 + 7" }), {
    status: 200,
    body: {
      operation: "add", a: 5, b: 7, result: 12,
      steps: [{ a: 5, b: 7, operation: "add", result: 12 }],
      explanation: "First, 5 + 7 = 12. The final result is 12.",
    },
  });
});

test("query API handles multi-operation requests", async () => {
  assert.deepEqual(await query({ prompt: "5 + 7 * 2" }), {
    status: 200,
    body: {
      expression: "5+7*2", result: 19,
      steps: [
        { a: 7, b: 2, operation: "multiply", result: 14 },
        { a: 5, b: 14, operation: "add", result: 19 },
      ],
      explanation: "First, 7 * 2 = 14. Then, 5 + 14 = 19. The final result is 19.",
    },
  });
  assert.deepEqual(await query({ prompt: "add 5 and 7, then multiply by 2" }), {
    status: 200,
    body: {
      expression: "(5+7)*2", result: 24,
      steps: [
        { a: 5, b: 7, operation: "add", result: 12 },
        { a: 12, b: 2, operation: "multiply", result: 24 },
      ],
      explanation: "First, 5 + 7 = 12. Then, 12 * 2 = 24. The final result is 24.",
    },
  });
});

test("query API rejects invalid arithmetic", async () => {
  assert.equal((await query({ prompt: "8 / 0" })).status, 422);
  assert.equal((await query({ prompt: "8 / (3 - 3)" })).status, 422);
  assert.equal((await query({ prompt: "add 1, 2, and 3" })).status, 422);
  assert.equal((await query({ prompt: "5 + 8" })).status, 422);
  assert.equal((await query({ prompt: "hello" })).status, 422);
  assert.equal((await query({})).status, 400);
});
