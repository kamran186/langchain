import { z } from "zod";

const historyMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(8000),
  })
  .strict();

export const conversationAskSchema = z
  .object({
    query: z.string().trim().min(1).max(8000),
    history: z.array(historyMessageSchema).max(40).default([]),
  })
  .strict();

export type ConversationAskInput = z.infer<typeof conversationAskSchema>;