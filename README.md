# LangGraph employee memory POC

A TypeScript REST service with one LangGraph agent, one PostgreSQL customer tool, AWS Bedrock Qwen, PostgreSQL checkpoints, and employee-scoped semantic, episodic, and procedural memory.

## Setup on another system

Install Node.js 24 and Docker Compose first. This project uses pnpm 12.4.2.

On your current system, commit any local changes you want to transfer, then push the branch before cloning elsewhere:

```sh
git push -u origin codex/bedrock-employee-memory
```

On the other system, clone the branch and install dependencies:

```sh
git clone -b codex/bedrock-employee-memory https://github.com/kamran186/langchain.git
cd langchain
npm install -g pnpm@12.4.2
pnpm install
cp .env.example .env
```

Set `BEDROCK_API_KEY` in `.env` to a Bedrock bearer API key with access to the configured Qwen model. The key is passed as `bedrockBearerToken`; AWS access-key credentials are not needed. The example configuration uses port 3000 and a local PostgreSQL container.

Start PostgreSQL, initialize and seed the database, and start the app:

```sh
docker compose up -d
pnpm db:init
pnpm db:seed
pnpm dev
```

In another terminal, check the app and run the tests:

```sh
curl http://localhost:3000/health
pnpm test
pnpm typecheck
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp .env.example .env`. If port 3000 is in use, set `PORT=3001` in `.env` and use port 3001 in the health check and API examples.

`pnpm test` uses `langgraph_memory_test`, a separate database created by the Compose container on its first initialization. It refuses to run against the development database. If a PostgreSQL volume predates this project, create the test database once with `docker compose exec postgres psql -U postgres -d postgres -c 'CREATE DATABASE langgraph_memory_test'`.

`pnpm test:bedrock` is a separate live test that invokes the configured Qwen model with the native customer tool schema. It requires a valid Bedrock key and is excluded from `pnpm test`.

## API examples

For a complete sequence that saves and recalls chat memories and manages procedural records, see [Memory cURL examples](docs/memory-curl-examples.md).
For the PostgreSQL retrieval and API flow of each memory type, see [Memory search flowcharts](docs/memory-search-flowcharts.md).

The IDs are caller supplied and preserved. This unauthenticated POC trusts the caller for identity; it does not provide authorization. Omit `threadId` to generate and return a new one.

Search customers:

```sh
curl -s http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-001","employeeId":"emp-001","userId":"user-001","threadId":"thread-001","message":"Get all active customers from Karachi"}'
```

Continue the same conversation:

```sh
curl -s http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-001","employeeId":"emp-001","userId":"user-001","threadId":"thread-001","message":"Which of those customers have email addresses?"}'
```

Teach a semantic fact through chat, then save a procedure through its dedicated API:

```sh
curl -s http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-001","employeeId":"emp-001","userId":"user-001","threadId":"fact-001","message":"Remember that customer ABC belongs to healthcare"}'

curl -s http://localhost:3000/api/procedural-memories -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-001","employeeId":"emp-001","userId":"user-001","threadId":"preference-001","key":"customer-format","instruction":"Always display customer results in a table"}'
```

Recall from another thread and user of the same employee:

```sh
curl -s http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-001","employeeId":"emp-001","userId":"user-002","threadId":"thread-002","message":"What industry is customer ABC in? Then show active customers."}'
```

Inspect memory or check another employee's isolated view:

```sh
curl -s http://localhost:3000/api/memories -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-001","employeeId":"emp-001","userId":"user-002"}'

curl -s http://localhost:3000/api/memories -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-001","employeeId":"emp-002","userId":"user-002"}'

curl -s http://localhost:3000/health
```

`POST /api/chat` returns the IDs, generated or supplied `threadId`, final response, actual validated tool calls, semantic and episodic `memoriesUsed` arrays, and an ordered `flow` array for inspection in Postman. Each flow entry has a one-based `step`, `stage`, `component` (`API`, `LangGraph`, `Memory`, `LangChain`, or `LLM Agent`), `status`, and optional `details`. It records request validation, thread resolution, checkpoint retrieval, memory retrieval, each LangChain model invocation and agent decision, each actual tool execution and result return, memory persistence, checkpoint persistence, and response readiness. Tool entries distinguish `success`, `empty`, and `failure`; memory entries report actual saved update counts. The flow is execution metadata, not the model's private reasoning. `memoriesUsed` lists records supplied to the model; it does not prove which records influenced its reasoning. `POST /api/memories` is an employee-wide inspection view filtered by organization and employee, not user.

`POST /api/procedural-memories` accepts `organizationId`, `employeeId`, `userId`, optional `threadId`, a stable caller-supplied `key`, and an `instruction`. It inserts or replaces that employee's procedure by key and returns the stored record. It does not invoke Bedrock or create a chat checkpoint. Read procedures and their keys with `POST /api/memories` and `"type":"procedural"`. Chat rejects reusable procedure instructions with HTTP 400 and does not load or apply stored procedures.

## How it works

The chat graph follows `START → loadMemories → agent → executeTool ↔ agent → saveMemories → END`. `executeTool` runs only on a native `get_customers` model tool call. Its organization scope comes from the validated request, never the tool schema. Chat loads semantic facts and episodes, excluding legacy procedure-instruction episodes and checkpoint turns from earlier versions. It never queries, supplies, or returns procedural memory. The model sees a maximum of 20 recent checkpointed messages plus at most five records of each chat memory category. All long-term memory queries include both organization and employee IDs.

After a final chat response, the service writes a deterministic episode from the actual request and tool execution evidence. It stores semantic facts only from explicit `Remember that ...` or customer-fact statements. These conservative rules avoid promoting tool data or model guesses into permanent facts. A temporary request instruction is left in the conversation only. Stable keys update equivalent semantic facts in the same employee scope. The originating user and thread are recorded for inspection but do not restrict recall.

PostgreSQL checkpoints use a SHA-256 key of the exact organization, employee, user, and thread tuple. The original identifiers remain unchanged in responses and memory records. The `PostgresSaver` creates and migrates its own checkpoint tables during startup.

The service contains four endpoints: `GET /health`, `POST /api/chat`, `POST /api/memories`, and `POST /api/procedural-memories`. It has no authentication because the request contract is intentionally an unauthenticated POC.
