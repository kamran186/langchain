import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
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
  it('offers described tools so a natural-language request can select customer search', async () => {
    const model = {
      bindTools: (tools: { name: string; description: string; schema: unknown }[]) => {
        expect(tools.map(item => item.name).sort()).toEqual(['create_text_file', 'get_customers', 'send_dummy_mail']);
        expect(tools.every(item => item.description.length > 40 && item.schema)).toBe(true);
        const customerTool = tools.find(item => /search.*customer/i.test(item.description));
        expect(customerTool?.name).toBe('get_customers');
        return { invoke: async (messages: BaseMessage[]) => {
          expect(String(messages[0]?.content)).not.toMatch(/get_customers|create_text_file|send_dummy_mail/);
          const last = messages.at(-1)!;
          if (last instanceof ToolMessage) {
            const result = JSON.parse(String(last.content)) as { records: { name: string }[] };
            return new AIMessage(`Customers: ${result.records.map(row => row.name).join(', ')}`);
          }
          return new AIMessage({ content: '', tool_calls: [{ name: customerTool!.name,
            args: { city: 'Karachi', status: 'active' }, id: randomUUID() }] });
        } };
      },
      invoke: mockModel.invoke,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const ids = scope();
    const result = await request(app).post('/api/chat').send({ ...ids,
      message: 'Find active customers in Karachi',
    }).expect(200);
    expect(result.body.response).toBe('Customers: Ahmed Khan');
  });

  it('validates every call before running concurrent tools', async () => {
    const before = new Set(await readdir('output').catch(() => []));
    const model = {
      bindTools: () => ({ invoke: async () => new AIMessage({ content: '', tool_calls: [
        { name: 'create_text_file', args: { content: 'Do not create this file' }, id: randomUUID() },
        { name: 'send_dummy_mail', args: { receiver: 'invalid', subject: 'Hi', body: 'Hi' }, id: randomUUID() },
      ] }) }),
      invoke: mockModel.invoke,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const ids = scope();
    try {
      await request(app).post('/api/chat').send({ ...ids,
        message: 'Save this reply and prepare a dummy email',
      }).expect(400);
      expect(await readdir('output').catch(() => [])).toEqual([...before]);
    } finally {
      for (const filename of await readdir('output').catch(() => [])) {
        if (!before.has(filename)) await unlink(`output/${filename}`);
      }
    }
  });

  it('saves model supplied response text under the project output folder', async () => {
    let savedPath = '';
    const model = {
      bindTools: (tools: { name: string }[]) => {
        expect(tools.map(item => item.name).sort()).toEqual(['create_text_file', 'get_customers', 'send_dummy_mail']);
        return { invoke: async (messages: BaseMessage[]) => {
          const last = messages.at(-1)!;
          if (last instanceof ToolMessage) {
            const result = JSON.parse(String(last.content)) as { status: string; path: string };
            expect(result.status).toBe('created');
            expect(result.path).toContain('/output/');
            savedPath = result.path;
            return new AIMessage(`Customers: Ahmed Khan\nSaved to ${result.path}`);
          }
          return new AIMessage({ content: '', tool_calls: [{ name: 'create_text_file',
            args: { content: 'Customers: Ahmed Khan' }, id: randomUUID() }] });
        } };
      },
      invoke: mockModel.invoke,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const ids = scope();
    const result = await request(app).post('/api/chat').send({ ...ids, message: 'Save this response as a text file' }).expect(200);
    expect(result.body.response).toBe(`Customers: Ahmed Khan\nSaved to ${savedPath}`);
    expect(await readFile(savedPath, 'utf8')).toBe(result.body.response);
    await unlink(savedPath);
    const episode = await pool.query<{ metadata: { executions: { name: string; outcome: string }[] } }>(
      "SELECT metadata FROM employee_memories WHERE organization_id=$1 AND employee_id=$2 AND memory_type='episodic'",
      [ids.organizationId, ids.employeeId]);
    expect(episode.rows[0]?.metadata.executions).toMatchObject([{ name: 'create_text_file', outcome: 'success' }]);
  });

  it('simulates email delivery and never reports a real send', async () => {
    const model = {
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        const last = messages.at(-1)!;
        if (last instanceof ToolMessage) {
          const result = JSON.parse(String(last.content)) as { status: string; receiver: string };
          expect(result).toMatchObject({ status: 'simulated', receiver: 'receiver@example.com' });
          return new AIMessage('Dummy email prepared for receiver@example.com; no email was sent.');
        }
        return new AIMessage({ content: '', tool_calls: [{ name: 'send_dummy_mail',
          args: { receiver: 'receiver@example.com', subject: 'Customer update', body: 'Hello' }, id: randomUUID() }] });
      } }),
      invoke: mockModel.invoke,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const ids = scope();
    const result = await request(app).post('/api/chat').send({ ...ids, message: 'Send a dummy mail to receiver@example.com' }).expect(200);
    expect(result.body.response).toContain('no email was sent');
    const episode = await pool.query<{ metadata: { executions: { name: string; outcome: string }[] } }>(
      "SELECT metadata FROM employee_memories WHERE organization_id=$1 AND employee_id=$2 AND memory_type='episodic'",
      [ids.organizationId, ids.employeeId]);
    expect(episode.rows[0]?.metadata.executions).toMatchObject([{ name: 'send_dummy_mail', outcome: 'success' }]);
  });

  it('records two native tool calls from one model message', async () => {
    const fileCallId = randomUUID();
    const mailCallId = randomUUID();
    let savedPath = '';
    const model = {
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        if (messages.at(-1) instanceof ToolMessage) {
          const results = messages.slice(-2) as ToolMessage[];
          expect(results.map(item => item.tool_call_id)).toEqual([fileCallId, mailCallId]);
          savedPath = (JSON.parse(String(results[0]!.content)) as { path: string }).path;
          expect(JSON.parse(String(results[1]!.content))).toMatchObject({ status: 'simulated', sent: false });
          return new AIMessage(`Saved to ${savedPath}. Dummy email prepared; no email was sent.`);
        }
        return new AIMessage({ content: '', tool_calls: [
          { name: 'create_text_file', args: { content: 'A short answer' }, id: fileCallId },
          { name: 'send_dummy_mail', args: { receiver: 'receiver@example.com', subject: 'Update', body: 'A short answer' }, id: mailCallId },
        ] });
      } }),
      invoke: mockModel.invoke,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const ids = scope();
    const result = await request(app).post('/api/chat').send({ ...ids,
      message: 'Save an answer as a text file and prepare a dummy email to receiver@example.com',
    }).expect(200);
    expect(await readFile(savedPath, 'utf8')).toBe(result.body.response);
    await unlink(savedPath);
    const episode = await pool.query<{ metadata: { executions: { name: string; outcome: string }[] } }>(
      "SELECT metadata FROM employee_memories WHERE organization_id=$1 AND employee_id=$2 AND memory_type='episodic'",
      [ids.organizationId, ids.employeeId]);
    expect(episode.rows[0]?.metadata.executions).toMatchObject([
      { name: 'create_text_file', outcome: 'success' }, { name: 'send_dummy_mail', outcome: 'success' },
    ]);
  });

  it('runs customer lookup, text export, and dummy mail in sequence', async () => {
    let savedPath = '';
    let customerResponse = '';
    const model = {
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        const last = messages.at(-1)!;
        if (!(last instanceof ToolMessage)) return new AIMessage({ content: '', tool_calls: [{
          name: 'get_customers', args: { city: 'Karachi', status: 'active' }, id: randomUUID(),
        }] });
        const result = JSON.parse(String(last.content)) as { records?: { name: string }[]; path?: string; status?: string };
        if (last.name === 'get_customers') {
          customerResponse = `Customers: ${result.records!.map(row => row.name).join(', ')}`;
          return new AIMessage({ content: '', tool_calls: [{
            name: 'create_text_file', args: { content: customerResponse }, id: randomUUID(),
          }] });
        }
        if (last.name === 'create_text_file') {
          savedPath = result.path!;
          return new AIMessage({ content: '', tool_calls: [{
            name: 'send_dummy_mail', args: { receiver: 'receiver@example.com', subject: 'Customers', body: customerResponse }, id: randomUUID(),
          }] });
        }
        expect(result.status).toBe('simulated');
        return new AIMessage(`${customerResponse}\nSaved to ${savedPath}\nDummy email prepared for receiver@example.com; no email was sent.`);
      } }),
      invoke: mockModel.invoke,
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const ids = scope();
    const result = await request(app).post('/api/chat').send({ ...ids,
      message: 'Get active customers from Karachi, save the response as a text file, and send a dummy email to receiver@example.com',
    }).expect(200);
    expect(result.body.response).toContain('Customers: Ahmed Khan');
    expect(await readFile(savedPath, 'utf8')).toBe(result.body.response);
    await unlink(savedPath);
    const episode = await pool.query<{ metadata: { executions: { name: string; outcome: string }[] } }>(
      "SELECT metadata FROM employee_memories WHERE organization_id=$1 AND employee_id=$2 AND memory_type='episodic'",
      [ids.organizationId, ids.employeeId]);
    expect(episode.rows[0]?.metadata.executions).toMatchObject([
      { name: 'get_customers', outcome: 'success' },
      { name: 'create_text_file', outcome: 'success' },
      { name: 'send_dummy_mail', outcome: 'success' },
    ]);
  });

  it('returns only identifiers and the generated answer from chat', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const ids = scope();
    const result = await request(app).post('/api/chat').send({ ...ids,
      message: 'Get active customers from Karachi',
    }).expect(200);
    expect(result.body).toEqual({ ...ids, response: 'Customers: Ahmed Khan' });
  });

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
    const repeated = await request(app).post('/api/chat').send({
      ...ids, userId: 'other-user', threadId: randomUUID(),
      message: 'Remember that Ahmed Khan is employed by SalesTeq in IT.',
    }).expect(200);
    expect(repeated.body.response).toBe('This fact is already stored in semantic memory.');
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
    expect(repeated.body.response).toBe('This fact is already stored in semantic memory.');
    const stored = await request(app).post('/api/memories').send({ ...id, type: 'semantic' }).expect(200);
    expect(stored.body.memories).toHaveLength(1);
    expect(stored.body.memories[0].userId).toBe(id.userId);
  });

  it('runs model-selected filters through the real customer tool before final response', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const ids = scope();
    const input = { ...ids, message: 'Get active customers from Karachi' };
    const result = await request(app).post('/api/chat').send(input).expect(200);
    expect(result.body).toEqual({ ...ids, response: 'Customers: Ahmed Khan' });
    const toolMessage = prompts.at(-1)?.at(-1);
    expect(toolMessage).toBeInstanceOf(ToolMessage);
    const toolResult = JSON.parse(String(toolMessage?.content)) as { records: { name: string }[] };
    expect(toolResult.records.map(row => row.name)).toEqual(['Ahmed Khan']);
    const episode = await pool.query<{ metadata: { executions: unknown[] } }>(
      "SELECT metadata FROM employee_memories WHERE organization_id=$1 AND employee_id=$2 AND memory_type='episodic'",
      [ids.organizationId, ids.employeeId]);
    expect(episode.rows[0]?.metadata.executions).toMatchObject([{
      name: 'get_customers', filters: { city: 'Karachi', status: 'active' }, outcome: 'success', count: 1,
    }]);
  });

  it('learns semantic memory in chat and applies a procedure saved through its API', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const id = scope();
    const learned = await request(app).post('/api/chat').send({ ...id, message: 'Remember that customer ABC belongs to healthcare' }).expect(200);
    expect(learned.body.response).toBe('Acknowledged');
    await request(app).post('/api/procedural-memories').send({
      ...id, key: 'customer-format', instruction: 'Always display customer results in a table',
    }).expect(200);
    const restarted = await createApp({ pool, model: mockModel });
    const promptCount = prompts.length;
    const next = await request(restarted.app).post('/api/chat').send({ ...id, threadId: randomUUID(), userId: 'another-user', message: 'Get customers from Karachi' }).expect(200);
    expect(next.body.response).toBe('| Customer |\n|---|\n| Ahmed Khan |\n| Bilal Shah |');
    const turnPrompts = prompts.slice(promptCount);
    expect(turnPrompts.some(messages => messages.some(message =>
      String(message.content).includes('customer ABC belongs to healthcare')))).toBe(true);
    const presentation = JSON.parse(String(turnPrompts.at(-1)?.at(-1)?.content)) as {
      draftAnswer: string; preferences: { content: string }[];
    };
    expect(presentation.draftAnswer).toBe('Customers: Ahmed Khan, Bilal Shah');
    expect(presentation.preferences).toMatchObject([{ content: 'Always display customer results in a table' }]);
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
    let presentedAnswer = '';
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
        presentedAnswer = input.preferences.some(preference => preference.content.includes('Test-'))
          ? input.draftAnswer.replaceAll('Ahmed Khan', 'Test-Ahmed Khan') : input.draftAnswer;
        return new AIMessage(presentedAnswer);
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
    await request(app).post('/api/chat').send({
      ...id, threadId: randomUUID(), message: 'Find customer Ahmed Khan',
    }).expect(200);
    expect(modelPrompts.every(messages => messages.every(message => !String(message.content).includes('Test-')))).toBe(true);
    expect(presentedAnswer).toBe('Test-Ahmed Khan');
    expect(presentationPrompts).toHaveLength(1);
    const episode = await pool.query<{ metadata: { executions: unknown[] } }>(
      "SELECT metadata FROM employee_memories WHERE organization_id=$1 AND employee_id=$2 AND memory_type='episodic' ORDER BY created_at DESC LIMIT 1",
      [id.organizationId, id.employeeId]);
    expect(episode.rows[0]?.metadata.executions).toMatchObject([{
      name: 'get_customers', filters: { name: 'Ahmed Khan' }, outcome: 'success', count: 1,
    }]);
  });

  it('uses the stored Custo- procedure for Fetch Customers across users without changing database filters', async () => {
    const presentedAnswers: string[] = [];
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
        const answer = input.preferences.some(preference => preference.content.includes('Custo-'))
          ? input.draftAnswer.replaceAll('Ahmed Khan', 'Custo-Ahmed Khan')
            .replaceAll('Ayesha Ali', 'Custo-Ayesha Ali').replaceAll('Bilal Shah', 'Custo-Bilal Shah')
          : input.draftAnswer;
        presentedAnswers.push(answer);
        return new AIMessage(answer);
      },
    } as unknown as ChatBedrockConverse;
    const { app } = await createApp({ pool, model });
    const id = scope();
    await request(app).post('/api/procedural-memories').send({ ...id, key: 'ins-1',
      instruction: 'Always add prefix Custo- with the customer Name while fetching Customers',
    }).expect(200);
    await request(app).post('/api/chat').send({
      ...id, userId: 'user-002', threadId: randomUUID(), message: 'Fetch Customers',
    }).expect(200);
    expect(presentedAnswers).toHaveLength(1);
    expect(presentedAnswers[0]).toContain('Custo-Ahmed Khan');
    expect(presentedAnswers[0]).toContain('Custo-Ayesha Ali');
    const episode = await pool.query<{ metadata: { executions: unknown[] } }>(
      "SELECT metadata FROM employee_memories WHERE organization_id=$1 AND employee_id=$2 AND memory_type='episodic'",
      [id.organizationId, id.employeeId]);
    expect(episode.rows[0]?.metadata.executions).toMatchObject([{ name: 'get_customers', filters: {} }]);
    await request(app).post('/api/chat').send({
      ...id, employeeId: randomUUID(), threadId: randomUUID(), message: 'Fetch Customers',
    }).expect(200);
    await request(app).post('/api/chat').send({
      ...id, organizationId: 'org-002', threadId: randomUUID(), message: 'Fetch Customers',
    }).expect(200);
    expect(presentedAnswers).toHaveLength(1);
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
    await request(app).post('/api/chat').send({ ...id, message: 'Hello' }).expect(200);
    expect(modelPrompts.at(-1)?.some(message => String(message.content).includes('Test-'))).toBe(false);
  });

  it('restores conversation checkpoints with a new app instance and isolates user and thread', async () => {
    const id = scope();
    const historyAnswers: string[] = [];
    const historyModel = {
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        const last = String(messages.at(-1)?.content);
        if (last !== 'What was my prior request?') return new AIMessage('Acknowledged');
        const history = messages.filter(message => message instanceof HumanMessage
          && !String(message.content).startsWith('Application-supplied employee memory'))
          .map(message => String(message.content));
        const answer = history.find(text => text.includes('unique-history-')) ?? 'No prior request';
        historyAnswers.push(answer);
        return new AIMessage(answer);
      } }),
    } as unknown as ChatBedrockConverse;
    const first = await createApp({ pool, model: historyModel });
    await request(first.app).post('/api/chat').send({ ...id, message: 'unique-history-' + id.threadId }).expect(200);
    const restarted = await createApp({ pool, model: historyModel });
    await request(restarted.app).post('/api/chat').send({ ...id, message: 'What was my prior request?' }).expect(200);
    expect(historyAnswers.at(-1)).toContain('unique-history-');
    await request(restarted.app).post('/api/chat').send({ ...id, threadId: randomUUID(), message: 'What was my prior request?' }).expect(200);
    expect(historyAnswers.at(-1)).toBe('No prior request');
    await request(restarted.app).post('/api/chat').send({ ...id, userId: 'other', message: 'What was my prior request?' }).expect(200);
    expect(historyAnswers.at(-1)).toBe('No prior request');
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
    expect(result.body.response).toBe('Acknowledged');
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
    await request(app).post('/api/chat').send({ ...id, message: 'Find customers in NoSuchCity' }).expect(200);
    const inspected = await request(app).post('/api/memories').send({ ...id, type: 'episodic' }).expect(200);
    expect(inspected.body.memories[0].content).toContain('empty (0 records)');
  });

  it('returns a generated thread ID when omitted from the request', async () => {
    const { app } = await createApp({ pool, model: mockModel });
    const { threadId: _unused, ...withoutThread } = scope();
    const result = await request(app).post('/api/chat').send({ ...withoutThread, message: 'Hello' }).expect(200);
    expect(result.body.threadId).toBeTruthy();
    expect(result.body).toEqual({ ...withoutThread, threadId: result.body.threadId,
      response: 'Acknowledged' });
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
      await request(app).post('/api/chat').send({ ...id, message: 'Get active customers from Karachi' }).expect(200);
      const inspected = await request(app).post('/api/memories').send({ ...id, type: 'episodic' }).expect(200);
      expect(inspected.body.memories[0].content).toContain('tool failure');
      expect(inspected.body.memories[0].content).not.toContain('success');
    } finally {
      await isolatedPool.end();
      await pool.query(`DROP SCHEMA ${schemaName} CASCADE`);
    }
  });
});
