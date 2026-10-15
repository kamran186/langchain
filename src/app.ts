import { randomUUID } from 'node:crypto';
import express from 'express';
import { z, ZodError } from 'zod';
import type pg from 'pg';
import type { ChatBedrockConverse } from '@langchain/aws';
import { createPool } from './db/postgres.js';
import { loadEnv, type Env } from './config/env.js';
import { createModel } from './agent/model.js';
import { createAgent } from './agent/graph.js';
import { isReusableProcedureInstruction } from './memory/memory.service.js';
import { refineMemory } from './memory/refine-memory.js';

const identifier = z.string().refine(value => value.trim().length > 0, 'Required nonempty string');
const baseRequest = z.object({ organizationId: identifier, employeeId: identifier, userId: identifier });
const chatRequest = baseRequest.extend({ threadId: identifier.optional(), message: identifier });
const memoryRequest = baseRequest.extend({ type: z.enum(['semantic','episodic','procedural']).optional() });
const procedureRequest = baseRequest.extend({
  threadId: identifier.optional(),
  key: z.string().min(1).max(150).refine(value => value.trim().length > 0, 'Required nonempty string'),
  instruction: z.string().min(5).max(1000).refine(value => value.trim().length > 0, 'Required nonempty string'),
});

export async function createApp(options: { pool?: pg.Pool; model?: ChatBedrockConverse; env?: Env } = {}) {
  const env = options.env ?? loadEnv();
  const pool = options.pool ?? createPool(env.DATABASE_URL);
  const model = options.model ?? createModel(env);
  const agent = createAgent(pool, model, env.MEMORY_LIMIT);
  await agent.setup();
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok', postgres: 'connected' }); }
    catch { res.status(503).json({ status: 'unavailable', postgres: 'disconnected' }); }
  });

  app.post('/api/chat', async (req, res) => {
    try {
      const input = chatRequest.parse(req.body);
      if (isReusableProcedureInstruction(input.message)) {
        res.status(400).json({ error: 'Use POST /api/procedural-memories for reusable instructions' });
        return;
      }
      const scope = { organizationId: input.organizationId, employeeId: input.employeeId,
        userId: input.userId, threadId: input.threadId ?? randomUUID() };
      const result = await agent.chat(scope, input.message, input.threadId === undefined);
      res.json({ ...scope, ...result });
    } catch (error) { handleError(error, res); }
  });

  app.post('/api/memories', async (req, res) => {
    try {
      const input = memoryRequest.parse(req.body);
      const records = await agent.repository.list({ ...input, threadId: '' }, input.type);
      res.json({ organizationId: input.organizationId, employeeId: input.employeeId, userId: input.userId,
        memories: records.map(({ id, memory_key, content, memory_type, created_at, updated_at, user_id, thread_id }) =>
          ({ id, key: memory_key, content, type: memory_type, createdAt: created_at, updatedAt: updated_at, userId: user_id, threadId: thread_id })) });
    } catch (error) { handleError(error, res); }
  });

  app.post('/api/procedural-memories', async (req, res) => {
    try {
      const input = procedureRequest.parse(req.body);
      const scope = {
        organizationId: input.organizationId, employeeId: input.employeeId,
        userId: input.userId, threadId: input.threadId ?? null,
      };
      const exact = await agent.repository.findByOriginal(scope, 'procedural', input.instruction);
      const candidates = exact ? [] : (await agent.repository.retrieve(scope, input.instruction, 20, ['procedural'])).procedural;
      const refined = exact
        ? { content: exact.content, equivalentMemoryId: exact.id }
        : await refineMemory(model, 'procedural', input.instruction, candidates);
      const equivalent = exact ?? candidates.find(memory => memory.id === refined.equivalentMemoryId);
      const previous = await agent.repository.findByKey(scope, 'procedural', input.key);
      const status = equivalent ? 'already_exists' : previous ? 'updated' : 'created';
      const memory = equivalent ?? await agent.repository.upsert(scope, 'procedural', input.key, refined.content,
        { source: 'procedural-memory-api', originalInstruction: input.instruction });
      res.json({
        organizationId: input.organizationId, employeeId: input.employeeId,
        userId: input.userId, threadId: input.threadId ?? null,
        status,
        message: status === 'already_exists'
          ? 'An equivalent procedural memory already exists. No new memory was stored.'
          : status === 'updated' ? 'Procedural memory updated.' : 'Procedural memory saved.',
        memory: { id: memory.id, key: memory.memory_key, content: memory.content, type: memory.memory_type,
          createdAt: memory.created_at, updatedAt: memory.updated_at },
      });
    } catch (error) { handleError(error, res); }
  });
  return { app, pool, agent };
}

function handleError(error: unknown, res: express.Response) {
  if (error instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request', details: error.issues.map(issue => ({ path: issue.path, message: issue.message })) });
  } else {
    console.error('Request failed', { type: error instanceof Error ? error.name : typeof error });
    const configuration = error instanceof Error && /does not support Converse tool calling/.test(error.message);
    res.status(configuration ? 502 : 500).json({ error: configuration ? error.message : 'Request failed' });
  }
}
