import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatBedrockConverse } from '@langchain/aws';
import pg from 'pg';
import request from 'supertest';
import { createPool, runSqlFile } from '../src/db/postgres.js';
import { createApp } from '../src/app.js';
import { checkpointKey } from '../src/agent/graph.js';

let pool: pg.Pool;
const prompts: BaseMessage[][] = [];
const mockModel = {
  bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
    prompts.push(messages);
    const last = messages.at(-1)!;
    if (last instanceof ToolMessage) {
      const result = JSON.parse(String(last.content)) as { records?: { name: string }[]; error?: string };
      if (result.error) return new AIMessage('Customer lookup failed.');
      const names = result.records!.map(row => row.name).join(', ');
      const context = messages.find(item => String(item.content).includes('Application-supplied employee memory'));
      const table = String(context?.content ?? '').toLowerCase().includes('table');
      return new AIMessage(table ? `| Customer |\n|---|\n${result.records!.map(row => `| ${row.name} |`).join('\n')}` : `Customers: ${names}`);
    }
    const current = String(last.content);
    if (current === 'invalid-tool-args') return new AIMessage({ content: '', tool_calls: [{ name: 'get_customers', args: { status: 'unknown' }, id: randomUUID() }] });
    if (current === 'Find customers in NoSuchCity') return new AIMessage({ content: '', tool_calls: [{ name: 'get_customers', args: { city: 'NoSuchCity' }, id: randomUUID() }] });
    if (current.includes('What was my prior request?')) {
      const history = messages.filter(item => item instanceof HumanMessage && !String(item.content).startsWith('Application-supplied employee memory')).map(item => String(item.content));
      return new AIMessage(history.find(text => text.includes('unique-history-')) ?? 'No prior request');
    }
    if (/get|find|show/i.test(current) && /customers/i.test(current)) {
      const filters = current.includes('Karachi') ? { city: 'Karachi', status: current.includes('active') ? 'active' : undefined } : {};
      return new AIMessage({ content: '', tool_calls: [{ name: 'get_customers', args: filters, id: randomUUID() }] });
    }
    const context = messages.find(item => String(item.content).includes('Application-supplied employee memory'));
    return new AIMessage(context ? `Remembered: ${String(context.content)}` : 'Acknowledged');
  } }),
} as unknown as ChatBedrockConverse;

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/langgraph_memory_test';
  if (url === process.env.DATABASE_URL || !url.endsWith('/langgraph_memory_test')) throw new Error('Unsafe test database URL');
  pool = createPool(url);
  await runSqlFile(pool, 'schema'); await runSqlFile(pool, 'seed');
});
afterAll(async () => { await pool?.end(); });

const scope = () => ({ organizationId: 'org-001', employeeId: randomUUID(), userId: 'user-001', threadId: randomUUID() });

