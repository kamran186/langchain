CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  city TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_org_filters_idx ON customers (organization_id, status, city, name);

CREATE TABLE IF NOT EXISTS employee_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread_id TEXT,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('semantic', 'episodic', 'procedural')),
  memory_key TEXT,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS employee_memories_key_idx ON employee_memories (organization_id, employee_id, memory_type, memory_key) WHERE memory_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS employee_memories_scope_recent_idx ON employee_memories (organization_id, employee_id, memory_type, created_at DESC);
CREATE INDEX IF NOT EXISTS employee_memories_search_idx ON employee_memories USING GIN (to_tsvector('simple', content));
