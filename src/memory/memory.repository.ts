import type pg from 'pg';

export type MemoryType = 'semantic' | 'episodic' | 'procedural';
export type Scope = { organizationId: string; employeeId: string; userId: string; threadId: string | null };
export type Memory = {
  id: string; organization_id: string; employee_id: string; user_id: string;
  thread_id: string | null; memory_type: MemoryType; memory_key: string | null;
  content: string; metadata: Record<string, unknown>; created_at: Date; updated_at: Date;
};
export type Memories = { semantic: Memory[]; episodic: Memory[]; procedural: Memory[] };
export type ChatMemories = Pick<Memories, 'semantic' | 'episodic'>;

export function createMemoryRepository(pool: pg.Pool) {
  async function list(scope: Scope, type?: MemoryType): Promise<Memory[]> {
    const result = await pool.query<Memory>(
      `SELECT * FROM employee_memories WHERE organization_id=$1 AND employee_id=$2
       AND ($3::text IS NULL OR memory_type=$3) ORDER BY created_at DESC, id DESC`,
      [scope.organizationId, scope.employeeId, type ?? null]);
    return result.rows;
  }

  async function retrieve(scope: Scope, query: string, limit: number,
    types: readonly MemoryType[] = ['semantic', 'episodic', 'procedural']): Promise<Memories> {
    const result: Memories = { semantic: [], episodic: [], procedural: [] };
    for (const type of types) {
      const rows = await pool.query<Memory>(
        `SELECT * FROM employee_memories WHERE organization_id=$1 AND employee_id=$2 AND memory_type=$3
         ORDER BY CASE WHEN $4::text <> '' THEN ts_rank(to_tsvector('simple',content),plainto_tsquery('simple',$4)) ELSE 0 END DESC,
         created_at DESC, id DESC LIMIT $5`,
        [scope.organizationId, scope.employeeId, type, type === 'procedural' ? '' : query, limit]);
      result[type] = rows.rows;
    }
    return result;
  }

  async function upsert(scope: Scope, type: 'semantic' | 'procedural', key: string, content: string, metadata: Record<string, unknown> = {}): Promise<Memory> {
    const rows = await pool.query<Memory>(
      `INSERT INTO employee_memories (organization_id,employee_id,user_id,thread_id,memory_type,memory_key,content,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (organization_id,employee_id,memory_type,memory_key) WHERE memory_key IS NOT NULL
       DO UPDATE SET content=EXCLUDED.content, metadata=EXCLUDED.metadata, user_id=EXCLUDED.user_id,
         thread_id=EXCLUDED.thread_id, updated_at=now()
       RETURNING *`,
      [scope.organizationId, scope.employeeId, scope.userId, scope.threadId, type, key, content, metadata]);
    return rows.rows[0]!;
  }

  async function saveEpisode(scope: Scope, key: string, content: string, metadata: Record<string, unknown>): Promise<Memory> {
    const rows = await pool.query<Memory>(
      `INSERT INTO employee_memories (organization_id,employee_id,user_id,thread_id,memory_type,memory_key,content,metadata)
       VALUES ($1,$2,$3,$4,'episodic',$5,$6,$7)
       ON CONFLICT (organization_id,employee_id,memory_type,memory_key) WHERE memory_key IS NOT NULL
       DO UPDATE SET id=employee_memories.id RETURNING *`,
      [scope.organizationId, scope.employeeId, scope.userId, scope.threadId, key, content, metadata]);
    return rows.rows[0]!;
  }
  async function saveTurn(scope: Scope, key: string, content: string, metadata: Record<string, unknown>,
    updates: { type: 'semantic'; key: string; content: string }[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO employee_memories (organization_id,employee_id,user_id,thread_id,memory_type,memory_key,content,metadata)
         VALUES ($1,$2,$3,$4,'episodic',$5,$6,$7)
         ON CONFLICT (organization_id,employee_id,memory_type,memory_key) WHERE memory_key IS NOT NULL DO NOTHING`,
        [scope.organizationId, scope.employeeId, scope.userId, scope.threadId, key, content, metadata]);
      for (const update of updates) {
        await client.query(
          `INSERT INTO employee_memories (organization_id,employee_id,user_id,thread_id,memory_type,memory_key,content,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (organization_id,employee_id,memory_type,memory_key) WHERE memory_key IS NOT NULL
           DO UPDATE SET content=EXCLUDED.content,metadata=EXCLUDED.metadata,user_id=EXCLUDED.user_id,
             thread_id=EXCLUDED.thread_id,updated_at=now()`,
          [scope.organizationId, scope.employeeId, scope.userId, scope.threadId, update.type, update.key, update.content,
            { source: 'explicit-user-instruction' }]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  return { list, retrieve, upsert, saveEpisode, saveTurn };
}
