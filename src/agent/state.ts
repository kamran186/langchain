import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { Scope, Memories } from '../memory/memory.repository.js';
import type { CustomerFilters } from '../tools/get-customers.tool.js';

export type ToolExecution = { name: 'get_customers'; filters: CustomerFilters; outcome: 'success' | 'empty' | 'failure'; count?: number };
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  context: Annotation<Scope>(),
  currentMessage: Annotation<string>(),
  turnId: Annotation<string>(),
  memoriesUsed: Annotation<Memories>(),
  executions: Annotation<ToolExecution[]>(),
  toolIterations: Annotation<number>(),
});
