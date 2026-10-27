-- Read-only psql reference for checkpoints and memories.
-- Matches the application's storage layout as of 2026-10-27.
-- Run after connecting to the application's database in psql.
-- This file contains psql meta-commands as well as SQL queries.
--
-- Storage scopes:
--   Checkpoints and semantic facts: organization + thread.
--   Employee name preferences: organization + employee.
--   Episodic and procedural memories: organization.
--
-- Current namespace hashes use SHA-256 of JSON.stringify(...):
--   Session:      [organizationId, threadId]
--   Employee:     [organizationId, employeeId]
--   Organization: [organizationId]

-- 1. Display settings and tables.
\pset pager off
\x auto
\dt public.*

-- 2. All checkpoints.
SELECT
  thread_id AS session_id,
  checkpoint_ns,
  checkpoint_id,
  parent_checkpoint_id,
  jsonb_pretty(checkpoint) AS checkpoint,
  jsonb_pretty(metadata) AS metadata
FROM public.checkpoints
ORDER BY checkpoint_id DESC;

-- 3. Latest checkpoint for each session and checkpoint namespace.
SELECT DISTINCT ON (thread_id, checkpoint_ns)
  thread_id AS session_id,
  checkpoint_ns,
  checkpoint_id,
  jsonb_pretty(checkpoint) AS checkpoint,
  jsonb_pretty(metadata) AS metadata
FROM public.checkpoints
ORDER BY thread_id, checkpoint_ns, checkpoint_id DESC;

-- 4. Current semantic memory for every session.
-- Select the latest root checkpoint before joining its memory version.
WITH latest AS (
  SELECT DISTINCT ON (thread_id)
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    checkpoint
  FROM public.checkpoints
  WHERE checkpoint_ns = ''
  ORDER BY thread_id, checkpoint_id DESC
)
SELECT
  c.thread_id AS session_id,
  c.checkpoint_id,
  jsonb_pretty(
    convert_from(b.blob, 'UTF8')::jsonb
  ) AS semantic_memory
FROM latest AS c
JOIN public.checkpoint_blobs AS b
  ON b.thread_id = c.thread_id
 AND b.checkpoint_ns = c.checkpoint_ns
 AND b.channel = 'semanticMemory'
 AND b.version = (
   c.checkpoint -> 'channel_versions' ->> 'semanticMemory'
 )
WHERE b.type = 'json'
ORDER BY c.thread_id;

-- 5. All historical semantic-memory versions.
-- Facts may repeat across versions; version is TEXT, not a timestamp.
SELECT
  thread_id AS session_id,
  checkpoint_ns,
  version,
  jsonb_pretty(
    convert_from(blob, 'UTF8')::jsonb
  ) AS semantic_memory
FROM public.checkpoint_blobs
WHERE channel = 'semanticMemory'
  AND type = 'json'
ORDER BY thread_id, checkpoint_ns;

-- 6. Employee-specific name preferences.
-- These are stored separately from session semantic facts.
SELECT
  namespace_path,
  key AS preference_key,
  jsonb_pretty(value) AS preference,
  updated_at
FROM public.store
WHERE namespace_path LIKE 'employee-profile-v1:%'
  AND (
    expires_at IS NULL
    OR expires_at > CURRENT_TIMESTAMP
  )
ORDER BY namespace_path, key;

-- 7a. All episodic memories, including execution steps.
-- Current storage uses one record per episode, retaining up to five
-- episodes per organization, ordered by the store's created_at.
SELECT
  namespace_path,
  key AS episode_id,
  jsonb_pretty(value) AS episodic_memory,
  created_at
FROM public.store
WHERE namespace_path LIKE 'episodes-org-v1:%'
  AND (
    expires_at IS NULL
    OR expires_at > CURRENT_TIMESTAMP
  )
ORDER BY created_at DESC;

-- 7b. Compact episodic-memory view.
SELECT
  namespace_path,
  key AS episode_id,
  value ->> 'employeeId' AS employee_id,
  value ->> 'threadId' AS thread_id,
  value ->> 'prompt' AS prompt,
  value ->> 'outcome' AS outcome,
  value ->> 'createdAt' AS episode_time
FROM public.store
WHERE namespace_path LIKE 'episodes-org-v1:%'
  AND (
    expires_at IS NULL
    OR expires_at > CURRENT_TIMESTAMP
  )
ORDER BY created_at DESC;

-- 8a. All procedural memories.
SELECT
  namespace_path,
  key AS procedure_id,
  jsonb_pretty(value) AS procedural_memory,
  updated_at
FROM public.store
WHERE namespace_path LIKE 'procedural-org-v1:%'
  AND (
    expires_at IS NULL
    OR expires_at > CURRENT_TIMESTAMP
  )
ORDER BY updated_at DESC;

-- 8b. Procedural memories for one organization.
-- Replace ORG-001 with the desired organization ID.
SELECT
  key AS procedure_id,
  value ->> 'title' AS title,
  value ->> 'instructions' AS instructions,
  value ->> 'employeeId' AS saved_by,
  updated_at
FROM public.store
WHERE namespace_path LIKE 'procedural-org-v1:%'
  AND value ->> 'organizationId' = 'ORG-001'
  AND (
    expires_at IS NULL
    OR expires_at > CURRENT_TIMESTAMP
  )
ORDER BY updated_at DESC;

-- 9a. Checkpoint channel blobs and their versions.
SELECT
  thread_id,
  checkpoint_ns,
  channel,
  version,
  type,
  octet_length(blob) AS blob_bytes
FROM public.checkpoint_blobs
ORDER BY thread_id, checkpoint_ns, channel;

-- 9b. Node writes associated with checkpoints.
SELECT
  thread_id,
  checkpoint_ns,
  checkpoint_id,
  task_id,
  idx,
  channel,
  type,
  octet_length(blob) AS blob_bytes
FROM public.checkpoint_writes
ORDER BY checkpoint_id DESC, task_id, idx;

-- 10. Everything in the memory store.
-- Includes older namespaces and expired records for inspection.
SELECT
  namespace_path,
  key,
  jsonb_pretty(value) AS memory,
  created_at,
  updated_at,
  expires_at
FROM public.store
ORDER BY namespace_path, updated_at DESC;
