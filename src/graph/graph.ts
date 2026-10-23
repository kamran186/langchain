import { END, START, StateGraph } from "@langchain/langgraph";
import { toolsCondition } from "@langchain/langgraph/prebuilt";

import { checkpointer, memoryStore } from "./checkpointer.js";
import { formatResponseNode } from "./nodes/format-response.js";
import { llmNode } from "./nodes/llm.js";
import {
  episodicMemoryNode,
  respondNode,
  semanticMemoryNode,
} from "./nodes/memory.js";
import { normalizePromptNode } from "./nodes/normalize-prompt.js";
import { polishPromptNode } from "./nodes/polish-prompt.js";
import { toolsNode } from "./nodes/tools.js";
import { AgentState } from "./state.js";

export const agent = new StateGraph(AgentState)
  .addNode("normalize", normalizePromptNode)
  .addNode("polish", polishPromptNode)
  .addNode("semantic_memory", semanticMemoryNode)
  .addNode("llm", llmNode)
  .addNode("tools", toolsNode)
  .addNode("respond", respondNode)
  .addNode("format_response", formatResponseNode)
  .addNode("episodic_memory", episodicMemoryNode)

  .addEdge(START, "normalize")
  .addEdge("normalize", "polish")

  .addConditionalEdges("polish", (state) => state.intent, {
    semantic_memory: "semantic_memory",
    mixed: "semantic_memory",
    read: "semantic_memory",
    question: "semantic_memory",
    write: "respond",
    approval: "respond",
    clarification: "respond",
    unclear: "respond",
  })

  .addConditionalEdges("semantic_memory", (state) => state.intent, {
    semantic_memory: "respond",
    mixed: "llm",
    read: "llm",
    question: "llm",
  })

  .addConditionalEdges("llm", toolsCondition, {
    tools: "tools",
    [END]: "format_response",
  })

  .addEdge("tools", "llm")
  .addEdge("respond", "format_response")

  .addConditionalEdges("format_response", (state) => state.intent, {
    read: "episodic_memory",
    question: "episodic_memory",
    mixed: "episodic_memory",
    semantic_memory: END,
    write: END,
    approval: END,
    clarification: END,
    unclear: END,
  })

  .addEdge("episodic_memory", END)
  .compile({
    checkpointer,
    store: memoryStore,
  });