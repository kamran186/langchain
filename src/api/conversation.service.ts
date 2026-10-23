import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { agent } from "../graph/graph.js";
import type { ConversationAskInput } from "./conversation.schema.js";

export async function askConversation(input: ConversationAskInput) {
  const history = input.history.map((message) =>
    message.role === "user"
      ? new HumanMessage(message.content)
      : new AIMessage(message.content),
  );

  // QUERY uses supplied history without writing conversation state.
  // Keep the registered tools read-only for this endpoint.
  const result = await agent.invoke(
    {
      messages: [...history, new HumanMessage(input.query)],
    },
    {
      recursionLimit: 20,
    },
  );

  const message = result.messages.at(-1);

  if (!message || !AIMessage.isInstance(message) || message.tool_calls?.length) {
    throw new Error("The agent did not return a final assistant message.");
  }

  const answer = message.text.trim();

  if (!answer) {
    throw new Error("The agent returned an empty answer.");
  }

  return {
    answer,
    llmCalls: result.llmCalls,
  };
}