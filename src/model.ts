import { ChatBedrockConverse } from "@langchain/aws";
import type { AIMessage } from "@langchain/core/messages";

import { config } from "./config.js";
import { availableTools } from "./tools/index.js";

export const model = new ChatBedrockConverse({
  model: config.model,
  region: config.region,
  bedrockBearerToken: config.apiKey,
  maxRetries: 2,
});

// Same model for now, with a bounded selection response.
export const memoryFilterModel = new ChatBedrockConverse({
  model: config.model,
  region: config.region,
  bedrockBearerToken: config.apiKey,
  maxTokens: 2048,
  maxRetries: 2,
});

export const modelWithTools = model.bindTools(availableTools);

export function isUnusableResponse(
  response: AIMessage,
  allowTools = false,
): boolean {
  const reason = String(response.response_metadata.stopReason);
  const toolCount = response.tool_calls?.length ?? 0;

  const interrupted = [
    "max_tokens",
    "guardrail_intervened",
    "content_filtered",
    "malformed_tool_use",
    "model_context_window_exceeded",
  ].includes(reason);

  return interrupted ||
    Boolean(response.invalid_tool_calls?.length) ||
    (!allowTools && (toolCount > 0 || reason === "tool_use")) ||
    (reason === "tool_use" && toolCount === 0) ||
    (toolCount === 0 && !response.text.trim());
}