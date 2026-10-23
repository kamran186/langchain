import { json, Router, type RequestHandler } from "express";

import { conversationAskSchema } from "./conversation.schema.js";
import { askConversation } from "./conversation.service.js";

export const conversationRouter = Router();


// all() allows handling the literal QUERY method.
conversationRouter.all(
  "/ask",
  json({ limit: "256kb" }),
  async (req, res) => {
    const parsed = conversationAskSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message: "Provide a query and optional conversation history.",
          details: parsed.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }

    const result = await askConversation(parsed.data);

    res.status(200).json(result);
  },
);