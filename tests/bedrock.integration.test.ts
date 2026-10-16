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
import { refineMemory } from '../src/memory/refine-memory.js';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { checkpointKey } from '../src/agent/graph.js';

describe('configured Bedrock Qwen', () => {
  it('polishes wording and recognizes an equivalent stored procedure', async () => {
    const model = createModel(loadEnv());
    const existing = { id: randomUUID(), content: 'Always display customer names in a table.' };
    const result = await refineMemory(model, 'procedural',
      'Always disply customer names in a tabel.', [existing]);
    expect(result.content.toLowerCase()).toContain('display customer names in a table');
    expect(result.equivalentMemoryId).toBe(existing.id);
  });
  it('keeps an uncertain business term while fixing surrounding typos', async () => {
    const result = await refineMemory(createModel(loadEnv()), 'procedural',
      'revive orders shold be processssed firts always.');
    expect(result.content.toLowerCase()).toContain('revive orders');
    expect(result.content.toLowerCase()).toContain('processed first');
    expect(result.content.toLowerCase()).not.toMatch(/shold|processssed|firts/);
  });
  it('keeps the stored revive-orders procedure when the user repeats its meaning', async () => {
    const env = loadEnv();
    const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/langgraph_memory_test';
    if (url === env.DATABASE_URL || !url.endsWith('/langgraph_memory_test')) throw new Error('Unsafe test database URL');
    const pool = createPool(url);
    try {
      await runSqlFile(pool, 'schema');
      const { app } = await createApp({ pool, model: createModel(env), env });
      const ids = { organizationId: 'org-001', employeeId: randomUUID(), userId: 'live-test' };
      const first = await request(app).post('/api/procedural-memories').send({ ...ids,
        key: 'order-priority', instruction: 'revive orders should be processssed firts always.',
      }).expect(200);
      const repeated = await request(app).post('/api/procedural-memories').send({ ...ids,
        key: 'different-order-priority-key', instruction: 'always process revive orders first',
      }).expect(200);
      expect(repeated.body.status).toBe('already_exists');
      expect(repeated.body.memory).toEqual(first.body.memory);
    } finally { await pool.end(); }
  });
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
      const ids = { organizationId: 'org-001', employeeId: randomUUID(), userId: 'live-test' };
      const result = await request(app).post('/api/chat').send({
        ...ids,
        message: 'Get active customers from Karachi using get_customers.',
      }).expect(200);
      expect(Object.keys(result.body).sort()).toEqual([
        'employeeId', 'organizationId', 'response', 'threadId', 'userId',
      ]);
      expect(result.body.response).toContain('Ahmed');
      expect(result.body.threadId).toBeTruthy();
      const episode = await pool.query<{ metadata: { executions: unknown[] } }>(
        "SELECT metadata FROM employee_memories WHERE organization_id=$1 AND employee_id=$2 AND memory_type='episodic'",
        [ids.organizationId, ids.employeeId]);
      expect(episode.rows[0]?.metadata.executions).toMatchObject([{
        name: 'get_customers', filters: { city: 'Karachi', status: 'active' }, outcome: 'success', count: 1,
      }]);
    } finally { await pool.end(); }
  });
  it('applies a saved customer display procedure after fetching real records', async () => {
    const env = loadEnv();
    const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/langgraph_memory_test';
    if (url === env.DATABASE_URL || !url.endsWith('/langgraph_memory_test')) throw new Error('Unsafe test database URL');
    const pool = createPool(url);
    try {
      await runSqlFile(pool, 'schema'); await runSqlFile(pool, 'seed');
      const { app } = await createApp({ pool, model: createModel(env), env });
      const ids = { organizationId: 'org-001', employeeId: randomUUID(), userId: 'live-test', threadId: randomUUID() };
      await request(app).post('/api/procedural-memories').send({ ...ids, key: 'ins-1',
        instruction: 'Always add prefix Custo- with the customer Name while fetching Customers',
      }).expect(200);
      const result = await request(app).post('/api/chat').send({ ...ids, message: 'Fetch Customers' }).expect(200);
      expect(Object.keys(result.body).sort()).toEqual([
        'employeeId', 'organizationId', 'response', 'threadId', 'userId',
      ]);
      expect(result.body.response).toContain('Custo-Ahmed Khan');
      const episode = await pool.query<{ metadata: { executions: { name: string; filters: { name?: string } }[] } }>(
        "SELECT metadata FROM employee_memories WHERE organization_id=$1 AND employee_id=$2 AND memory_type='episodic'",
        [ids.organizationId, ids.employeeId]);
      expect(episode.rows[0]?.metadata.executions[0]?.name).toBe('get_customers');
      expect(JSON.stringify(episode.rows[0]?.metadata.executions[0]?.filters)).not.toContain('Custo-');
      const checkpoint = await new PostgresSaver(pool).getTuple({ configurable: { thread_id: checkpointKey(ids) } });
      const messages = checkpoint?.checkpoint.channel_values.messages as { content: string }[] | undefined;
      expect(String(messages?.at(-1)?.content)).toContain('Custo-Ahmed Khan');
    } finally { await pool.end(); }
  });
});
