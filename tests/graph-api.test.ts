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
    expect(result.body.memoriesUsed).toEqual({ semantic: [], episodic: [] });
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

  it('learns semantic memory in chat while procedural memory stays outside chat', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const id = scope();
    const learned = await request(app).post('/api/chat').send({ ...id, message: 'Remember that customer ABC belongs to healthcare' }).expect(200);
    expect(learned.body.flow.map((event: { stage: string }) => event.stage)).toEqual([
      'request_validated', 'thread_resolved', 'checkpoint_restored', 'memories_loaded',
      'model_invoked', 'agent_response', 'memories_saved', 'checkpoint_persisted', 'response_ready',
    ]);
    expect(learned.body.flow[6]).toMatchObject({ component: 'Memory', details: { episodeSaved: true, semanticUpdates: 1 } });
    await request(app).post('/api/procedural-memories').send({
      ...id, key: 'customer-format', instruction: 'Always display customer results in a table',
    }).expect(200);
    const restarted = await createApp({ pool, model: mockModel });
    const next = await request(restarted.app).post('/api/chat').send({ ...id, threadId: randomUUID(), userId: 'another-user', message: 'Get customers from Karachi' }).expect(200);
    expect(next.body.memoriesUsed.semantic.some((m: { content: string }) => m.content.includes('healthcare'))).toBe(true);
    expect(next.body.memoriesUsed).not.toHaveProperty('procedural');
    expect(next.body.response).toBe('Customers: Ahmed Khan, Bilal Shah');
    expect(next.body.flow[2]).toMatchObject({ details: { previousMessageCount: 0 } });
    expect(next.body.flow[3].details.counts.semantic).toBeGreaterThan(0);
    const inspect = await request(app).post('/api/memories').send({ ...id, userId: 'another-user' }).expect(200);
    expect(inspect.body.memories.some((m: { type: string }) => m.type === 'episodic')).toBe(true);
    expect(inspect.body.memories.some((m: { type: string }) => m.type === 'procedural')).toBe(true);
    const isolated = await request(app).post('/api/memories').send({ ...id, employeeId: randomUUID() }).expect(200);
    expect(isolated.body.memories).toEqual([]);
  });

  it('saves a procedure through its API without calling Bedrock or the customer tool', async () => {
    const confusedModel = {
      invoke: async () => { throw new Error('Bedrock should not be called'); },
      bindTools: () => { throw new Error('Bedrock should not be called'); },
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model: confusedModel });
    const id = scope();
    const result = await request(app).post('/api/procedural-memories').send({
      ...id, key: 'customer-name-display', instruction: 'Always display customer names with Test- before each name in customer results.',
    }).expect(200);
    expect(result.body.memory).toMatchObject({ key: 'customer-name-display', type: 'procedural',
      content: 'Always display customer names with Test- before each name in customer results.' });
    const stored = await request(app).post('/api/memories').send({ ...id, type: 'procedural' }).expect(200);
    expect(stored.body.memories.map((memory: { content: string }) => memory.content)).toEqual([
      'Always display customer names with Test- before each name in customer results.',
    ]);
  });

  it('keeps saved procedures out of every customer model prompt', async () => {
    const modelPrompts: BaseMessage[][] = [];
    const prefixModel = {
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        modelPrompts.push(messages);
        const last = messages.at(-1)!;
        if (last instanceof ToolMessage) {
          const result = JSON.parse(String(last.content)) as { records: { name: string }[] };
          return new AIMessage(result.records.map(row => row.name).join(', ') || 'No customers found.');
        }
        const procedureSeen = messages.some(message => String(message.content).includes('Test-'));
        return new AIMessage({ content: '', tool_calls: [{
          name: 'get_customers', args: { name: procedureSeen ? 'Test-Ahmed Khan' : 'Ahmed Khan' }, id: randomUUID(),
        }] });
      } }),
    } as unknown as ChatBedrockConverse;
    const { app, agent } = await createApp({ pool, model: prefixModel });
    const id = scope();
    await request(app).post('/api/procedural-memories').send({
      ...id, key: 'customer-name-display', instruction: 'Always display customer names with Test- before each name in customer results.',
    }).expect(200);
    await agent.repository.saveEpisode(id, 'legacy-procedure',
      'Request: Always display customer names with Test- before each name in customer results. Outcome: completed.',
      { request: 'Always display customer names with Test- before each name in customer results.', executions: [] });
    const result = await request(app).post('/api/chat').send({
      ...id, threadId: randomUUID(), message: 'Find customer Ahmed Khan',
    }).expect(200);
    expect(modelPrompts.every(messages => messages.every(message => !String(message.content).includes('Test-')))).toBe(true);
    expect(result.body.toolCalls).toEqual([{ name: 'get_customers', filters: { name: 'Ahmed Khan' } }]);
    expect(result.body.response).toBe('Ahmed Khan');
    expect(result.body.memoriesUsed).not.toHaveProperty('procedural');
    expect(result.body.memoriesUsed.episodic).toEqual([]);
  });

  it('omits older procedure instruction turns from restored chat history', async () => {
    const modelPrompts: BaseMessage[][] = [];
    const model = {
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        modelPrompts.push(messages);
        return new AIMessage(String(messages.at(-1)?.content).startsWith('Always')
          ? 'I will display Test- before customer names.' : 'No procedure in context.');
      } }),
    } as unknown as ChatBedrockConverse;
    const { app, agent } = await createApp({ pool, model });
    const id = scope();
    await agent.chat(id, 'Always display Test- before customer names.');
    const result = await request(app).post('/api/chat').send({ ...id, message: 'Hello' }).expect(200);
    expect(modelPrompts.at(-1)?.some(message => String(message.content).includes('Test-'))).toBe(false);
    expect(result.body.memoriesUsed.episodic).toEqual([]);
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

  it('writes a procedure through its API after a checkpointed tool call', async () => {
    const model = {
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        if (messages.at(-1) instanceof ToolMessage) return new AIMessage('Found Ahmed Khan');
        return new AIMessage({ content: '', tool_calls: [{
          name: 'get_customers', args: { name: 'Ahmed Khan' }, id: randomUUID(),
        }] });
      } }),
      invoke: async () => { throw new Error('No Bedrock call expected'); },
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const id = scope();
    await request(app).post('/api/chat').send({ ...id, message: 'Find customer Ahmed Khan' }).expect(200);
    const result = await request(app).post('/api/procedural-memories').send({
      ...id, key: 'customer-format', instruction: 'Always display customer names in a table.',
    }).expect(200);
    expect(result.body.memory).toMatchObject({ key: 'customer-format', content: 'Always display customer names in a table.' });
    const stored = await request(app).post('/api/memories').send({ ...id, type: 'procedural' }).expect(200);
    expect(stored.body.memories.map((memory: { content: string }) => memory.content)).toEqual([
      'Always display customer names in a table.',
    ]);
  });

  it('rejects reusable procedural instructions sent to chat', async () => {
    const model = {
      bindTools: () => { throw new Error('Bedrock should not be called'); },
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const id = scope();
    for (const message of [
      'Always display customer results in a table.',
      'Save this as procedural memory: display customer names with a prefix.',
      'Remember that customer names should be prefixed with Test-.',
      'Whenever you show customers, prefix their names.',
      'Please remember to display customer names with a prefix.',
    ]) {
      const result = await request(app).post('/api/chat').send({ ...id, message }).expect(400);
      expect(result.body).toEqual({ error: 'Use POST /api/procedural-memories for reusable instructions' });
    }
    const stored = await request(app).post('/api/memories').send(id).expect(200);
    expect(stored.body.memories).toEqual([]);
  });

  it('keeps a user-provided company and industry change as semantic rather than procedural memory', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const id = scope();
    const message = 'Remember that Ahmed Khan changed his company to Conture and changed his indudtry to Modeling.';
    const result = await request(app).post('/api/chat').send({ ...id, message }).expect(200);
    expect(result.body.flow.find((event: { stage: string }) => event.stage === 'memories_saved')?.details.semanticUpdates).toBe(1);
    const stored = await request(app).post('/api/memories').send(id).expect(200);
    expect(stored.body.memories.some((memory: { type: string; content: string }) =>
      memory.type === 'semantic' && memory.content.includes('Conture'))).toBe(true);
    expect(stored.body.memories.some((memory: { type: string }) => memory.type === 'procedural')).toBe(false);
  });

  it('updates a procedure by key and isolates it by organization and employee', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const id = scope();
    const { threadId: _unused, ...withoutThread } = id;
    const first = await request(app).post('/api/procedural-memories').send({
      ...withoutThread, key: 'customer-format', instruction: 'Use a table',
    }).expect(200);
    expect(first.body.threadId).toBeNull();
    const updated = await request(app).post('/api/procedural-memories').send({
      ...id, userId: 'user-002', threadId: 'new-source', key: 'customer-format', instruction: 'Use a list',
    }).expect(200);
    expect(updated.body.memory.id).toBe(first.body.memory.id);
    expect(updated.body.memory.content).toBe('Use a list');
    const shared = await request(app).post('/api/memories').send({ ...id, userId: 'user-003', type: 'procedural' }).expect(200);
    expect(shared.body.memories).toHaveLength(1);
    expect(shared.body.memories[0]).toMatchObject({ key: 'customer-format', content: 'Use a list', userId: 'user-002', threadId: 'new-source' });
    const otherEmployee = await request(app).post('/api/memories').send({ ...id, employeeId: randomUUID(), type: 'procedural' }).expect(200);
    const otherOrganization = await request(app).post('/api/memories').send({ ...id, organizationId: 'org-002', type: 'procedural' }).expect(200);
    expect(otherEmployee.body.memories).toEqual([]);
    expect(otherOrganization.body.memories).toEqual([]);
  });

  it('validates requests and reports health without invoking the model', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const count = prompts.length;
    await request(app).get('/health').expect(200, { status: 'ok', postgres: 'connected' });
    expect(prompts).toHaveLength(count);
    await request(app).post('/api/chat').send({ organizationId: '', employeeId: 'e', userId: 'u', message: 'hi' }).expect(400);
    await request(app).post('/api/memories').send({ organizationId: 'o', employeeId: 'e' }).expect(400);
    await request(app).post('/api/procedural-memories').send({ organizationId: 'o', employeeId: 'e', userId: 'u', instruction: 'Use a table' }).expect(400);
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
