import { ChatBedrockConverse } from "@langchain/aws";
import { availableTools } from "./tools/index.js";
import { config } from "./config.js";

const model = new ChatBedrockConverse({
  model: config.model,
  bedrockApiKey: config.apiKey,
  region: config.region,
  maxRetries: 2,
});

// Binding describes the tools to the model. The tools node executes them.
export const modelWithTools = model.bindTools(availableTools);