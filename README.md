# LangGraph chat and memory API

A small TypeScript `/chat` API with LangGraph checkpoints, Semantic Memory reviews, registered tools, and Episodic Memory. The default runtime uses Bedrock and PostgreSQL with pgvector.

## Structure

```text
src/server.ts           HTTP routes and runtime startup
src/context.ts          Organization/actor IDs and required chat session context
src/graph.ts            LangGraph nodes, routing, interrupts, resume
src/semantic.ts         Semantic match and stored-version type
src/memory-review.ts    Shared versioned batch reviews and decision validation
src/memory-batch.ts     Approved memory execution, target checks and per-ID outcomes
src/task.ts             One write preparation helper and one episode recorder
src/memory.ts           Semantic, Procedural, and Episodic Memory storage
src/llm.ts              Bedrock model adapter
src/tools/index.ts      Generic tool registry and frozen write proposals
src/tools/server-time.ts  Example registered read tool
src/db/postgres.ts      PostgreSQL checkpoint and memory setup
src/db/customers.ts     Customer table and filtered SQL queries
src/tools/customers.ts  Registered customer read and write tools
```

The checkpointer stores graph execution state, including organizationId, employeeId, userId and sessionId. Semantic Memory uses an organization/session namespace; Procedural and Episodic Memory remain in separate organization namespaces. Procedural proposal state is stored separately from searchable memories.

## Run

Use Node 24 or newer. Copy `.env.example` to `.env` and set the Bedrock credentials. The configured Bedrock account must have access to the chat and embedding models. When ready, start PostgreSQL from `docker-compose.yml`, run `npm run db:init`, then `npm run dev`. The server binds to `127.0.0.1` by default. This implementation has no end-user authentication; deploy it behind an authenticating service that supplies trusted organization context.

`npm test` runs the local tests and `npm run typecheck` checks types. Tests do not require live Bedrock or PostgreSQL.

## API

- Every request requires `organizationId`, `employeeId`, and `userId` as strings. Values are stored as supplied, including empty strings and whitespace, without ID format or existence checks. `employeeId` and `userId` are metadata, not ownership filters.
- `/chat` and `/chat/{threadId}/resume` additionally require a nonblank string `sessionId`. It is preserved exactly, so clients must consistently reuse the same value. Each thread is bound to its organization and session. Organization mismatch returns HTTP 403; session mismatch returns HTTP 409. To start another session, change `sessionId` and omit `threadId`.
- `POST /chat` accepts `prompt` and optional `threadId`. Omit `threadId` for a new conversation; provide a completed thread's ID to continue its history within the same session. Different threads in the same organization and session can retrieve the same Semantic Memories, but conversation history remains thread-specific.
- Completed chat requests return HTTP 200 with `status`, `sessionId`, `threadId`, `response`, and `results`. `results` preserves original structured tool outputs as `{ id, name, result }`. For `get_customers`, read `results[i].result.customers`, with `limit` and `offset` alongside it. No matching customers returns `customers: []` with HTTP 200.
- A pending review returns HTTP 202 with `sessionId`, `threadId`, and `review`. Tool-write reviews retain `decision: "approve" | "decline"` and the exact `proposalId`. Semantic reviews now use `reviewId` and `decisions[]`; the old per-fact `optionId` contract is replaced.

### Memory scope and processing

Semantic search, create and update are scoped to **organizationId + sessionId**. Procedural and Episodic Memory remain organization-scoped. Episodes store `sourceSessionId`; past episodes are advisory steps/outcomes and must not restore prior-session Semantic facts. Changing sessions excludes old Semantic context without deleting records.

Prompt polishing and intent classification use one LLM call with current-thread history. Memory retrieval still searches all three types in parallel. Tool selection receives only authorized names/descriptions; full schemas are resolved for the selected tools and sent to the existing agent node. Write preparation and episode recording remain single graph nodes.

### Combined Semantic review

All extracted facts are prepared and scope-checked together. Similarity searches run with bounded concurrency, then one review contains every fact and its matches. No writes occur until every item has a decision and no edited item needs another review.

`review.type` is `semantic_batch`. Its `items[]` includes `candidateId`, `version`, exact `text`, `matches` (including stored memory IDs/version tokens), `scope`, `allowedActions`, and any retained `decision`. Submit these per-item actions:

| Action | Additional fields | Effect |
| --- | --- | --- |
| `create` | None | Save the reviewed text as a new memory. Available even when matches exist. |
| `update` | `targetIds: ["matching-memory-id"]` | Replace only selected matching memories in the same scope. |
| `skip` | None | No memory write. |
| `edit` | `text` | Increment this candidate's version, recheck scope/search, and show another review. |
| `preference` | None | Replace an unsupported operation with its displayed eligible preference, then review that exact text again. |

Use the **latest** `reviewId` after partial decisions or edits. Candidate IDs stay stable; only edited candidate versions change. Unchanged approvals/skips are retained. Missing decisions return another HTTP 202 with the combined list. Duplicate/unknown IDs and invalid targets return HTTP 400; stale reviews/versions or conflicting updates to the same target return HTTP 409 before any write. If stored target content changed, edit the affected candidate (the same text is allowed) to refresh its matches and review again.

Completion returns `memoryOutcomes[]`: `candidateId`, `version`, `text`, `action`, `status` (`saved`, `updated`, `skipped`, `failed`), and `memoryIds`. An identical final approval can be retried without creating duplicate memories while that completed batch remains the thread's current result. Each item has a stable write key. Execution is per-item, not an all-or-nothing batch transaction; inspect failed items before starting another proposal.

