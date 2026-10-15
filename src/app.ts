import { randomUUID } from 'node:crypto';
import express from 'express';
import { z, ZodError } from 'zod';
import type pg from 'pg';
import type { ChatBedrockConverse } from '@langchain/aws';
import { createPool } from './db/postgres.js';
import { loadEnv, type Env } from './config/env.js';
import { createModel } from './agent/model.js';
import { createAgent } from './agent/graph.js';

const identifier = z.string().refine(value => value.trim().length > 0, 'Required nonempty string');
const baseRequest = z.object({ organizationId: identifier, employeeId: identifier, userId: identifier });
const chatRequest = baseRequest.extend({ threadId: identifier.optional(), message: identifier });
const memoryRequest = baseRequest.extend({ type: z.enum(['semantic','episodic','procedural']).optional() });

export async function createApp(options: { pool?: pg.Pool; model?: ChatBedrockConverse; env?: Env } = {}) {
  const env = options.env ?? loadEnv();
  const pool = options.pool ?? createPool(env.DATABASE_URL);
  const agent = createAgent(pool, options.model ?? createModel(env), env.MEMORY_LIMIT);
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
        memories: records.map(({ id, content, memory_type, created_at, updated_at, user_id, thread_id }) =>
          ({ id, content, type: memory_type, createdAt: created_at, updatedAt: updated_at, userId: user_id, threadId: thread_id })) });
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
