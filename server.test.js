import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { RunnableLambda } from "@langchain/core/runnables";
import { createReportTools } from "./report-tools.js";
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

const reportsDir = path.join(tmpdir(), `dmas-test-${randomUUID()}`);
const reportTools = createReportTools({ outputDir: reportsDir });
const handler = createApiHandler(createCalculatorGraph(mockModel, { reportTools }));
after(async () => rm(reportsDir, { recursive: true, force: true }));

test("exports three report tools with descriptions and argument schemas", () => {
  assert.deepEqual(Object.keys(reportTools.definitions), ["display", "saveTextFile", "sendMail"]);
  for (const [name, definition] of Object.entries(reportTools.definitions)) {
    assert.ok(definition.description.length > 0);
    assert.ok(definition.args);
    assert.equal(reportTools.langChainTools[name].description, definition.description);
  }
});

async function query(body, selectedHandler = handler) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = "POST";
  request.url = "/query";
  const response = {
    writeHead(status) { this.status = status; },
    end(payload) { this.body = JSON.parse(payload); },
  };
  await selectedHandler(request, response);
  return { status: response.status, body: response.body };
}

function assertResponseWithDisplay(actual, expected) {
  const { display, ...body } = actual.body;
  assert.deepEqual({ status: actual.status, body }, expected);
  assert.match(display, /Prompt: /);
  assert.match(display, /Steps:\n/);
  assert.match(display, /Result: /);
}

test("query API handles operand order and addition", async () => {
  assertResponseWithDisplay(await query({ prompt: "subtract 3 from 10" }), {
    status: 200,
    body: {
      operation: "subtract", a: 10, b: 3, result: 7,
      steps: [{ a: 10, b: 3, operation: "subtract", result: 7 }],
      explanation: "First, 10 - 3 = 7. The final result is 7.",
    },
  });
  assertResponseWithDisplay(await query({ prompt: "5 + 7" }), {
    status: 200,
    body: {
      operation: "add", a: 5, b: 7, result: 12,
      steps: [{ a: 5, b: 7, operation: "add", result: 12 }],
      explanation: "First, 5 + 7 = 12. The final result is 12.",
    },
  });
});

test("query API handles multi-operation requests", async () => {
  assertResponseWithDisplay(await query({ prompt: "5 + 7 * 2" }), {
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
  assertResponseWithDisplay(await query({ prompt: "add 5 and 7, then multiply by 2" }), {
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

test("report actions run only when explicitly requested", async () => {
  await assert.rejects(() => readdir(reportsDir), { code: "ENOENT" });

  const saved = await query({ prompt: "5 + 7", saveTextFile: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.file.status, "saved");
  assert.equal(saved.body.email, undefined);
  assert.equal(await readFile(saved.body.file.path, "utf8"), saved.body.display);

  const emailed = await query({ prompt: "5 + 7", emailTo: "recipient@example.com" });
  assert.equal(emailed.status, 200);
  assert.deepEqual(emailed.body.email, {
    status: "disabled",
    draft: { to: "recipient@example.com", subject: "DMAS calculation result", text: emailed.body.display },
  });
  assert.equal(emailed.body.file, undefined);
  assert.equal((await readdir(reportsDir)).length, 1);
});

test("file and email actions can run together", async () => {
  const response = await query({
    prompt: "add 5 and 7, then multiply by 2",
    saveTextFile: true,
    emailTo: "recipient@example.com",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.file.status, "saved");
  assert.equal(response.body.email.status, "disabled");
  assert.equal(await readFile(response.body.file.path, "utf8"), response.body.display);
  assert.equal(response.body.email.draft.text, response.body.display);
});

test("invalid email is rejected and valid email is draft only", async () => {
  assert.equal((await query({ prompt: "5 + 7", emailTo: "invalid" })).status, 400);
  const draft = await reportTools.langChainTools.sendMail.invoke({
    report: {
      prompt: "5 + 7", expression: "5+7", result: 12,
      steps: [{ a: 5, b: 7, operation: "add", result: 12 }],
      explanation: "First, 5 + 7 = 12. The final result is 12.",
    },
    to: "recipient@example.com",
  });
  assert.equal(draft.status, "disabled");
  assert.match(draft.draft.text, /Result: 12/);
});

test("query API rejects invalid arithmetic", async () => {
  assert.equal((await query({ prompt: "8 / 0" })).status, 422);
  assert.equal((await query({ prompt: "8 / (3 - 3)" })).status, 422);
  assert.equal((await query({ prompt: "add 1, 2, and 3" })).status, 422);
  assert.equal((await query({ prompt: "5 + 8" })).status, 422);
  assert.equal((await query({ prompt: "hello" })).status, 422);
  assert.equal((await query({})).status, 400);
});
