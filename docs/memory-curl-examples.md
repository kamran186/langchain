# Memory cURL examples

Run these requests in order after starting the app and seeding PostgreSQL. These examples use port `3001`; replace it with `3000` if you use the default `PORT`. All requests use the same organization and employee, while the recall requests use a different user and thread to demonstrate employee-level memory sharing.

`POST /api/chat` saves explicit semantic facts and an episodic memory after each completed interaction. Save or update procedural memory through `POST /api/procedural-memories`; chat then loads it for final response presentation. `POST /api/memories` only reads stored memories.

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

This endpoint stores the procedure without calling Bedrock. Chat can apply it on later turns.

## 4. Replace the procedural preference

Use the same organization, employee, and `key`. The newer instruction replaces the earlier table preference rather than creating another procedure.

```sh
curl --location 'http://localhost:3001/api/procedural-memories' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-002",
    "threadId": "procedure-update-001",
    "key": "customer-format",
    "instruction": "Always add prefix Custo- with the customer Name while fetching Customers"
  }'
```

## 5. Inspect the stored procedural memory

```sh
curl --location 'http://localhost:3001/api/memories' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-002",
    "type": "procedural"
  }'
```

Look for one `customer-format` record containing the newer `Custo-` instruction. The `userId` in this request identifies the requester; it does not filter employee memory by the user who saved it.

## 6. Recall the semantic fact from another thread and user

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

## 7. Recall the previous search episode

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

## 8. Fetch customers with the saved procedure

```sh
curl --location 'http://localhost:3001/api/chat' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-002",
    "threadId": "procedure-read-001",
    "message": "Fetch Customers"
  }'
```

The response includes `memoriesUsed.procedural` with the saved record. Customer names in the final response should have `Custo-` added for display, while the actual `get_customers` filters in `toolCalls` do not contain that prefix. Chat still does not create or update procedural memory; use the dedicated API for writes.

## 9. Inspect all stored memories

```sh
curl --location 'http://localhost:3001/api/memories' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-002"
  }'
```

To inspect semantic or episodic records separately, use the optional `type` field. The procedural example in step 5 uses the same filter.

```sh
curl --location 'http://localhost:3001/api/memories' \
  --header 'Content-Type: application/json' \
  --data '{"organizationId":"org-001","employeeId":"emp-memory-curl-demo","userId":"user-002","type":"semantic"}'

curl --location 'http://localhost:3001/api/memories' \
  --header 'Content-Type: application/json' \
  --data '{"organizationId":"org-001","employeeId":"emp-memory-curl-demo","userId":"user-002","type":"episodic"}'
```
