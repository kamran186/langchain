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
  invoke: async (messages: BaseMessage[]) => {
    prompts.push(messages);
    return new AIMessage('Acknowledged');
  },
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
    expect(result.body.flow.map((event: { stage: string }) => event.stage)).toEqual([
      'request_validated', 'thread_resolved', 'checkpoint_restored', 'memories_loaded',
      'model_invoked', 'agent_response', 'tool_executed', 'tool_result_returned',
      'model_invoked', 'agent_response', 'memories_saved',
      'checkpoint_persisted', 'response_ready',
    ]);
    expect(result.body.flow.map((event: { step: number }) => event.step)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13]);
    expect(result.body.flow[4]).toMatchObject({ component: 'LangChain' });
    expect(result.body.flow[5]).toMatchObject({ component: 'LLM Agent' });
    expect(result.body.flow[6]).toMatchObject({ component: 'LangChain', status: 'success', details: {
      name: 'get_customers', filters: { city: 'Karachi', status: 'active' }, returnedCount: 1,
    } });
    expect(result.body.flow[7]).toMatchObject({ component: 'LangGraph', details: { resultType: 'success' } });
  });

  it('learns semantic and procedural memories and applies them in another thread', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const id = scope();
    const learned = await request(app).post('/api/chat').send({ ...id, message: 'Remember that customer ABC belongs to healthcare' }).expect(200);
    expect(learned.body.flow.map((event: { stage: string }) => event.stage)).toEqual([
      'request_validated', 'thread_resolved', 'checkpoint_restored', 'memories_loaded',
      'model_invoked', 'agent_response', 'memories_saved', 'checkpoint_persisted', 'response_ready',
    ]);
    expect(learned.body.flow[6]).toMatchObject({ component: 'Memory', details: { episodeSaved: true, semanticUpdates: 1, proceduralUpdates: 0 } });
    await request(app).post('/api/chat').send({ ...id, message: 'Always display customer results in a table' }).expect(200);
    const restarted = await createApp({ pool, model: mockModel });
    const next = await request(restarted.app).post('/api/chat').send({ ...id, threadId: randomUUID(), userId: 'another-user', message: 'Get customers from Karachi' }).expect(200);
    expect(next.body.memoriesUsed.semantic.some((m: { content: string }) => m.content.includes('healthcare'))).toBe(true);
    expect(next.body.memoriesUsed.procedural.some((m: { content: string }) => m.content.includes('table'))).toBe(true);
    expect(next.body.response).toContain('| Customer |');
    expect(next.body.flow[2]).toMatchObject({ details: { previousMessageCount: 0 } });
    expect(next.body.flow[3].details.counts.semantic).toBeGreaterThan(0);
    const inspect = await request(app).post('/api/memories').send({ ...id, userId: 'another-user' }).expect(200);
    expect(inspect.body.memories.some((m: { type: string }) => m.type === 'episodic')).toBe(true);
    const isolated = await request(app).post('/api/memories').send({ ...id, employeeId: randomUUID() }).expect(200);
    expect(isolated.body.memories).toEqual([]);
  });

  it('saves a presentation preference without searching for the display name', async () => {
    const confusedModel = {
      invoke: async () => new AIMessage('Understood. I can apply that preference.'),
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        if (messages.at(-1) instanceof ToolMessage) return new AIMessage('No customers found.');
        return new AIMessage({ content: '', tool_calls: [{
          name: 'get_customers', args: { name: 'Test-Ahmed Khan' }, id: randomUUID(),
        }] });
      } }),
    } as unknown as ChatBedrockConverse;
    const { app, agent } = await createApp({ pool, model: confusedModel });
    const id = scope();
    await agent.repository.upsert(id, 'semantic', 'known-fact', 'Ahmed Khan belongs to healthcare');
    const result = await request(app).post('/api/chat').send({
      ...id, message: 'Always display customer names with Test- before each name in customer results.',
    }).expect(200);
    expect(result.body.toolCalls).toEqual([]);
    expect(result.body.memoriesUsed.semantic).toEqual([expect.objectContaining({ content: 'Ahmed Khan belongs to healthcare' })]);
    expect(result.body.response).toBe('Understood. I can apply that preference.');
    const stored = await request(app).post('/api/memories').send({ ...id, type: 'procedural' }).expect(200);
    expect(stored.body.memories.map((memory: { content: string }) => memory.content)).toEqual([
      'display customer names with Test- before each name in customer results',
    ]);
  });

  it('keeps presentation memories out of customer tool planning', async () => {
    let planningPrompt: BaseMessage[] = [];
    const prefixModel = {
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        const last = messages.at(-1)!;
        if (last instanceof ToolMessage) {
          const result = JSON.parse(String(last.content)) as { records: { name: string }[] };
          return new AIMessage(result.records.map(row => row.name).join(', ') || 'No customers found.');
        }
        planningPrompt = messages;
        const procedureSeen = messages.some(message => String(message.content).includes('Test-'));
        return new AIMessage({ content: '', tool_calls: [{
          name: 'get_customers', args: { name: procedureSeen ? 'Test-Ahmed Khan' : 'Ahmed Khan' }, id: randomUUID(),
        }] });
      } }), invoke: async () => new AIMessage('Preference saved.'),
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model: prefixModel });
    const id = scope();
    await request(app).post('/api/chat').send({
      ...id, message: 'Always display customer names with Test- before each name in customer results.',
    }).expect(200);
    const result = await request(app).post('/api/chat').send({
      ...id, threadId: randomUUID(), message: 'Find customer Ahmed Khan',
    }).expect(200);
    expect(planningPrompt.some(message => String(message.content).includes('Test-'))).toBe(false);
    expect(result.body.toolCalls).toEqual([{ name: 'get_customers', filters: { name: 'Ahmed Khan' } }]);
    expect(result.body.response).toBe('Ahmed Khan');
  });

  it('restores conversation checkpoints with a new app instance and isolates user and thread', async () => {
    const id = scope();
    const first = await createApp({ pool, model: mockModel });
    await request(first.app).post('/api/chat').send({ ...id, message: 'unique-history-' + id.threadId }).expect(200);
    const restarted = await createApp({ pool, model: mockModel });
    const same = await request(restarted.app).post('/api/chat').send({ ...id, message: 'What was my prior request?' }).expect(200);
    expect(same.body.response).toContain('unique-history-');
    expect(same.body.flow[2].details.previousMessageCount).toBeGreaterThan(0);
    const otherThread = await request(restarted.app).post('/api/chat').send({ ...id, threadId: randomUUID(), message: 'What was my prior request?' }).expect(200);
    expect(otherThread.body.response).toBe('No prior request');
    expect(otherThread.body.flow[2]).toMatchObject({ details: { previousMessageCount: 0 } });
    const otherUser = await request(restarted.app).post('/api/chat').send({ ...id, userId: 'other', message: 'What was my prior request?' }).expect(200);
    expect(otherUser.body.response).toBe('No prior request');
    expect(checkpointKey(id)).not.toBe(checkpointKey({ ...id, userId: 'other' }));
    expect(checkpointKey(id)).not.toBe(checkpointKey({ ...id, employeeId: 'other' }));
    expect(checkpointKey(id)).not.toBe(checkpointKey({ ...id, organizationId: 'other' }));
  });

  it('accepts a preference after a tool call in the same checkpointed thread', async () => {
    const model = {
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        if (messages.at(-1) instanceof ToolMessage) return new AIMessage('Found Ahmed Khan');
        return new AIMessage({ content: '', tool_calls: [{
          name: 'get_customers', args: { name: 'Ahmed Khan' }, id: randomUUID(),
        }] });
      } }),
      invoke: async (messages: BaseMessage[]) => {
        if (messages.some(message => message instanceof ToolMessage ||
          (message instanceof AIMessage && Boolean(message.tool_calls?.length)))) {
          throw new Error('toolUse requires toolConfig');
        }
        return new AIMessage('Preference saved.');
      },
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const id = scope();
    await request(app).post('/api/chat').send({ ...id, message: 'Find customer Ahmed Khan' }).expect(200);
    const result = await request(app).post('/api/chat').send({
      ...id, message: 'Always display customer names in a table.',
    }).expect(200);
    expect(result.body.response).toBe('Preference saved.');
    expect(result.body.toolCalls).toEqual([]);
    const stored = await request(app).post('/api/memories').send({ ...id, type: 'procedural' }).expect(200);
    expect(stored.body.memories.map((memory: { content: string }) => memory.content)).toEqual([
      'display customer names in a table',
    ]);
  });

  it('does not misreport a no-tool model error as unsupported tool calling', async () => {
    const model = {
      invoke: async () => { throw new Error('toolUse requires toolConfig'); },
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const result = await request(app).post('/api/chat').send({
      ...scope(), message: 'Always display customer results in a table.',
    }).expect(500);
    expect(result.body).toEqual({ error: 'Request failed' });
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
    const result = await request(app).post('/api/chat').send({ ...id, message: 'Find customers in NoSuchCity' }).expect(200);
    expect(result.body.flow.find((event: { stage: string }) => event.stage === 'tool_executed')).toMatchObject({ status: 'empty', details: { returnedCount: 0, totalMatched: 0 } });
    const inspected = await request(app).post('/api/memories').send({ ...id, type: 'episodic' }).expect(200);
    expect(inspected.body.memories[0].content).toContain('empty (0 records)');
  });

  it('marks a generated thread ID in the ordered response flow', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const { threadId: _unused, ...withoutThread } = scope();
    const result = await request(app).post('/api/chat').send({ ...withoutThread, message: 'Hello' }).expect(200);
    expect(result.body.threadId).toBeTruthy();
    expect(result.body.flow[1]).toMatchObject({ stage: 'thread_resolved', details: { generated: true } });
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
      expect(result.body.flow.find((event: { stage: string }) => event.stage === 'tool_executed')).toMatchObject({ status: 'failure' });
      const inspected = await request(app).post('/api/memories').send({ ...id, type: 'episodic' }).expect(200);
      expect(inspected.body.memories[0].content).toContain('tool failure');
      expect(inspected.body.memories[0].content).not.toContain('success');
    } finally {
      await isolatedPool.end();
      await pool.query(`DROP SCHEMA ${schemaName} CASCADE`);
    }
  });
});
