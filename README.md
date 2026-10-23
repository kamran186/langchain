# LangGraph: a structured first project

A TypeScript calculator agent organized so you can learn one responsibility at a time. This follows the **Graph API** path in the [official JavaScript quickstart](https://docs.langchain.com/oss/javascript/langgraph/quickstart), using Anthropic and three arithmetic tools.

Only project files have been created. Dependencies have not been installed, and the project has not been type-checked, built, or run. No API requests have been made by this project.

## Start here

1. Read the file map below.
2. Follow [the learning path](docs/LEARNING_PATH.md) in order.
3. Complete the setup steps when you are ready to execute it.

## File map

```text
langgraph-starter/
├── README.md
├── docs/
│   └── LEARNING_PATH.md       # Study order, exercises, manual checks
├── .env.example              # Environment variable template
├── .gitignore
├── .nvmrc                    # Suggested Node.js version: 22
├── package.json              # Dependencies and commands
├── tsconfig.json             # Strict TypeScript with Node ESM
└── src/
    ├── config.ts             # Read and validate environment settings
    ├── model.ts              # Configure Claude and bind available tools
    ├── index.ts              # Accept a question and print the conversation
    ├── tools/
    │   ├── arithmetic.ts     # Tool implementations and input schemas
    │   └── index.ts          # Shared tool list and name lookup
    └── graph/
        ├── state.ts          # Messages and accumulated model-call count
        ├── routing.ts        # Choose tools or finish
        ├── graph.ts          # Assemble and compile the graph
        └── nodes/
            ├── llm.ts        # Request the next assistant message
            └── tools.ts      # Execute requests and create tool messages
```

## Setup you will perform

Use Node.js 22 or newer and an Anthropic API key. Open a terminal in this folder, then run:

```sh
npm install
cp .env.example .env
```

Edit `.env` to enter your key. The model setting defaults to `claude-sonnet-4-6`, matching the quickstart's code; choose another tool-capable Claude model if your account requires it. Provider configuration is described in the [Anthropic integration guide](https://docs.langchain.com/oss/javascript/integrations/chat/anthropic).

The LangChain packages use the `latest` tag so your first install resolves the current packages for the documented `StateSchema` API. Keep the generated `package-lock.json` to record your resolved versions; use `npm ci` for subsequent reproducible installs.

Then check and run:

```sh
npm run check
npm run dev
npm run dev -- "Multiply 6 by 7, then divide the result by 2."
```

The first example should finish with 7; the second should finish with 21. Wording and the number of model calls can vary. Inspect the printed tool requests and results as well as the final answer.

Optional compilation:

```sh
npm run build
npm start -- "Add 10 and 5."
```

## Execution flow

```text
START → llm → END                 when the assistant gives a final answer
          │
          └→ tools → llm → ...     when the assistant requests tools
```

`src/index.ts` sets a 20-step graph limit. This counts graph steps, not just model calls. State is shared during one invocation; this starter has no checkpointer or conversation storage across invocations. Read the [Graph API overview](https://docs.langchain.com/oss/javascript/langgraph/graph-api) for state, reducers, nodes, and edges.

## Useful troubleshooting

| Symptom | Next action |
| --- | --- |
| `.env` cannot be found | Copy `.env.example` to `.env` and run from this folder. |
| Missing key, authentication failure, or unavailable model | Check the key and model in `.env` and your provider account. |
| `StateSchema` or `MessagesValue` is unavailable | Confirm you installed the current LangGraph package in this folder. |
| The graph reaches its step limit | Inspect repeated tool requests and the prompt before changing `recursionLimit`. |

Installation reference: [Install LangGraph](https://docs.langchain.com/oss/javascript/langgraph/install).
