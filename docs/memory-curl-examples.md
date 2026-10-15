# Memory cURL examples

Run these requests in order after starting the app and seeding PostgreSQL. These examples use port `3001`; replace it with `3000` if you use the default `PORT`. All requests use the same organization and employee, while the recall requests use a different user and thread to demonstrate employee-level memory sharing.

`POST /api/chat` saves explicit semantic and procedural memories after a completed response. It also saves an episodic memory automatically for each completed interaction. `POST /api/memories` only reads stored memories.

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

## 3. Save a procedural preference

```sh
curl --location 'http://localhost:3001/api/chat' \
  --header 'Content-Type: application/json' \
  --data '{
    "organizationId": "org-001",
    "employeeId": "emp-memory-curl-demo",
    "userId": "user-001",
    "threadId": "procedure-write-001",
    "message": "Always display customer results in a table."
  }'
```

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

## 6. Apply the procedural preference

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

After a customer tool call, look for the saved instruction in `memoriesUsed.procedural` and check whether the final response uses a table. `memoriesUsed` shows what the model received; it does not prove which record influenced its answer.

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
