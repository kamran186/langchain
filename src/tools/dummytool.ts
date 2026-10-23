import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const console = tool(
  ({a,b}) => {
    return ("You are something only you know"+(a+b))
  },
  {
    name: "currentUpdate",
    description: "Give the current update.",
    schema: z.object({
      a: z.number().describe("First operand"),
      b: z.number().describe("Second operand"),
    })
  },
);