import { z } from "zod";

import { RequestContextSchema } from "../graph/interpretation.js";

export const conversationAskSchema = RequestContextSchema.extend({
  message: z.string().trim().min(1).max(8000),
}).strict();

export type ConversationAskInput =
  z.infer<typeof conversationAskSchema>;