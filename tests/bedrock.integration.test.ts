import { describe, expect, it } from 'vitest';
import { ChatBedrockConverse } from '@langchain/aws';
import { createModel } from '../src/agent/model.js';
import { loadEnv } from '../src/config/env.js';
import { createGetCustomersTool } from '../src/tools/get-customers.tool.js';
import { createPool } from '../src/db/postgres.js';
import { runSqlFile } from '../src/db/postgres.js';
import { createApp } from '../src/app.js';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

describe('configured Bedrock Qwen', () => {
  it('responds and emits a native get_customers call', async () => {
    const env = loadEnv();
    const model: ChatBedrockConverse = createModel(env);
    const pool = createPool(env.DATABASE_URL);
    try {
      const reply = await model.bindTools([createGetCustomersTool(pool, 'org-001')]).invoke('Use get_customers to find active customers in Karachi.');
      expect(reply.tool_calls?.some(call => call.name === 'get_customers' && call.args.city === 'Karachi')).toBe(true);
    } finally { await pool.end(); }
  });
  it('runs Qwen through the graph and returns actual customer tool execution', async () => {
    const env = loadEnv();
    const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/langgraph_memory_test';
    if (url === env.DATABASE_URL || !url.endsWith('/langgraph_memory_test')) throw new Error('Unsafe test database URL');
    const pool = createPool(url);
    try {
      await runSqlFile(pool, 'schema'); await runSqlFile(pool, 'seed');
      const { app } = await createApp({ pool, model: createModel(env), env });
      const result = await request(app).post('/api/chat').send({
        organizationId: 'org-001', employeeId: randomUUID(), userId: 'live-test',
        message: 'Get active customers from Karachi using get_customers.',
      }).expect(200);
      expect(result.body.toolCalls.some((call: { name: string }) => call.name === 'get_customers')).toBe(true);
      expect(result.body.response).toContain('Ahmed');
      expect(result.body.threadId).toBeTruthy();
    } finally { await pool.end(); }
  });
});
