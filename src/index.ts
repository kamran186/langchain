import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { agent } from "./graph/graph.js";

async function main() {
  const question =
    process.argv.slice(2).join(" ").trim() || "What can you help me with?";

  const result = await agent.invoke(
    { messages: [new HumanMessage(question)] },
    { recursionLimit: 20 },
  );

  for (const message of result.messages) {
    if (AIMessage.isInstance(message) && message.tool_calls?.length) {
      console.log("[tool requests]", JSON.stringify(message.tool_calls));
    } else {
      console.log(`[${message.type}] ${message.text}`);
    }
  }

  console.log(`Model calls: ${result.llmCalls}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});