import { AIMessage, type ToolMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";

import { toolsByName } from "../../tools/index.js";
import type { AgentState } from "../state.js";

export const toolsNode: GraphNode<typeof AgentState> = async (state) => {
  const message = state.messages.at(-1);

  if (!message || !AIMessage.isInstance(message)) {
    return { messages: [] };
  }

  const observations: ToolMessage[] = [];

  for (const call of message.tool_calls ?? []) {
    const registeredTool = toolsByName.get(call.name);

    if (!registeredTool) {
      throw new Error(`Unknown registered tool: ${call.name}`);
    }

    if (!call.id) {
      throw new Error(`Tool call for ${call.name} is missing its id.`);
    }

    // LangChain wraps ordinary results and preserves the request's id.
    const observation = await registeredTool.invoke({
      ...call,
      type: "tool_call",
    });

    observations.push(observation);
  }

  return { messages: observations };
};