# Chat Memory API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the agreed `/chat` LangGraph flow with Semantic Memory approval, dynamic read/write tools, Episodic Memory, and durable Postgres checkpoints.

**Architecture:** Keep the small `src/` layout agreed with the user. LangGraph owns routing and paused approvals; a tool registry dispatches calls by name; a memory adapter separates Semantic, Procedural, and Episodic data from thread checkpoints.

**Tech Stack:** TypeScript, Express, LangGraph, Bedrock, Postgres, Vitest.

**Spec:** The flowchart and follow-up decisions in this conversation; no separate document exists.

## Global Constraints

- Semantic writes require an interrupt after similar-memory search. No match offers create; a match offers update one or more or create new.
- A Semantic edit returns to the front of the candidate queue and is searched again.
- Tool writes require a fully populated, frozen preview before approval; reads can execute without approval.
- `prepareWriteProposal` and `recordEpisode` are each one graph node.
- A newly registered tool becomes available through the registry without per-tool branches in the graph.
- Procedural writes belong to `/memory`; checkpointing is infrastructure, not a graph node.
- Keep the source tree small and do not depend on live Bedrock credentials in tests.

## Review Focus

- A resume for a different user must be rejected before any write.
- A changed or unknown approved option must not write.
- Failed similarity search must not create a Semantic Memory.
- Invalid write-tool arguments must not reach approval or execution.
- Declined writes must never execute, including on repeated resume requests.

---

### Task 1: Tool registry and proposal

**Files:** `src/tools/index.ts`, `src/tools/server-time.ts`, `src/task.ts`, `tests/tools.test.ts`

**Interfaces:** Registry exposes metadata, authorization, schema validation, and generic dispatch. Write proposal carries exact calls and preview.

- [x] Write failing tests for a newly registered read tool and invalid/missing write arguments.
- [x] Run the tests and confirm the expected failure.
- [x] Implement the registry and one safe built-in read tool.
- [x] Run the tests and confirm they pass.

### Task 2: Memory storage and Semantic choices

**Files:** `src/memory.ts`, `src/semantic.ts`, `src/db/postgres.ts`, `src/db/create-test-db.sql`, `tests/semantic.test.ts`

**Interfaces:** Memory adapter searches and writes user-scoped Semantic records, retrieves Procedural/Episodic records, and stores episodes. Semantic helpers stage exact create/update alternatives.

- [x] Write failing tests for no-match, matched-memory alternatives, editing/requeue, and declined writes.
- [x] Run the tests and confirm the expected failure.
- [x] Implement memory and Semantic helpers, including Postgres-backed runtime storage.
- [x] Run the tests and confirm they pass.

### Task 3: LangGraph workflow

**Files:** `src/graph.ts`, `src/task.ts`, `tests/graph.test.ts`

**Interfaces:** `createChatGraph(deps)` compiles a checkpointer-backed graph. An injected model interface allows offline tests; runtime uses Bedrock.

- [x] Write failing graph tests for Semantic approvals, task read calls, tool-write approval/decline, and one Episodic write.
- [x] Run the tests and confirm the expected failure.
- [x] Implement graph nodes and routing.
- [x] Run the tests and confirm they pass.

### Task 4: HTTP and runtime wiring

**Files:** `src/server.ts`, `src/llm.ts`, `src/db/postgres.ts`, `package.json`, `tsconfig.json`, `.env.example`, `docker-compose.yml`, `tests/server.test.ts`

**Interfaces:** `POST /chat` starts a run, `POST /chat/:threadId/resume` resumes a paused approval, and `POST /memory` stores Procedural Memory. Runtime initializes Postgres checkpointer/store and Bedrock model.

- [x] Write failing HTTP tests for prompt, approval resume, user mismatch, and Procedural Memory.
- [x] Run the tests and confirm the expected failure.
- [x] Implement routes and bootstrap, then typecheck.
- [x] Run full offline tests and typecheck. Live Postgres and Bedrock checks remain outside this run because the database was intentionally left stopped.
