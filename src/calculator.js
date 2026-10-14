import { RequestError } from "./errors.js";
import { langChainTools } from "./tools/arithmetic.js";

const SYMBOL_TO_OPERATION = Object.freeze({
  "+": "add",
  "-": "subtract",
  "*": "multiply",
  "/": "divide",
});
const OPERATION_TO_SYMBOL = Object.freeze({
  add: "+",
  subtract: "-",
  multiply: "*",
  divide: "/",
});

export function numericValues(prompt) {
  return (prompt.match(/(?<![\w.])(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?![\w.])/gi) || [])
    .map(Number);
}

export function tokenizeExpression(expression) {
  if (expression.length > 512) throw new RequestError("Expression is too long.");
  const tokens = [];

  for (let index = 0; index < expression.length;) {
    if (/\s/.test(expression[index])) {
      index += 1;
      continue;
    }
    const match = expression.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|^[()+*/-]/i);
    if (!match) throw new RequestError("Expression contains an unsupported character.");

    const value = match[0];
    tokens.push(/[()+*/-]/.test(value[0]) ? { type: value } : { type: "number", value: Number(value) });
    if (tokens.length > 128) throw new RequestError("Expression has too many terms.");
    index += value.length;
  }

  if (tokens.some((token) => token.type === "number" && !Number.isFinite(token.value))) {
    throw new RequestError("A number is outside the supported range.");
  }
  return tokens;
}

export function matchesPromptNumbers(prompt, tokens) {
  const input = numericValues(prompt).map(Math.abs).sort((a, b) => a - b);
  const output = tokens.filter((token) => token.type === "number")
    .map((token) => Math.abs(token.value)).sort((a, b) => a - b);
  return input.length >= 2 && input.length === output.length
    && input.every((value, index) => value === output[index]);
}

export async function evaluateExpression(expression) {
  const tokens = tokenizeExpression(expression);
  const steps = [];
  let position = 0;
  let operationCount = 0;
  const peek = () => tokens[position]?.type;

  async function combine(left, right, symbol) {
    const operation = SYMBOL_TO_OPERATION[symbol];
    const operands = { a: left.value, b: right.value, operation };
    const result = await langChainTools[operation].invoke({ a: operands.a, b: operands.b });
    operationCount += 1;
    steps.push({ ...operands, result });
    return {
      value: result,
      literal: false,
      operation: left.literal && right.literal ? operands : undefined,
    };
  }

  async function parsePrimary(depth) {
    if (depth > 32) throw new RequestError("Expression has too many nested terms.");
    if (peek() === "number") return { value: tokens[position++].value, literal: true };
    if (peek() === "(") {
      position += 1;
      const value = await parseSum(depth + 1);
      if (peek() !== ")") throw new RequestError("Expression has unmatched parentheses.");
      position += 1;
      return value;
    }
    throw new RequestError("Expression is not valid arithmetic.");
  }

  async function parseUnary(depth) {
    if (depth > 32) throw new RequestError("Expression has too many nested terms.");
    if (peek() !== "+" && peek() !== "-") return parsePrimary(depth);

    const symbol = tokens[position++].type;
    const term = await parseUnary(depth + 1);
    const value = symbol === "-" ? -term.value : term.value;
    if (symbol === "-" && !term.literal) {
      steps.push({ operation: "negate", a: term.value, result: value });
    }
    return { value, literal: term.literal };
  }

  async function parseProduct(depth) {
    let left = await parseUnary(depth);
    while (peek() === "*" || peek() === "/") {
      const symbol = tokens[position++].type;
      left = await combine(left, await parseUnary(depth), symbol);
    }
    return left;
  }

  async function parseSum(depth) {
    let left = await parseProduct(depth);
    while (peek() === "+" || peek() === "-") {
      const symbol = tokens[position++].type;
      left = await combine(left, await parseProduct(depth), symbol);
    }
    return left;
  }

  const parsed = await parseSum(0);
  if (position !== tokens.length || operationCount === 0) {
    throw new RequestError("Expression is not valid arithmetic.");
  }
  return { result: parsed.value, steps, operation: operationCount === 1 ? parsed.operation : undefined };
}

export function explainSteps({ steps, result }) {
  const sentences = steps.map((step, index) => {
    const lead = index === 0 ? "First" : "Then";
    return step.operation === "negate"
      ? `${lead}, negate ${step.a} to get ${step.result}.`
      : `${lead}, ${step.a} ${OPERATION_TO_SYMBOL[step.operation]} ${step.b} = ${step.result}.`;
  });
  return `${sentences.join(" ")} The final result is ${result}.`;
}
