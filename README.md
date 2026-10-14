# LangGraph DMAS API

A Node.js API that interprets an arithmetic prompt with LangChain and Amazon Bedrock, calculates each operation with a separate tool, and explains every step with LangGraph.

## Project layout

| File | Responsibility |
| --- | --- |
| `server.js` | Small startup entry and public exports |
| `src/runtime.js` | Bedrock model and server configuration |
| `src/http.js` | `POST /query` and `GET /health` |
| `src/model.js` | Prompt template and model response parsing |
| `src/graph.js` | Interpret, calculate, explain, display, and optional action flow |
| `src/calculator.js` | Expression validation, precedence, and step explanations |
| `src/tools/arithmetic.js` | Four arithmetic tool definitions and LangChain wrappers |
| `src/tools/report.js` | Display, text file, and disabled email draft tools |

Every tool definition has `description`, `args` (a Zod schema), and `execute`. The arithmetic tools are `add`, `subtract`, `multiply`, and `divide`. The report tools are `display`, `saveTextFile`, and `sendMail`. `sendMail` creates a draft only; delivery is disabled.

```js
import { arithmeticTools, langChainTools } from "./server.js";

console.log(arithmeticTools.add.description);
console.log(await langChainTools.add.invoke({ a: 5, b: 7 })); // 12
```

## Setup

Requires Node.js 20 or newer and a Bedrock API key with access to the configured model.

```sh
npm install
cp .env.example .env
```

Set `BEDROCK_API_KEY` in `.env`, then start the server:

```sh
npm start
```

The defaults are `BEDROCK_REGION=us-east-1`, `BEDROCK_MODEL=qwen.qwen3-vl-235b-a22b`, `HOST=127.0.0.1`, and `PORT=3000`. `REPORTS_DIR` selects the directory for requested text files; its default is `reports/`.

## Query API

Send a JSON body to `POST /query`:

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
  "explanation": "First, 5 + 7 = 12. Then, 12 * 2 = 24. The final result is 24.",
  "display": "Prompt: Add 5 and 7, then multiply by 2\nExpression: (5+7)*2\nSteps:\n1. 5 + 7 = 12\n2. 12 * 2 = 24\nResult: 24\nExplanation: First, 5 + 7 = 12. Then, 12 * 2 = 24. The final result is 24.\n"
}
```

A request with one operation also includes `operation`, `a`, and `b` instead of `expression`. Standard arithmetic precedence applies. Parentheses preserve grouping. Prompts must contain at least two numeric values, and the interpreted expression must use each exactly once. Invalid arithmetic and division by zero return an `error` response.

### Optional actions

Optional actions run only when explicitly requested in the JSON body:

```json
{
  "prompt": "Add 5 and 7, then multiply by 2",
  "saveTextFile": true,
  "emailTo": "recipient@example.com"
}
```

- `saveTextFile: true` saves the prompt, expression, steps, result, and explanation to a new text file. The response contains `file: { "status": "saved", "path": "..." }`.
- `emailTo` creates an email draft containing the same report. The response contains `email: { "status": "disabled", "draft": { "to": "...", "subject": "DMAS calculation result", "text": "..." } }`. No email is sent.

The two options can be used together. A file save error is reported in the `file` field, while the calculation remains available in the response. `GET /health` returns `{"status":"ok"}`.

Run `npm test` to verify calculations, graph flow, and API behavior with a mock model. The tests do not need a Bedrock key.

This prototype uses the supplied model ID through Bedrock Converse. Calling an existing Bedrock Agent would require its agent ID, alias ID, and AWS credentials instead of this model configuration.
# langchain
