import { SystemMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";

import { modelWithTools } from "../../model.js";
import type { AgentState } from "../state.js";

const systemPrompt = [
  "You are an assistant that uses available tools to complete user requests.",
  "Choose tools according to their descriptions and required inputs.",
  "Use the appropriate tools when a request requires them.",
  "Ask the user for missing required inputs; do not invent identifiers or facts.",
  "Base your answers on the tool results, and identify sample or fictional data as such.",
  "For dependent tasks, use each tool result in the next step.",
  "If a tool reports an error or no matching record, explain that without inventing details.",
  "Give a concise final answer when the task is complete.",
].join(" ");

export const llmNode: GraphNode<typeof AgentState> = async (state) => {
  const response = await modelWithTools.invoke([
    new SystemMessage(systemPrompt),
    ...state.messages,
  ]);

  // MessagesValue merges this update into the conversation.
  return {
    messages: [response],
    llmCalls: 1,
  };
};