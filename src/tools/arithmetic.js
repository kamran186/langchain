import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { RequestError } from "../errors.js";

export const arithmeticTools = Object.freeze({
  add: {
    description: "Add two numbers and return their sum.",
    args: z.object({
      a: z.number().finite().describe("First number"),
      b: z.number().finite().describe("Second number"),
    }),
    execute: ({ a, b }) => a + b,
  },
  subtract: {
    description: "Subtract b from a and return the difference.",
    args: z.object({
      a: z.number().finite().describe("Number to subtract from"),
      b: z.number().finite().describe("Number to subtract"),
    }),
    execute: ({ a, b }) => a - b,
  },
  multiply: {
    description: "Multiply two numbers and return their product.",
    args: z.object({
      a: z.number().finite().describe("First factor"),
      b: z.number().finite().describe("Second factor"),
    }),
    execute: ({ a, b }) => a * b,
  },
  divide: {
    description: "Divide a by b and return the quotient. b must not be zero.",
    args: z.object({
      a: z.number().finite().describe("Dividend"),
      b: z.number().finite().describe("Nonzero divisor"),
    }),
    execute: ({ a, b }) => {
      if (b === 0) throw new RequestError("Division by zero is undefined.");
      return a / b;
    },
  },
});

export function calculate({ a, b, operation }) {
  if (!Object.hasOwn(arithmeticTools, operation)) {
    throw new RequestError("Unsupported arithmetic operation.");
  }
  const definition = arithmeticTools[operation];
  const args = definition.args.safeParse({ a, b });
  if (!args.success) throw new RequestError("Both operands must be finite numbers.");

  const result = definition.execute(args.data);
  if (!Number.isFinite(result)) {
    throw new RequestError("The result is outside the supported number range.");
  }
  return result;
}

export const langChainTools = Object.freeze(Object.fromEntries(
  Object.entries(arithmeticTools).map(([name, definition]) => [
    name,
    tool((args) => calculate({ ...args, operation: name }), {
      name,
      description: definition.description,
      schema: definition.args,
    }),
  ]),
));
