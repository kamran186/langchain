import {
  MessagesValue,
  ReducedValue,
  StateSchema,
} from "@langchain/langgraph";

import { z } from "zod";

import {
  FactSchema,
  IntentSchema,
  RequestContextSchema,
  mergeFacts,
} from "./interpretation.js";

import {
  ProceduralContextSchema,
} from "./procedural-memory.js";

export const AgentState = new StateSchema({
  messages: MessagesValue,

  requestContext: RequestContextSchema
    .nullable()
    .default(null),

  originalPrompt: z.string().default(""),

  normalizedPrompt: z.string().default(""),

  polishedPrompt: z.string().default(""),

  intent: IntentSchema.default("unclear"),

  facts: z.array(FactSchema).default([]),

  recallSubjects: z
    .array(z.string())
    .default([]),

  memoryMatches: z
    .array(FactSchema)
    .default([]),

  taskPrompt: z
    .string()
    .nullable()
    .default(null),

  clarificationQuestion: z
    .string()
    .nullable()
    .default(null),

  confirmationMessage: z
    .string()
    .nullable()
    .default(null),

  semanticMemory: new ReducedValue(
    z.array(FactSchema).default([]),
    {
      reducer: mergeFacts,
    },
  ),

  episodeContext: z
    .array(z.string())
    .default([]),

  episodeSaved: z
    .boolean()
    .default(false),

  procedureQueries: z
    .array(
      z.string().trim().min(1).max(120),
    )
    .max(3)
    .default([]),

  proceduralContext: z
    .array(ProceduralContextSchema)
    .max(3)
    .default([]),

  turnId: z.string().default(""),

  turnStartIndex: z
    .number()
    .int()
    .nonnegative()
    .default(0),

  llmCalls: new ReducedValue(
    z.number().default(0),
    {
      reducer: (total, increment) =>
        total + increment,
    },
  ),
});