describe('LangGraph and API', () => {
  it('runs model-selected filters through the real customer tool before final response', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const input = { ...scope(), message: 'Get active customers from Karachi' };
    const result = await request(app).post('/api/chat').send(input).expect(200);
    expect(result.body.toolCalls).toEqual([{ name: 'get_customers', filters: { city: 'Karachi', status: 'active' } }]);
    expect(result.body.response).toContain('Ahmed Khan');
    expect(result.body.response).not.toContain('Sara Ahmed');
    expect(prompts.at(-1)?.at(-1)).toBeInstanceOf(ToolMessage);
    expect(result.body.memoriesUsed).toEqual({ semantic: [], episodic: [], procedural: [] });
  });

  it('learns semantic and procedural memories and applies them in another thread', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const id = scope();
    await request(app).post('/api/chat').send({ ...id, message: 'Remember that customer ABC belongs to healthcare' }).expect(200);
    await request(app).post('/api/chat').send({ ...id, message: 'Always display customer results in a table' }).expect(200);
    const restarted = await createApp({ pool, model: mockModel });
    const next = await request(restarted.app).post('/api/chat').send({ ...id, threadId: randomUUID(), userId: 'another-user', message: 'Get customers from Karachi' }).expect(200);
    expect(next.body.memoriesUsed.semantic.some((m: { content: string }) => m.content.includes('healthcare'))).toBe(true);
    expect(next.body.memoriesUsed.procedural.some((m: { content: string }) => m.content.includes('table'))).toBe(true);
    expect(next.body.response).toContain('| Customer |');
    const inspect = await request(app).post('/api/memories').send({ ...id, userId: 'another-user' }).expect(200);
    expect(inspect.body.memories.some((m: { type: string }) => m.type === 'episodic')).toBe(true);
    const isolated = await request(app).post('/api/memories').send({ ...id, employeeId: randomUUID() }).expect(200);
    expect(isolated.body.memories).toEqual([]);
  });

  it('restores conversation checkpoints with a new app instance and isolates user and thread', async () => {
    const id = scope();
    const first = await createApp({ pool, model: mockModel });
    await request(first.app).post('/api/chat').send({ ...id, message: 'unique-history-' + id.threadId }).expect(200);
    const restarted = await createApp({ pool, model: mockModel });
    const same = await request(restarted.app).post('/api/chat').send({ ...id, message: 'What was my prior request?' }).expect(200);
    expect(same.body.response).toContain('unique-history-');
    const otherThread = await request(restarted.app).post('/api/chat').send({ ...id, threadId: randomUUID(), message: 'What was my prior request?' }).expect(200);
    expect(otherThread.body.response).toBe('No prior request');
    const otherUser = await request(restarted.app).post('/api/chat').send({ ...id, userId: 'other', message: 'What was my prior request?' }).expect(200);
    expect(otherUser.body.response).toBe('No prior request');
    expect(checkpointKey(id)).not.toBe(checkpointKey({ ...id, userId: 'other' }));
    expect(checkpointKey(id)).not.toBe(checkpointKey({ ...id, employeeId: 'other' }));
    expect(checkpointKey(id)).not.toBe(checkpointKey({ ...id, organizationId: 'other' }));
  });

  it('validates requests and reports health without invoking the model', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const count = prompts.length;
    await request(app).get('/health').expect(200, { status: 'ok', postgres: 'connected' });
    expect(prompts).toHaveLength(count);
    await request(app).post('/api/chat').send({ organizationId: '', employeeId: 'e', userId: 'u', message: 'hi' }).expect(400);
    await request(app).post('/api/memories').send({ organizationId: 'o', employeeId: 'e' }).expect(400);
  });

  it('does not create a successful episode for rejected tool filters', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const id = scope();
    await request(app).post('/api/chat').send({ ...id, message: 'invalid-tool-args' }).expect(400);
    const inspected = await request(app).post('/api/memories').send(id).expect(200);
    expect(inspected.body.memories).toEqual([]);
  });

  it('records empty customer results distinctly', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const id = scope();
    await request(app).post('/api/chat').send({ ...id, message: 'Find customers in NoSuchCity' }).expect(200);
    const inspected = await request(app).post('/api/memories').send({ ...id, type: 'episodic' }).expect(200);
    expect(inspected.body.memories[0].content).toContain('empty (0 records)');
  });

  it('reports database tool failure without recording success', async () => {
    const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/langgraph_memory_test';
    const schemaName = `failure_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    const isolatedPool = new pg.Pool({ connectionString: url, options: `-c search_path=${schemaName}` });
    try {
      await runSqlFile(isolatedPool, 'schema');
      await isolatedPool.query('DROP TABLE customers');
      const { app } = await createApp({ pool: isolatedPool, model: mockModel });
      const id = scope();
      const result = await request(app).post('/api/chat').send({ ...id, message: 'Get active customers from Karachi' }).expect(200);
      expect(result.body.response).toBe('Customer lookup failed.');
      const inspected = await request(app).post('/api/memories').send({ ...id, type: 'episodic' }).expect(200);
      expect(inspected.body.memories[0].content).toContain('tool failure');
      expect(inspected.body.memories[0].content).not.toContain('success');
    } finally {
      await isolatedPool.end();
      await pool.query(`DROP SCHEMA ${schemaName} CASCADE`);
    }
  });
});
