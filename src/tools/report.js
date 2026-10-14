import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { RequestError } from "../errors.js";

const stepSchema = z.object({
  operation: z.enum(["add", "subtract", "multiply", "divide", "negate"]),
  a: z.number().finite(),
  b: z.number().finite().optional(),
  result: z.number().finite(),
});

export const reportSchema = z.object({
  prompt: z.string().min(1),
  expression: z.string().min(1),
  steps: z.array(stepSchema).min(1),
  result: z.number().finite(),
  explanation: z.string().min(1),
});

export function formatReport(report) {
  const { prompt, expression, steps, result, explanation } = reportSchema.parse(report);
  const symbols = { add: "+", subtract: "-", multiply: "*", divide: "/" };
  const lines = steps.map((step, index) => {
    const calculation = step.operation === "negate"
      ? `negate ${step.a} = ${step.result}`
      : `${step.a} ${symbols[step.operation]} ${step.b} = ${step.result}`;
    return `${index + 1}. ${calculation}`;
  });
  return [
    `Prompt: ${prompt}`,
    `Expression: ${expression}`,
    "Steps:",
    ...lines,
    `Result: ${result}`,
    `Explanation: ${explanation}`,
  ].join("\n") + "\n";
}

export function createReportTools({ outputDir = path.resolve("reports") } = {}) {
  const reportsDirectory = path.resolve(outputDir);
  const definitions = Object.freeze({
    display: {
      description: "Display the prompt, calculation steps, and result as text.",
      args: z.object({ report: reportSchema }),
      execute: async ({ report }) => formatReport(report),
    },
    saveTextFile: {
      description: "Save the prompt, steps, and result to a text file when requested.",
      args: z.object({ report: reportSchema }),
      execute: async ({ report }) => {
        const filePath = path.join(reportsDirectory, `dmas-${Date.now()}-${randomUUID()}.txt`);
        try {
          await mkdir(reportsDirectory, { recursive: true, mode: 0o700 });
          await writeFile(filePath, formatReport(report), { encoding: "utf8", flag: "wx", mode: 0o600 });
          return filePath;
        } catch {
          throw new RequestError("Could not save the report text file.", 500);
        }
      },
    },
    sendMail: {
      description: "Prepare an email draft when requested. Delivery is disabled.",
      args: z.object({ report: reportSchema, to: z.email() }),
      execute: async ({ report, to }) => ({
        status: "disabled",
        draft: { to, subject: "DMAS calculation result", text: formatReport(report) },
      }),
    },
  });
  const langChainTools = Object.freeze(Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      tool(definition.execute, { name, description: definition.description, schema: definition.args }),
    ]),
  ));
  return { definitions, langChainTools };
}
