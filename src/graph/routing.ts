import { AIMessage } from "@langchain/core/messages";
import { END } from "@langchain/langgraph";
import type { ConditionalEdgeRouter } from "@langchain/langgraph";

import type { AgentState } from "./state.js";

export const routeAfterModel: ConditionalEdgeRouter<{
  InputSchema: typeof AgentState;
  Nodes: "tools";
}> = (state) => {
  const message = state.messages.at(-1);

  if (message && AIMessage.isInstance(message) && message.tool_calls?.length) {
    return "tools";
  }

  return END;
};