import { createHash } from "node:crypto";
import { z } from "zod";

export const RequestContextSchema = z.object({
  organizationId: z.string().trim().min(1).max(128),
  employeeId: z.string().trim().min(1).max(128),
  threadId: z.string().trim().min(1).max(128),
}).strict();

export type RequestContext = z.infer<typeof RequestContextSchema>;

export const FactSchema = z.object({
  subject: z.string().trim().min(1).max(128),
  key: z.string().trim().min(1).max(128),
  value: z.union([
    z.string().max(2000),
    z.number(),
    z.boolean(),
    z.null(),
  ]),
  evidence: z.string().min(1).max(8000),
}).strict();

export type Fact = z.infer<typeof FactSchema>;

export const IntentSchema = z.enum([
  "semantic_memory",
  "read",
  "question",
  "mixed",
  "write",
  "approval",
  "clarification",
  "unclear",
]);

export const InterpretationSchema = z.object({
  polishedPrompt: z.string().trim().min(1).max(16000),
  intent: IntentSchema,
  facts: z.array(FactSchema).max(30),
  recallSubjects: z.array(z.string().min(1).max(128)).max(20),
  episodeIds: z.array(z.string().min(1).max(128)).max(3),
  taskPrompt: z.string().trim().min(1).max(16000).nullable(),
  clarificationQuestion: z.string().trim().min(1).max(2000).nullable(),
}).strict();

export function sessionKey(context: RequestContext): string {
  return createHash("sha256")
    .update(JSON.stringify([
      context.organizationId,
      context.employeeId,
      context.threadId,
    ]))
    .digest("hex");
}

export function mergeFacts(existing: Fact[], incoming: Fact[]): Fact[] {
  const identity = (fact: Fact) =>
    JSON.stringify([fact.subject, fact.key]);

  const result = new Map(
    existing.map((fact) => [identity(fact), fact]),
  );

  for (const fact of incoming) {
    result.set(identity(fact), fact);
  }

  return [...result.values()];
}

export function parseInterpretation(text: string, originalPrompt: string) {
  const json = text.trim().replace(
    /^```(?:json)?\s*([\s\S]*?)\s*```$/i,
    "$1",
  );

  const result = InterpretationSchema.parse(JSON.parse(json));
  const savesMemory = ["semantic_memory", "mixed"].includes(result.intent);
  const hasTask = ["read", "question", "mixed"].includes(result.intent);

  if (savesMemory !== (result.facts.length > 0)) {
    throw new Error("Facts must accompany a memory or mixed request.");
  }

  if (hasTask && !result.taskPrompt) {
    throw new Error("A task requires taskPrompt.");
  }

  if (result.intent === "semantic_memory" && result.taskPrompt !== null) {
    throw new Error("A memory-only request cannot contain a task.");
  }

  if (result.intent === "unclear" && !result.clarificationQuestion) {
    throw new Error("An unclear request requires a clarification question.");
  }

  if (result.intent !== "unclear" && result.clarificationQuestion !== null) {
    throw new Error("Clarification must be resolved before execution.");
  }

  for (const fact of result.facts) {
    if (!originalPrompt.includes(fact.evidence)) {
      throw new Error("Fact evidence must quote the current user message.");
    }
  }

  return result;
}