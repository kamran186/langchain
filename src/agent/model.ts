import { ChatBedrockConverse } from '@langchain/aws';
import type { Env } from '../config/env.js';

export function createModel(env: Env): ChatBedrockConverse {
  if (!env.BEDROCK_API_KEY || env.BEDROCK_API_KEY === 'your_bedrock_api_key') {
    throw new Error('BEDROCK_API_KEY must be a configured Bedrock bearer API key');
  }
  return new ChatBedrockConverse({
    region: env.BEDROCK_REGION, model: env.BEDROCK_MODEL, bedrockBearerToken: env.BEDROCK_API_KEY,
    temperature: 0.1, maxTokens: 1024, timeout: 30000, maxRetries: 2,
  });
}