### Combined Procedural review

`POST /memory` accepts `items: [{"text":"..."}, ...]` and returns HTTP 202 with `proposalId`, `reviewId`, and `review.items[]`. It does not require `sessionId` because rules are organization-scoped. Preview proposals, retained decisions, and per-item execution outcomes persist in the existing PostgreSQL store, separately from searchable memories.

`POST /memory/approve` accepts the same organization/actor IDs plus `proposalId`, the latest `reviewId`, and `decisions[]`. Use `approve` (also accepts `create`), `skip` (`deny`/`decline` aliases), or `edit` with new `text`. Edits require another approval; partial decisions remain pending and preserve earlier choices. Completion returns `outcomes[]` with stored memory IDs. An identical final submission returns stored outcomes without writing again.

Single-text clients are still supported: preview with `text` instead of `items`, then approve with the exact same `text` and returned `proposalId`. This is a persisted one-item batch. If edited using the batch API, use the versioned batch contract thereafter. An approval for a preview generated before this upgrade must be previewed again.

Both memory paths accept up to 100 items, with 20,000 characters per item, within the API's 256 KB request limit. The initiating actor metadata stays with approved operations; latest chat resume metadata is recorded separately in the checkpoint. The service serializes execution of a thread/proposal within one running process; it is a local proof of concept, not a distributed execution coordinator.

### cURL examples

Start a task (omit `threadId`), or continue it by adding the returned `threadId` with the same organization and session:

```bash
curl -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-1","employeeId":"employee-1","userId":"user-1","sessionId":"session-1","prompt":"Fetch customers from Karachi"}'
```

Prepare multiple Semantic facts in one request:

```bash
curl -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-1","employeeId":"employee-1","userId":"user-1","sessionId":"session-1","prompt":"Remember that I prefer jazz and I work remotely"}'
```

Approve/skip all facts together. Replace the example IDs and versions with the values in `review.items[]`:

```bash
curl -X POST http://127.0.0.1:3000/chat/THREAD_ID/resume \
  -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-1","employeeId":"employee-1","userId":"user-1","sessionId":"session-1","reviewId":"REVIEW_ID","decisions":[{"candidateId":"CANDIDATE_1","version":1,"action":"create"},{"candidateId":"CANDIDATE_2","version":1,"action":"skip"}]}'
```

Update a match using `{"candidateId":"CANDIDATE_1","version":1,"action":"update","targetIds":["MEMORY_ID"]}`. To edit, submit `{"candidateId":"CANDIDATE_1","version":1,"action":"edit","text":"I prefer live jazz"}`, then approve the returned version with the new `reviewId`.

Approve a tool-write proposal (or use `decision: "decline"` to cancel):

```bash
curl -X POST http://127.0.0.1:3000/chat/THREAD_ID/resume \
  -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-1","employeeId":"employee-1","userId":"user-1","sessionId":"session-1","decision":"approve","proposalId":"PROPOSAL_ID"}'
```

Preview and approve Procedural rules:

```bash
curl -X POST http://127.0.0.1:3000/memory \
  -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-1","employeeId":"employee-1","userId":"user-1","items":[{"text":"Always test migrations"},{"text":"Use concise replies"}]}'

curl -X POST http://127.0.0.1:3000/memory/approve \
  -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-1","employeeId":"employee-1","userId":"user-1","proposalId":"PROPOSAL_ID","reviewId":"REVIEW_ID","decisions":[{"candidateId":"RULE_1","version":1,"action":"approve"},{"candidateId":"RULE_2","version":1,"action":"skip"}]}'
```

### Existing data and deployment

No new business tables are required. The existing store/checkpointer setup is reused. Organization-only legacy Semantic records remain intact but are excluded from session searches; there is no fallback or automatic reassignment. Old threads without `sessionId` return HTTP 409 and must be replaced with new threads. Deploy updated clients together with this required-session API change.

Tool writes still display all calls, targets, fields, values, and effects before execution. Read tools run without write approval. One graph node summarizes and saves the completed task as Episodic Memory.

The registered `create_customer` tool stores name, city, country, age, email, gender, network, OrganizationId, and CreatedBy in local PostgreSQL; the database generates the customer ID. OrganizationId comes from the request's `organizationId`, and CreatedBy comes from its `userId`, including an empty value. EmployeeId is retained as request metadata. The approval preview includes OrganizationId and CreatedBy, and both are returned by create and get results as `organizationId` and `createdBy`. `get_customers` can filter every customer field, including exact OrganizationId and CreatedBy, plus age ranges, `limit`, and `offset`. Customer text filters match without case sensitivity. OrganizationId filters cannot expand access beyond the request organization. Customer email is unique within an organization.

The customer schema migration preserves existing rows and their original user ID. Legacy customer rows and memories have no known organization mapping, so they are retained without being assigned to an organization automatically.

## Add a tool

Create a tool adapter in `src/tools/` with a unique name, description, Zod input schema, `effect` (`read` or `write`), and `run`. Write tools also need `preview`, which must show the exact target, fields, values, and intended effect. Register the adapter with `tools.register(...)` in `src/server.ts`. The model then sees its schema and may select it by name; graph routing and dispatch do not need a tool-specific branch. A write adapter should honor the `idempotencyKey` passed in its context so a retry cannot duplicate an external effect.
