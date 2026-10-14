# LangGraph DMAS query API

A small Node.js API for division, multiplication, addition, and subtraction across two or more numbers. LangChain sends the prompt to the configured Amazon Bedrock model. LangGraph interprets the request, calculates it, and explains each step using the verified arithmetic results.

## Arithmetic tools

[server.js](./server.js) exports four distinct tools in the `arithmeticTools` object: `add`, `subtract`, `multiply`, and `divide`. Each entry has a `description`, an `args` Zod schema for `a` and `b`, and an `execute` function. The same definitions are exposed as callable LangChain tools in the `langChainTools` object. The LangGraph calculation step invokes the corresponding tool for each operation in the expression.

```js
import { arithmeticTools, langChainTools } from "./server.js";

console.log(arithmeticTools.add.description);
console.log(arithmeticTools.add.args.shape);
console.log(await langChainTools.add.invoke({ a: 5, b: 7 })); // 12
```

## Setup

Requires Node.js 20 or newer and a Bedrock API key with access to the configured model.

```sh
npm install
cp .env.example .env
```

Fill in `BEDROCK_API_KEY` in `.env`, then run:

```sh
npm start
```

## Query

```sh
curl -X POST http://localhost:3000/query \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"What is 10 divided by 2?"}'
```

Example response:

```json
{
  "operation": "divide",
  "a": 10,
  "b": 2,
  "result": 5,
  "steps": [{"a": 10, "b": 2, "operation": "divide", "result": 5}],
  "explanation": "First, 10 / 2 = 5. The final result is 5."
}
```

Multiple operations and more than two numbers are supported:

```sh
curl -X POST http://localhost:3000/query \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Add 5 and 7, then multiply by 2"}'
```

```json
{
  "expression": "(5+7)*2",
  "result": 24,
  "steps": [
    {"a": 5, "b": 7, "operation": "add", "result": 12},
    {"a": 12, "b": 2, "operation": "multiply", "result": 24}
  ],
  "explanation": "First, 5 + 7 = 12. Then, 12 * 2 = 24. The final result is 24."
}
```

Standard arithmetic precedence applies. Parentheses preserve explicit grouping and sequential instructions. Prompts must include at least two numeric values; each value must be used once. Invalid requests, ambiguous operations, and division by zero return an `error` response. `GET /health` returns `{"status":"ok"}`.

Run the local tests with `npm test`. They use a mock model and do not need a Bedrock key.

The provided API key authenticates direct Bedrock **Converse** model calls. Amazon Bedrock API keys cannot authenticate the separate Bedrock Agents Runtime API. To invoke an existing Bedrock Agent instead, you would need its agent ID, alias ID, and AWS credentials. This prototype uses the model ID you supplied directly.
