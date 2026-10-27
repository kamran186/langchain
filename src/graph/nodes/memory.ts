import {
  AIMessage,
} from "@langchain/core/messages";

import type {
  GraphNode,
} from "@langchain/langgraph";

import {
  isUnusableResponse,
} from "../../model.js";

import {
  isEmployeePreference,
  saveEmployeePreferences,
  saveEpisode,
} from "../checkpointer.js";

import {
  RequestContextSchema,
  mergeFacts,
} from "../interpretation.js";

import type {
  AgentState,
} from "../state.js";

export const semanticMemoryNode: GraphNode<
  typeof AgentState
> = async (state) => {
  const context =
    RequestContextSchema.parse(
      state.requestContext,
    );

  await saveEmployeePreferences(
    context,
    state.facts,
  );

  const sessionFacts =
    state.facts.filter(
      (fact) =>
        !isEmployeePreference(fact),
    );

  return {
    // Session facts remain in checkpointed state.
    semanticMemory: sessionFacts,

    // Answering context includes selected and newly saved facts.
    memoryMatches: mergeFacts(
      state.memoryMatches,
      state.facts,
    ),
  };
};

export const respondNode: GraphNode<
  typeof AgentState
> = (state) => {
  const responses: Record<
    string,
    string
  > = {
    semantic_memory:
      state.confirmationMessage ??
      "I saved that information.",

    unclear:
      state.clarificationQuestion ??
      "Please clarify your request.",

    write:
      "External data changes are not configured in this flow.",

    approval:
      "There is no pending approval operation.",

    clarification:
      "There is no interrupted operation to resume.",
  };

  return {
    messages: [
      new AIMessage(
        responses[state.intent] ??
          "Please clarify your request.",
      ),
    ],
  };
};

export const episodicMemoryNode: GraphNode<
  typeof AgentState
> = async (state) => {
  const last =
    state.messages.at(-1);

  if (
    !state.requestContext ||
    !last ||
    !AIMessage.isInstance(last) ||
    last.tool_calls?.length ||
    isUnusableResponse(last) ||
    last.response_metadata.stopReason ===
      "malformed_model_output"
  ) {
    throw new Error(
      "A completed assistant response is required.",
    );
  }

  const steps = state.messages
    .slice(state.turnStartIndex)
    .map((message) =>
      message.toDict(),
    );

  try {
    await saveEpisode(
      state.requestContext,
      {
        id: state.turnId,

        prompt:
          state.originalPrompt,

        steps,

        outcome:
          last.text.trim(),

        createdAt:
          new Date().toISOString(),
      },
    );

    return {
      episodeSaved: true,
    };
  } catch {
    console.warn(
      "[episodicMemory] The answer completed, but its episode was not saved.",
    );

    return {
      episodeSaved: false,
    };
  }
};