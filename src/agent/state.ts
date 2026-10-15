import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { Scope, ChatMemories } from '../memory/memory.repository.js';
import type { CustomerFilters } from '../tools/get-customers.tool.js';

export type ToolExecution = { name: 'get_customers'; filters: CustomerFilters; outcome: 'success' | 'empty' | 'failure'; count?: number };
export type FlowEvent = {
  stage: string;
  component: 'API' | 'LangGraph' | 'Memory' | 'LangChain' | 'LLM Agent';
  status: string;
  details?: Record<string, unknown>;
};
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  context: Annotation<Scope>(),
  currentMessage: Annotation<string>(),
  turnId: Annotation<string>(),
  loadedMemories: Annotation<ChatMemories>(),
  memoriesUsed: Annotation<ChatMemories>(),
  executions: Annotation<ToolExecution[]>(),
  toolIterations: Annotation<number>(),
  flow: Annotation<FlowEvent[]>(),
});
