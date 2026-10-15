# Memory cURL examples

Run these requests in order after starting the app and seeding PostgreSQL. These examples use port `3001`; replace it with `3000` if you use the default `PORT`. All requests use the same organization and employee, while the recall requests use a different user and thread to demonstrate employee-level memory sharing.

`POST /api/chat` saves explicit semantic facts and an episodic memory after each completed interaction. Save or update procedural memory through `POST /api/procedural-memories`; chat does not load or apply it. `POST /api/memories` only reads stored memories.

## 1. Save a semantic fact

```sh
curl --location 'http://localhost:3001/api/chat' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-001",
    "threadId": "semantic-write-001",
    "message": "Remember that Ahmed Khan works at SalesTeq in the IT industry."
  }'
```

## 2. Create an episode from a real customer search

```sh
curl --location 'http://localhost:3001/api/chat' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-001",
    "threadId": "episode-write-001",
    "message": "Get all active customers from Karachi."
  }'
```

After the response completes, its episode records the request, any executed `get_customers` filters, and the actual outcome.

## 3. Save a procedural preference through its API

```sh
curl --location 'http://localhost:3001/api/procedural-memories' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-001",
    "threadId": "procedure-write-001",
    "key": "customer-format",
    "instruction": "Always display customer results in a table."
  }'
```

Send the same `key` with a new `instruction` to replace this procedure for the same organization and employee. This endpoint does not call Bedrock.

## 4. Recall the semantic fact from another thread and user

```sh
curl --location 'http://localhost:3001/api/chat' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-002",
    "threadId": "semantic-read-001",
    "message": "What company and industry does Ahmed Khan work in?"
  }'
```

Look for the saved fact in `memoriesUsed.semantic`.

## 5. Recall the previous search episode

```sh
curl --location 'http://localhost:3001/api/chat' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-002",
    "threadId": "episode-read-001",
    "message": "What happened when we previously searched for active customers in Karachi?"
  }'
```

Look for the earlier customer search in `memoriesUsed.episodic`.

## 6. Verify that chat does not use the procedure

```sh
curl --location 'http://localhost:3001/api/chat' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-002",
    "threadId": "procedure-read-001",
    "message": "Show active customers from Karachi."
  }'
```

The chat response has only `memoriesUsed.semantic` and `memoriesUsed.episodic`. The saved procedure is not loaded, supplied to the model, or applied to this answer.

## 7. Inspect all stored memories

```sh
curl --location 'http://localhost:3001/api/memories' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-002"
  }'
```

To inspect one category at a time, use the optional `type` field:

```sh
curl --location 'http://localhost:3001/api/memories' \
  --header 'Content-Type: application/json' \
  --data '{"organizationId":"org-001","employeeId":"emp-memory-curl-demo","userId":"user-002","type":"semantic"}'

curl --location 'http://localhost:3001/api/memories' \
  --header 'Content-Type: application/json' \
  --data '{"organizationId":"org-001","employeeId":"emp-memory-curl-demo","userId":"user-002","type":"episodic"}'

curl --location 'http://localhost:3001/api/memories' \
  --header 'Content-Type: application/json' \
  --data '{"organizationId":"org-001","employeeId":"emp-memory-curl-demo","userId":"user-002","type":"procedural"}'
```
