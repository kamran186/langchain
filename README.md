# LangGraph employee memory POC

A TypeScript REST service with one LangGraph agent, one PostgreSQL customer tool, AWS Bedrock Qwen, PostgreSQL checkpoints, and employee-scoped semantic, episodic, and procedural memory.

## Setup

Use Node.js 24 LTS, pnpm, and Docker Compose. Copy `.env.example` to `.env` and set `BEDROCK_API_KEY` to a Bedrock bearer API key with access to the configured Qwen model. The key is passed as `bedrockBearerToken`; AWS access-key credentials are not needed.

```sh
pnpm install
docker compose up -d
pnpm db:init
pnpm db:seed
pnpm dev
```

In another terminal:

```sh
pnpm test
pnpm typecheck
```

`pnpm test` uses `langgraph_memory_test`, a separate database created by the Compose container on its first initialization. It refuses to run against the development database. If a PostgreSQL volume predates this project, create the test database once with `docker compose exec postgres psql -U postgres -d postgres -c 'CREATE DATABASE langgraph_memory_test'`.

`pnpm test:bedrock` is a separate live test that invokes the configured Qwen model with the native customer tool schema. It requires a valid Bedrock key and is excluded from `pnpm test`.

## API examples

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

Teach a semantic fact and an explicit reusable procedure:

```sh
curl -s http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-001","employeeId":"emp-001","userId":"user-001","threadId":"fact-001","message":"Remember that customer ABC belongs to healthcare"}'

curl -s http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"organizationId":"org-001","employeeId":"emp-001","userId":"user-001","threadId":"preference-001","message":"Always display customer results in a table"}'
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

`POST /api/chat` returns the IDs, generated or supplied `threadId`, final response, actual validated tool calls, `memoriesUsed` arrays, and an ordered `flow` array for inspection in Postman. Each flow entry has a one-based `step`, `stage`, `component` (`API`, `LangGraph`, `Memory`, `LangChain`, or `LLM Agent`), `status`, and optional `details`. It records request validation, thread resolution, checkpoint retrieval, memory retrieval, each LangChain model invocation and agent decision, each actual tool execution and result return, memory persistence, checkpoint persistence, and response readiness. Tool entries distinguish `success`, `empty`, and `failure`; memory entries report actual saved update counts. The flow is execution metadata, not the model's private reasoning. `memoriesUsed` lists records supplied to the model; it does not prove which records influenced its reasoning. `POST /api/memories` is an employee-wide inspection view filtered by organization and employee, not user.

## How it works

The graph follows `START → loadMemories → agent → executeTool ↔ agent → saveMemories → END`. `executeTool` runs only on a native `get_customers` model tool call. Its organization scope comes from the validated request, never the tool schema. Customer lookup planning receives semantic memories and episodes unrelated to standing presentation instructions. After a tool result, the model also receives procedural memories and the remaining episodes for response generation. A standalone procedural instruction is answered by the model without a customer tool. The model sees a maximum of 20 recent checkpointed messages plus at most five records of each memory category. All long-term memory queries include both organization and employee IDs.

After a final response, the service writes a deterministic episode from the actual request and tool execution evidence. It stores semantic facts only from explicit `Remember that ...` or customer-fact statements, and procedures only from explicit reusable `Always ...`, `From now on ...`, or `In future ...` instructions. A standalone procedural instruction is acknowledged and saved without searching customers; later customer searches can use it when presenting results. These conservative rules avoid promoting tool data or model guesses into permanent facts. A temporary request instruction is left in the conversation only. Stable keys update an earlier fact or preference in the same employee scope. The originating user and thread are recorded for inspection but do not restrict recall.

PostgreSQL checkpoints use a SHA-256 key of the exact organization, employee, user, and thread tuple. The original identifiers remain unchanged in responses and memory records. The `PostgresSaver` creates and migrates its own checkpoint tables during startup.

The service contains exactly three endpoints: `GET /health`, `POST /api/chat`, and `POST /api/memories`. It has no authentication because the request contract is intentionally an unauthenticated POC.
