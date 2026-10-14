import { StateGraph, START, END, StateSchema } from "@langchain/langgraph";
import * as z from "zod";
import { evaluateExpression, explainSteps, matchesPromptNumbers, tokenizeExpression } from "./calculator.js";
import { RequestError } from "./errors.js";
import { createInterpreter } from "./model.js";
import { createReportTools } from "./tools/report.js";

const stepSchema = z.object({
  operation: z.enum(["divide", "multiply", "add", "subtract", "negate"]),
  a: z.number(),
  b: z.number().optional(),
  result: z.number(),
});

const calculatorState = new StateSchema({
  prompt: z.string(),
  saveTextFile: z.boolean().optional(),
  emailTo: z.string().optional(),
  expression: z.string().optional(),
  operation: z.object({ a: z.number(), b: z.number(), operation: z.string() }).optional(),
  result: z.number().optional(),
  steps: z.array(stepSchema).optional(),
  explanation: z.string().optional(),
  displayText: z.string().optional(),
  savedFile: z.string().optional(),
  saveError: z.string().optional(),
  emailDraft: z.object({
    status: z.literal("disabled"),
    draft: z.object({ to: z.string(), subject: z.string(), text: z.string() }),
  }).optional(),
});

function reportFromState({ prompt, expression, steps, result, explanation }) {
  return { prompt, expression, steps, result, explanation };
}

export function createCalculatorGraph(model, { reportTools = createReportTools() } = {}) {
  const interpret = createInterpreter(model);
  return new StateGraph(calculatorState)
    .addNode("interpret", async ({ prompt }) => {
      const expression = await interpret(prompt);
      if (!matchesPromptNumbers(prompt, tokenizeExpression(expression))) {
        throw new RequestError("Could not match the numbers in the prompt.");
      }
      return { expression };
    })
    .addNode("calculate", ({ expression }) => evaluateExpression(expression))
    .addNode("explain", ({ steps, result }) => ({ explanation: explainSteps({ steps, result }) }))
    .addNode("display", async (state) => ({
      displayText: await reportTools.langChainTools.display.invoke({ report: reportFromState(state) }),
    }))
    .addNode("saveReport", async (state) => {
      try {
        const savedFile = await reportTools.langChainTools.saveTextFile.invoke({ report: reportFromState(state) });
        return { savedFile };
      } catch {
        return { saveError: "Could not save the report text file." };
      }
    })
    .addNode("sendMail", async (state) => ({
      emailDraft: await reportTools.langChainTools.sendMail.invoke({ report: reportFromState(state), to: state.emailTo }),
    }))
    .addEdge(START, "interpret")
    .addEdge("interpret", "calculate")
    .addEdge("calculate", "explain")
    .addEdge("explain", "display")
    .addConditionalEdges("display", ({ saveTextFile, emailTo }) =>
      saveTextFile ? "saveReport" : emailTo ? "sendMail" : END,
    ["saveReport", "sendMail", END])
    .addConditionalEdges("saveReport", ({ emailTo }) => emailTo ? "sendMail" : END,
      ["sendMail", END])
    .addEdge("sendMail", END)
    .compile();
}
