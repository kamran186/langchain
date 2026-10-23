import { AIMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";

import type { AgentState } from "../state.js";

export const formatResponseNode: GraphNode<typeof AgentState> = (state) => {
  const last = state.messages.at(-1);

  if (
    !last ||
    !AIMessage.isInstance(last) ||
    last.tool_calls?.length ||
    !last.id
  ) {
    throw new Error("A final assistant message with an ID is required.");
  }

  const preferences = new Map(
    state.semanticMemory
      .filter((fact) => fact.subject === "self")
      .map((fact) => [fact.key, fact.value]),
  );

  const name = preferences.get("preferred_name");
  const mentionName = preferences.get("mention_name_in_replies");

  if (
    mentionName !== true ||
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 80 ||
    /[\r\n]/.test(name)
  ) {
    return {};
  }

  const prefix = `${name.trim()},`;
  const text = last.text.trim();

  if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
    return {};
  }

  return {
    messages: [
      new AIMessage({
        id: last.id,
        content: `${prefix} ${text}`,
        response_metadata: last.response_metadata,
        usage_metadata: last.usage_metadata,
      }),
    ],
  };
};