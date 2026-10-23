import {
  MessagesValue,
  ReducedValue,
  StateSchema,
} from "@langchain/langgraph";
import { z } from "zod";

export const AgentState = new StateSchema({
  // Shared conversation history for any registered tool.
  messages: MessagesValue,

  // Each model node update adds to the accumulated call count.
  llmCalls: new ReducedValue(z.number().default(0), {
    reducer: (total, increment) => total + increment,
  }),
});