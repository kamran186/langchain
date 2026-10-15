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
    const input = JSON.parse(String(messages.at(-1)?.content)) as {
      memoryType?: string; original?: string; existing?: { id: string; content: string }[];
      draftAnswer: string; preferences: { content: string }[];
    };
    if (input.memoryType) return new AIMessage(JSON.stringify({ content: input.original,
      equivalentMemoryId: input.existing?.find(item => item.content === input.original)?.id ?? null }));
    if (input.preferences.some(preference => /table/i.test(preference.content)) && input.draftAnswer.startsWith('Customers: ')) {
      const names = input.draftAnswer.slice('Customers: '.length).split(', ');
      return new AIMessage(`| Customer |\n|---|\n${names.map(name => `| ${name} |`).join('\n')}`);
    }
    return new AIMessage(input.draftAnswer);
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
  it('does not update a procedural memory when refined wording differs only by punctuation', async () => {
    const ids = scope();
    const model = {
      invoke: async (messages: BaseMessage[]) => {
        const input = JSON.parse(String(messages.at(-1)?.content)) as { original: string };
        return new AIMessage(JSON.stringify({
          content: input.original.includes('Please')
            ? 'Always display customer names in a table!'
            : 'Always display customer names in a table.',
          equivalentMemoryId: null,
        }));
      },
      bindTools: mockModel.bindTools,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const first = await request(app).post('/api/procedural-memories').send({
      ...ids, key: 'customer-format', instruction: 'Always display customer names in a table.',
    }).expect(200);
    const repeated = await request(app).post('/api/procedural-memories').send({
      ...ids, userId: 'other-user', key: 'customer-format',
      instruction: 'Please always display customer names in a table.',
    }).expect(200);
    expect(repeated.body.status).toBe('already_exists');
    expect(repeated.body.memory).toEqual(first.body.memory);
    expect(repeated.body.message).toContain(first.body.memory.content);
    const stored = await request(app).post('/api/memories').send({ ...ids, type: 'procedural' }).expect(200);
    expect(stored.body.memories).toHaveLength(1);
    expect(stored.body.memories[0]).toMatchObject({
      id: first.body.memory.id, userId: ids.userId, content: first.body.memory.content,
      updatedAt: first.body.memory.updatedAt,
    });
  });

  it('shows an existing semantic fact without updating it for an equivalent repeat', async () => {
    const ids = scope();
    const model = {
      invoke: async (messages: BaseMessage[]) => {
        const input = JSON.parse(String(messages.at(-1)?.content)) as { original: string };
        return new AIMessage(JSON.stringify({
          content: input.original.includes('employed')
            ? 'Ahmed Khan works at SalesTeq in the IT industry!'
            : 'Ahmed Khan works at SalesTeq in the IT industry.',
          equivalentMemoryId: null,
        }));
      },
      bindTools: mockModel.bindTools,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    await request(app).post('/api/chat').send({ ...ids,
      message: 'Remember that Ahmed Khan works at SalesTeq in the IT industry.',
    }).expect(200);
    const before = await request(app).post('/api/memories').send({ ...ids, type: 'semantic' }).expect(200);
    const existing = before.body.memories[0];
    const repeated = await request(app).post('/api/chat').send({
      ...ids, userId: 'other-user', threadId: randomUUID(),
      message: 'Remember that Ahmed Khan is employed by SalesTeq in IT.',
    }).expect(200);
    expect(repeated.body.memoryWrite.semantic).toBe('already_exists');
    expect(repeated.body.memoryWrite.existingMemory).toEqual({ id: existing.id, content: existing.content });
    expect(repeated.body.response).toContain(existing.content);
    const after = await request(app).post('/api/memories').send({ ...ids, type: 'semantic' }).expect(200);
    expect(after.body.memories).toEqual(before.body.memories);
  });

  it('stores a corrected procedural instruction and preserves the original input', async () => {
    const id = scope();
    const model = {
      invoke: async () => new AIMessage('{"content":"Revive orders should always be processed first."}'),
      bindTools: mockModel.bindTools,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const raw = 'revive orders shold be processssed firts always.';
    const saved = await request(app).post('/api/procedural-memories').send({
      ...id, key: 'order-priority', instruction: raw,
    }).expect(200);
    expect(saved.body.memory.content).toBe('Revive orders should always be processed first.');
    const record = await pool.query<{ content: string; metadata: { originalInstruction: string } }>(
      'SELECT content, metadata FROM employee_memories WHERE id=$1', [saved.body.memory.id]);
    expect(record.rows[0]).toMatchObject({ content: 'Revive orders should always be processed first.',
      metadata: { originalInstruction: raw } });
  });

  it('accepts a JSON code fence around a valid refined memory', async () => {
    const id = scope();
    const model = {
      invoke: async () => new AIMessage('```json\n{"content":"Revive orders should always be processed first.","equivalentMemoryId":null}\n```'),
      bindTools: mockModel.bindTools,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const saved = await request(app).post('/api/procedural-memories').send({
      ...id, key: 'order-priority', instruction: 'revive orders shold be processssed firts always.',
    }).expect(200);
    expect(saved.body.memory.content).toBe('Revive orders should always be processed first.');
  });

  it('stores a corrected semantic fact from chat while retaining its source wording', async () => {
    const id = scope();
    const model = {
      invoke: async () => new AIMessage('{"content":"Ahmed Khan works at SalesTeq in the IT industry."}'),
      bindTools: mockModel.bindTools,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const raw = 'Remember that Ahmed Khan wurks at SalesTeq in the IT industrey.';
    await request(app).post('/api/chat').send({ ...id, message: raw }).expect(200);
    const record = await pool.query<{ content: string; metadata: { originalStatement: string } }>(
      "SELECT content, metadata FROM employee_memories WHERE organization_id=$1 AND employee_id=$2 AND memory_type='semantic'",
      [id.organizationId, id.employeeId]);
    expect(record.rows[0]).toMatchObject({ content: 'Ahmed Khan works at SalesTeq in the IT industry.',
      metadata: { originalStatement: raw } });
  });

  it('does not overwrite a procedure when refinement returns malformed output', async () => {
    const id = scope();
    const validModel = {
      invoke: async () => new AIMessage('{"content":"Revive orders should always be processed first."}'),
      bindTools: mockModel.bindTools,
    } as unknown as ChatBedrockConverse;
    const first = await createApp({ pool, model: validModel });
    await request(first.app).post('/api/procedural-memories').send({
      ...id, key: 'order-priority', instruction: 'revive orders shold be processssed firts always.',
    }).expect(200);
    const brokenModel = {
      invoke: async () => new AIMessage('{"content":""}'),
      bindTools: mockModel.bindTools,
    } as unknown as ChatBedrockConverse;
    const second = await createApp({ pool, model: brokenModel });
    await request(second.app).post('/api/procedural-memories').send({
      ...id, key: 'order-priority', instruction: 'Another typo-filled instruction.',
    }).expect(500);
    const stored = await request(second.app).post('/api/memories').send({ ...id, type: 'procedural' }).expect(200);
    expect(stored.body.memories).toMatchObject([{ content: 'Revive orders should always be processed first.' }]);
  });

  it('returns an existing procedure for identical wording or an equivalent paraphrase', async () => {
    const id = scope();
    let refinements = 0;
    const model = {
      invoke: async (messages: BaseMessage[]) => {
        refinements++;
        const input = JSON.parse(String(messages.at(-1)?.content)) as {
          original: string; existing: { id: string; content: string }[];
        };
        return new AIMessage(JSON.stringify({ content: 'Revive orders should always be processed first.',
          equivalentMemoryId: input.existing[0]?.id ?? null }));
      },
      bindTools: mockModel.bindTools,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const first = await request(app).post('/api/procedural-memories').send({
      ...id, key: 'priority-1', instruction: 'revive orders shold be processssed firts always.',
    }).expect(200);
    expect(first.body.status).toBe('created');
    const repeated = await request(app).post('/api/procedural-memories').send({
      ...id, key: 'priority-1', instruction: 'revive orders shold be processssed firts always.',
    }).expect(200);
    expect(repeated.body.status).toBe('already_exists');
    expect(repeated.body.message).toBe('An equivalent procedural memory already exists. No new memory was stored.');
    expect(repeated.body.memory.id).toBe(first.body.memory.id);
    const paraphrase = await request(app).post('/api/procedural-memories').send({
      ...id, userId: 'other-user', key: 'priority-2', instruction: 'Process revive orders before other orders every time.',
    }).expect(200);
    expect(paraphrase.body.status).toBe('already_exists');
    expect(paraphrase.body.message).toBe('An equivalent procedural memory already exists. No new memory was stored.');
    expect(paraphrase.body.memory.id).toBe(first.body.memory.id);
    const stored = await request(app).post('/api/memories').send({ ...id, type: 'procedural' }).expect(200);
    expect(stored.body.memories).toHaveLength(1);
    expect(stored.body.memories[0].userId).toBe(id.userId);
    expect(refinements).toBe(2);
    const otherEmployee = await request(app).post('/api/procedural-memories').send({
      ...id, employeeId: randomUUID(), key: 'priority-1',
      instruction: 'revive orders shold be processssed firts always.',
    }).expect(200);
    expect(otherEmployee.body.status).toBe('created');
    expect(otherEmployee.body.memory.id).not.toBe(first.body.memory.id);
    const otherOrganization = await request(app).post('/api/procedural-memories').send({
      ...id, organizationId: 'org-002', key: 'priority-1',
      instruction: 'revive orders shold be processssed firts always.',
    }).expect(200);
    expect(otherOrganization.body.status).toBe('created');
    expect(otherOrganization.body.memory.id).not.toBe(first.body.memory.id);
  });

  it('reports an equivalent semantic fact without adding a second employee memory', async () => {
    const id = scope();
    const model = {
      invoke: async (messages: BaseMessage[]) => {
        const input = JSON.parse(String(messages.at(-1)?.content)) as {
          original: string; existing: { id: string }[];
        };
        return new AIMessage(JSON.stringify({ content: 'Ahmed Khan works at SalesTeq in the IT industry.',
          equivalentMemoryId: input.existing[0]?.id ?? null }));
      },
      bindTools: mockModel.bindTools,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    await request(app).post('/api/chat').send({ ...id,
      message: 'Remember that Ahmed Khan works at SalesTeq in the IT industry.',
    }).expect(200);
    const repeated = await request(app).post('/api/chat').send({
      ...id, threadId: randomUUID(), userId: 'other-user',
      message: 'Remember that Ahmed Khan is employed by SalesTeq in IT.',
    }).expect(200);
    expect(repeated.body.memoryWrite.semantic).toBe('already_exists');
    expect(repeated.body.response).toBe('This fact is already stored in semantic memory.');
    const stored = await request(app).post('/api/memories').send({ ...id, type: 'semantic' }).expect(200);
    expect(stored.body.memories).toHaveLength(1);
    expect(stored.body.memories[0].userId).toBe(id.userId);
  });

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

  it('learns semantic memory in chat and applies a procedure saved through its API', async () => {
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
    expect(next.body.memoriesUsed.procedural).toHaveLength(1);
    expect(next.body.memoriesUsed.procedural[0].content).toContain('table');
    expect(next.body.response).toBe('| Customer |\n|---|\n| Ahmed Khan |\n| Bilal Shah |');
    expect(next.body.flow[2]).toMatchObject({ details: { previousMessageCount: 0 } });
    expect(next.body.flow[3].details.counts.semantic).toBeGreaterThan(0);
    const inspect = await request(app).post('/api/memories').send({ ...id, userId: 'another-user' }).expect(200);
    expect(inspect.body.memories.some((m: { type: string }) => m.type === 'episodic')).toBe(true);
    expect(inspect.body.memories.some((m: { type: string }) => m.type === 'procedural')).toBe(true);
    const isolated = await request(app).post('/api/memories').send({ ...id, employeeId: randomUUID() }).expect(200);
    expect(isolated.body.memories).toEqual([]);
  });

  it('refines a procedure through its API without calling the customer tool', async () => {
    const refiningModel = {
      invoke: async (messages: BaseMessage[]) => {
        const input = JSON.parse(String(messages.at(-1)?.content)) as { original: string };
        return new AIMessage(JSON.stringify({ content: input.original }));
      },
      bindTools: () => { throw new Error('Customer tool should not be called'); },
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model: refiningModel });
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

  it('applies a saved name prefix only after customer filters and tool results', async () => {
    const modelPrompts: BaseMessage[][] = [];
    const presentationPrompts: BaseMessage[][] = [];
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
      invoke: async (messages: BaseMessage[]) => {
        const input = JSON.parse(String(messages.at(-1)?.content)) as {
          memoryType?: string; original?: string; draftAnswer: string; preferences: { content: string }[];
        };
        if (input.memoryType) return new AIMessage(JSON.stringify({ content: input.original }));
        presentationPrompts.push(messages);
        return new AIMessage(input.preferences.some(preference => preference.content.includes('Test-'))
          ? input.draftAnswer.replaceAll('Ahmed Khan', 'Test-Ahmed Khan') : input.draftAnswer);
      },
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
    expect(result.body.response).toBe('Test-Ahmed Khan');
    expect(presentationPrompts).toHaveLength(1);
    expect(result.body.memoriesUsed.procedural).toHaveLength(1);
    expect(result.body.memoriesUsed.episodic).toEqual([]);
  });

  it('uses the stored Custo- procedure for Fetch Customers across users without changing database filters', async () => {
    const model = {
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        const last = messages.at(-1)!;
        if (last instanceof ToolMessage) {
          const result = JSON.parse(String(last.content)) as { records: { name: string }[] };
          return new AIMessage(`Customers: ${result.records.map(record => record.name).join(', ')}`);
        }
        return new AIMessage({ content: '', tool_calls: [{ name: 'get_customers', args: {}, id: randomUUID() }] });
      } }),
      invoke: async (messages: BaseMessage[]) => {
        const input = JSON.parse(String(messages.at(-1)?.content)) as {
          memoryType?: string; original?: string; draftAnswer: string; preferences: { content: string }[];
        };
        if (input.memoryType) return new AIMessage(JSON.stringify({ content: input.original }));
        if (!input.preferences.some(preference => preference.content.includes('Custo-'))) return new AIMessage(input.draftAnswer);
        return new AIMessage(input.draftAnswer.replaceAll('Ahmed Khan', 'Custo-Ahmed Khan')
          .replaceAll('Ayesha Ali', 'Custo-Ayesha Ali').replaceAll('Bilal Shah', 'Custo-Bilal Shah'));
      },
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const id = scope();
    await request(app).post('/api/procedural-memories').send({ ...id, key: 'ins-1',
      instruction: 'Always add prefix Custo- with the customer Name while fetching Customers',
    }).expect(200);
    const result = await request(app).post('/api/chat').send({
      ...id, userId: 'user-002', threadId: randomUUID(), message: 'Fetch Customers',
    }).expect(200);
    expect(result.body.toolCalls).toEqual([{ name: 'get_customers', filters: {} }]);
    expect(result.body.response).toContain('Custo-Ahmed Khan');
    expect(result.body.response).toContain('Custo-Ayesha Ali');
    expect(result.body.memoriesUsed.procedural).toMatchObject([{
      content: 'Always add prefix Custo- with the customer Name while fetching Customers',
    }]);
    const otherEmployee = await request(app).post('/api/chat').send({
      ...id, employeeId: randomUUID(), threadId: randomUUID(), message: 'Fetch Customers',
    }).expect(200);
    expect(otherEmployee.body.memoriesUsed.procedural).toEqual([]);
    expect(otherEmployee.body.response).not.toContain('Custo-');
    const otherOrganization = await request(app).post('/api/chat').send({
      ...id, organizationId: 'org-002', threadId: randomUUID(), message: 'Fetch Customers',
    }).expect(200);
    expect(otherOrganization.body.memoriesUsed.procedural).toEqual([]);
    expect(otherOrganization.body.response).not.toContain('Custo-');
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
      invoke: async (messages: BaseMessage[]) => {
        const input = JSON.parse(String(messages.at(-1)?.content)) as { original: string };
        return new AIMessage(JSON.stringify({ content: input.original }));
      },
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
