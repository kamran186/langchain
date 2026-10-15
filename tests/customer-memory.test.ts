import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createPool, runSqlFile } from '../src/db/postgres.js';
import { queryCustomers } from '../src/tools/get-customers.tool.js';
import { createMemoryRepository } from '../src/memory/memory.repository.js';
import { extractExplicitMemories, saveTurnMemories } from '../src/memory/memory.service.js';

let pool: pg.Pool;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/langgraph_memory_test';
  if (url === process.env.DATABASE_URL || !url.endsWith('/langgraph_memory_test')) throw new Error('Unsafe test database URL');
  pool = createPool(url);
  await runSqlFile(pool, 'schema'); await runSqlFile(pool, 'seed');
});
afterAll(async () => { await pool?.end(); });

describe('get_customers', () => {
  it('reads actual records without optional filters and limits results', async () => {
    const result = await queryCustomers(pool, 'org-001', {});
    expect(result.totalMatched).toBe(3);
    expect(result.records).toHaveLength(3);
    expect(result.appliedFilters.limit).toBe(10);
    expect((await queryCustomers(pool, 'org-001', { limit: 1 })).records).toHaveLength(1);
    await expect(queryCustomers(pool, 'org-001', { limit: 51 })).rejects.toThrow();
  });
  it('combines filters and handles zero results', async () => {
    const found = await queryCustomers(pool, 'org-001', { city: 'karachi', status: 'active', name: 'Ahmed' });
    expect(found.records.map(r => r.name)).toEqual(['Ahmed Khan']);
    expect((await queryCustomers(pool, 'org-001', { city: 'No Such City' })).totalMatched).toBe(0);
  });
  it('enforces organization scope despite overlapping names', async () => {
    const first = await queryCustomers(pool, 'org-001', { name: 'Ahmed Khan' });
    const second = await queryCustomers(pool, 'org-002', { name: 'Ahmed Khan' });
    expect(first.records[0]?.email).toBe('ahmed@org1.example');
    expect(second.records[0]?.email).toBe('ahmed@org2.example');
  });
});

describe('employee memories', () => {
  it('saves all three types, shares across users, and isolates employees and organizations', async () => {
    const repository = createMemoryRepository(pool);
    const id = randomUUID();
    const scope = { organizationId: `org-${id}`, employeeId: 'same', userId: 'user-a', threadId: 'one' };
    await repository.upsert(scope, 'semantic', 'customer-abc', 'Customer ABC belongs to healthcare');
    await repository.upsert(scope, 'procedural', 'customer-format', 'Display customer results in a table');
    await repository.saveEpisode(scope, 'turn:1', 'Request: find customers. Outcome: completed', {});
    const shared = await repository.retrieve({ ...scope, userId: 'user-b', threadId: 'two' }, 'customers', 5);
    expect(shared.semantic).toHaveLength(1);
    expect(shared.procedural).toHaveLength(1);
    expect(shared.episodic).toHaveLength(1);
    expect((await repository.list({ ...scope, employeeId: 'other' })).length).toBe(0);
    expect((await repository.list({ ...scope, organizationId: 'other' })).length).toBe(0);
    expect((await repository.list({ ...scope, userId: 'user-b' })).length).toBe(3);
  });
  it('updates semantic and procedural keys and deduplicates resumed episodes', async () => {
    const repository = createMemoryRepository(pool);
    const scope = { organizationId: randomUUID(), employeeId: 'e', userId: 'u', threadId: 't' };
    const oldFact = await repository.upsert(scope, 'semantic', 'abc', 'ABC is healthcare');
    const newFact = await repository.upsert(scope, 'semantic', 'abc', 'ABC is finance');
    expect(newFact.id).toBe(oldFact.id);
    await repository.upsert(scope, 'procedural', 'format', 'Use a table');
    await repository.upsert(scope, 'procedural', 'format', 'Use a list');
    await repository.saveEpisode(scope, 'turn:1', 'Succeeded', {});
    await repository.saveEpisode(scope, 'turn:1', 'Succeeded', {});
    expect((await repository.list(scope)).map(m => m.content)).toEqual(['Succeeded', 'Use a list', 'ABC is finance']);
  });
  it('extracts only explicit reusable user statements', () => {
    expect(extractExplicitMemories('Remember that customer ABC belongs to healthcare')[0]?.type).toBe('semantic');
    expect(extractExplicitMemories('Always display customer results in a table')[0]?.key).toBe('customer-format');
    expect(extractExplicitMemories('Always display customer results as a list')[0]?.key).toBe('customer-format');
    expect(extractExplicitMemories('Remember that customer ABC belongs to finance')[0]?.key).toBe(extractExplicitMemories('Remember that customer ABC belongs to healthcare')[0]?.key);
    expect(extractExplicitMemories('Remember that customer ABC prefers Karachi')[0]?.key).not.toBe(extractExplicitMemories('Remember that customer ABC belongs to healthcare')[0]?.key);
    expect(extractExplicitMemories('For this request, use a table')).toEqual([]);
    expect(extractExplicitMemories('Get active customers')).toEqual([]);
  });
  it('keeps unrelated facts and updates equivalent facts without duplicate episodes', async () => {
    const repository = createMemoryRepository(pool);
    const scope = { organizationId: randomUUID(), employeeId: 'e', userId: 'u', threadId: 't' };
    await saveTurnMemories(repository, scope, 'turn-1', 'Remember that customer ABC belongs to healthcare', []);
    await saveTurnMemories(repository, scope, 'turn-2', 'Remember that customer ABC prefers Karachi', []);
    await saveTurnMemories(repository, scope, 'turn-3', 'Remember that customer ABC belongs to finance', []);
    await saveTurnMemories(repository, scope, 'turn-3', 'Remember that customer ABC belongs to finance', []);
    const facts = await repository.list(scope, 'semantic');
    expect(facts.map(fact => fact.content).sort()).toEqual(['customer ABC belongs to finance', 'customer ABC prefers Karachi']);
    expect(await repository.list(scope, 'episodic')).toHaveLength(3);
  });
  it('replaces a conflicting presentation procedure', async () => {
    const repository = createMemoryRepository(pool);
    const scope = { organizationId: randomUUID(), employeeId: 'e', userId: 'u', threadId: 't' };
    await saveTurnMemories(repository, scope, 'one', 'Always display customer results in a table', []);
    await saveTurnMemories(repository, scope, 'two', 'Always display customer results as a list', []);
    expect((await repository.list(scope, 'procedural')).map(item => item.content)).toEqual(['display customer results as a list']);
  });
});
