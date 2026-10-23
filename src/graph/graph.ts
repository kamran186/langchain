import { END, START, StateGraph } from "@langchain/langgraph";

import { llmNode } from "./nodes/llm.js";
import { polishPromptNode } from "./nodes/polish-prompt.js";
import { toolsNode } from "./nodes/tools.js";
import { routeAfterModel } from "./routing.js";
import { AgentState } from "./state.js";

export const agent = new StateGraph(AgentState)
  .addNode("polishPrompt", polishPromptNode)
  .addNode("llm", llmNode)
  .addNode("tools", toolsNode)
  .addEdge(START, "polishPrompt")
  .addEdge("polishPrompt", "llm")
  .addConditionalEdges("llm", routeAfterModel, ["tools", END])
  .addEdge("tools", "llm")
  .compile();