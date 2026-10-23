import { AIMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";

import { isUnusableResponse } from "../../model.js";
import { saveEpisode } from "../checkpointer.js";
import { mergeFacts } from "../interpretation.js";
import type { AgentState } from "../state.js";

export const semanticMemoryNode: GraphNode<typeof AgentState> = (state) => {
  const available = mergeFacts(state.semanticMemory, state.facts);

  const subjects = new Set([
    "self",
    ...state.recallSubjects,
    ...state.facts.map((fact) => fact.subject),
  ]);

  return {
    semanticMemory: state.facts,
    memoryMatches: available.filter(
      (fact) => subjects.has(fact.subject),
    ),
  };
};

const responses: Record<string, string> = {
  semantic_memory: "I saved that information for this session.",
  write: "External data changes are not configured in this flow.",
  approval: "There is no pending approval operation.",
  clarification: "There is no interrupted operation to resume.",
};

export const respondNode: GraphNode<typeof AgentState> = (state) => ({
  messages: [
    new AIMessage(
      responses[state.intent] ??
      state.clarificationQuestion ??
      "Please clarify your request.",
    ),
  ],
});

export const episodicMemoryNode: GraphNode<typeof AgentState> =
  async (state) => {
    const last = state.messages.at(-1);

    if (
      !state.requestContext ||
      !last ||
      !AIMessage.isInstance(last) ||
      last.tool_calls?.length ||
      isUnusableResponse(last)
    ) {
      throw new Error("A completed assistant response is required.");
    }

    const steps = state.messages.slice(state.turnStartIndex).map(
      (message) => ({
        role: message.type,
        text: message.text,
        toolCalls: AIMessage.isInstance(message)
          ? message.tool_calls
          : undefined,
      }),
    );

    try {
      await saveEpisode(state.requestContext, {
        id: state.turnId,
        prompt: state.originalPrompt,
        steps,
        outcome: last.text.trim(),
        createdAt: new Date().toISOString(),
      });

      return { episodeSaved: true };
    } catch {
      console.warn(
        "[episodicMemory] The answer completed, but its episode was not saved.",
      );

      return { episodeSaved: false };
    }
  };