import { tool } from "@langchain/core/tools";
import { z } from "zod";

import {
  loadSessionTranscript,
} from "../graph/episodic-memory.js";

export const getSessionConversation = tool(
  async ({ threadId, offset, maxCharacters }, config) => {
    const organizationId =
      config?.configurable?.organizationId;

    if (
      typeof organizationId !== "string" ||
      !organizationId.trim()
    ) {
      throw new Error(
        "Current organization context is missing.",
      );
    }

    const transcript = await loadSessionTranscript({
      organizationId,
      threadId,
    });

    if (!transcript) {
      return {
        found: false,
        threadId,
        message: "No archived conversation was found.",
      };
    }

    const text = JSON.stringify(transcript.messages);
    const end = Math.min(
      offset + maxCharacters,
      text.length,
    );

    return {
      found: true,
      historical: true,
      threadId,
      updatedAt: transcript.updatedAt,
      totalCharacters: text.length,
      offset,
      text: text.slice(offset, end),
      nextOffset: end < text.length ? end : null,
    };
  },
  {
    name: "get_session_conversation",

    description: [
      "Read an archived session conversation within the current organization.",
      "Use when a session conclusion lacks a needed detail.",
      "Returns a fragment of the original conversation JSON.",
      "Fragments can cross JSON boundaries.",
      "Continue using nextOffset when additional source text is needed.",
      "Archived tool results are historical, not verification of current source data.",
    ].join(" "),

    schema: z.object({
      threadId: z.string().trim().min(1).max(128),
      offset: z.number().int().nonnegative().default(0),
      maxCharacters: z
        .number()
        .int()
        .min(1)
        .max(16000)
        .default(8000),
    }).strict(),
  },
);