import type { GraphNode } from "@langchain/langgraph";

import {
  searchProceduralMemory,
} from "../procedural-memory.js";
import type { AgentState } from "../state.js";

export const proceduralMemoryNode: GraphNode<
  typeof AgentState
> = async (state) => {
  if (!state.requestContext) {
    throw new Error("Request context is missing.");
  }

  const proceduralContext =
    await searchProceduralMemory({
      organizationId:
        state.requestContext.organizationId,

      queries: state.procedureQueries,
    });

  return {
    proceduralContext,
  };
};