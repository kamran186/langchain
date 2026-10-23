import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { agent } from "../graph/graph.js";
import { sessionKey } from "../graph/interpretation.js";
import type { ConversationAskInput } from "./conversation.schema.js";

const pendingConversations = new Map<string, Promise<void>>();

async function runConversation(
  input: ConversationAskInput,
  key: string,
) {
  const { message, ...requestContext } = input;

  const config = {
    configurable: {
      ...requestContext,
      thread_id: key,
    },
    recursionLimit: 40,
  };

  const before = await agent.getState(config);

  if (before.next.length > 0) {
    throw new Error(
      "This session has an unfinished run. Resume it explicitly or use a new threadId.",
    );
  }

  const previousCalls = before.values.llmCalls ?? 0;

  const result = await agent.invoke({
    requestContext,
    messages: [new HumanMessage(message)],
  }, config);

  const last = result.messages.at(-1);

  if (
    !last ||
    !AIMessage.isInstance(last) ||
    last.tool_calls?.length ||
    !last.text.trim()
  ) {
    throw new Error("The graph did not return a final answer.");
  }

  return {
    ...requestContext,
    intent: result.intent,
    normalizedPrompt: result.normalizedPrompt,
    polishedPrompt: result.polishedPrompt,
    facts: result.facts,
    answer: last.text.trim(),
    llmCalls: result.llmCalls - previousCalls,
    episodeSaved: result.episodeSaved,
  };
}

export async function askConversation(input: ConversationAskInput) {
  const key = sessionKey(input);
  const previous = pendingConversations.get(key) ?? Promise.resolve();

  const task = previous.then(() => runConversation(input, key));

  const settled = task.then(
    () => undefined,
    () => undefined,
  );

  pendingConversations.set(key, settled);

  try {
    return await task;
  } finally {
    if (pendingConversations.get(key) === settled) {
      pendingConversations.delete(key);
    }
  }
}