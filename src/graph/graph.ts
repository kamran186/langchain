import {
  END,
  START,
  StateGraph,
} from "@langchain/langgraph";

import {
  toolsCondition,
} from "@langchain/langgraph/prebuilt";

import {
  checkpointer,
  memoryStore,
} from "./checkpointer.js";

import {
  filterMemoryNode,
} from "./nodes/filter-memory.js";

import { llmNode } from "./nodes/llm.js";

import {
  episodicMemoryNode,
  respondNode,
  semanticMemoryNode,
} from "./nodes/memory.js";

import {
  normalizePromptNode,
} from "./nodes/normalize-prompt.js";

import {
  polishPromptNode,
} from "./nodes/polish-prompt.js";

import { toolsNode } from "./nodes/tools.js";
import { AgentState } from "./state.js";

export const agent = new StateGraph(AgentState)
  .addNode("prepare", normalizePromptNode)
  .addNode("filter_memory", filterMemoryNode)
  .addNode("polish", polishPromptNode)
  .addNode("semantic_memory", semanticMemoryNode)
  .addNode("llm", llmNode)
  .addNode("tools", toolsNode)
  .addNode("respond", respondNode)
  .addNode("episodic_memory", episodicMemoryNode)

  .addEdge(START, "prepare")
  .addEdge("prepare", "filter_memory")
  .addEdge("filter_memory", "polish")

  .addConditionalEdges(
    "polish",
    (state) => state.intent,
    {
      semantic_memory: "semantic_memory",
      mixed: "semantic_memory",
      read: "semantic_memory",
      question: "semantic_memory",
      write: "respond",
      approval: "respond",
      clarification: "respond",
      unclear: "respond",
    },
  )

  .addConditionalEdges(
    "semantic_memory",
    (state) => state.intent,
    {
      semantic_memory: "respond",
      mixed: "llm",
      read: "llm",
      question: "llm",
    },
  )

  .addConditionalEdges(
    "llm",
    toolsCondition,
    {
      tools: "tools",
      [END]: "episodic_memory",
    },
  )

  .addEdge("tools", "llm")
  .addEdge("respond", "episodic_memory")
  .addEdge("episodic_memory", END)

  .compile({
    checkpointer,
    store: memoryStore,
  });