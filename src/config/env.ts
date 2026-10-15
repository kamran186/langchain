import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url().default('postgresql://postgres:postgres@localhost:5432/langgraph_memory'),
  BEDROCK_REGION: z.string().min(1).default('us-east-1'),
  BEDROCK_MODEL: z.string().min(1).default('qwen.qwen3-32b-v1:0'),
  BEDROCK_API_KEY: z.string().min(1).optional(),
  MEMORY_LIMIT: z.coerce.number().int().min(1).max(20).default(5),
});

export type Env = z.infer<typeof schema>;
export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(input);
}
