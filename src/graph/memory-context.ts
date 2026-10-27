import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import type { Fact } from "./interpretation.js";

export function compactFacts(facts: readonly Fact[]) {
  return facts.map(({ subject, key, value }) => ({
    subject,
    key,
    value,
  }));
}

export function recentHistory(
  messages: readonly BaseMessage[],
  turnStartIndex: number,
): BaseMessage[] {
  const turns: Array<{
    question: string;
    answer: string;
  }> = [];

  let question: string | null = null;

  for (const message of messages.slice(0, turnStartIndex)) {
    if (HumanMessage.isInstance(message)) {
      question = message.text;
      continue;
    }

    if (
      question !== null &&
      AIMessage.isInstance(message) &&
      !message.tool_calls?.length &&
      message.text.trim()
    ) {
      turns.push({
        question,
        answer: message.text,
      });

      question = null;
    }
  }

  return turns.slice(-2).flatMap((turn) => [
    new HumanMessage(turn.question.slice(0, 500)),
    new AIMessage(turn.answer.slice(0, 500)),
  ]);
}