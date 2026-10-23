import { tool } from "@langchain/core/tools";
import { z } from "zod";

const operands = z.object({
  a: z.number().describe("First operand"),
  b: z.number().describe("Second operand"),
});

export const add = tool(({ a, b }) => String(a + b), {
  name: "add",
  description: "Add two numbers.",
  schema: operands,
});

export const multiply = tool(({ a, b }) => String(a * b), {
  name: "multiply",
  description: "Multiply two numbers.",
  schema: operands,
});

export const divide = tool(
  ({ a, b }) =>
    b === 0 ? "Error: division by zero is undefined." : String(a / b),
  {
    name: "divide",
    description: "Divide the first number by the second number.",
    schema: operands,
  },
);