import { writeFile } from 'node:fs/promises';
import type { ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type pg from 'pg';
import type { z } from 'zod';
import type { ToolExecution } from '../agent/state.js';
import type { Scope } from '../memory/memory.repository.js';
import { createGetCustomersTool, customerFilters } from './get-customers.tool.js';
import { createTextFileTool, textFileInput } from './create-text-file.tool.js';
import { createSendDummyMailTool, dummyMailInput } from './send-dummy-mail.tool.js';

type Observation = {
  execution: ToolExecution;
  details?: Record<string, unknown>;
  logDetails?: Record<string, unknown>;
};

type RegisteredTool = {
  tool: StructuredToolInterface;
  schema: z.ZodType;
  observe: (args: unknown, message: ToolMessage, scope: Scope) => Observation;
  afterResponse?: (execution: ToolExecution, response: string) => Promise<void>;
};

function resultObject(message: ToolMessage): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(message.content));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : { error: 'Invalid tool result' };
  } catch {
    return { error: 'Invalid tool result' };
  }
}

export function createToolRegistry(pool: pg.Pool): RegisteredTool[] {
  return [
    {
      tool: createGetCustomersTool(pool), schema: customerFilters,
      observe(args, message, scope) {
        const filters = customerFilters.parse(args);
        const result = resultObject(message);
        if (message.status === 'error' || result.error || !Array.isArray(result.records)
          || typeof result.totalMatched !== 'number') {
          return { execution: { name: 'get_customers', filters, outcome: 'failure' },
            details: { filters }, logDetails: { organizationId: scope.organizationId } };
        }
        const count = result.records.length;
        const outcome = count ? 'success' : 'empty';
        return { execution: { name: 'get_customers', filters, outcome, count },
          details: { filters, returnedCount: count, totalMatched: result.totalMatched },
          logDetails: { organizationId: scope.organizationId, count } };
      },
    },
    {
      tool: createTextFileTool(), schema: textFileInput,
      observe(_args, message) {
        const result = resultObject(message);
        if (message.status === 'error' || result.status !== 'created' || typeof result.path !== 'string') {
          return { execution: { name: 'create_text_file', outcome: 'failure' } };
        }
        return { execution: { name: 'create_text_file', outcome: 'success', path: result.path },
          details: { path: result.path }, logDetails: { path: result.path } };
      },
      async afterResponse(execution, response) {
        if (execution.name === 'create_text_file' && execution.outcome === 'success' && execution.path) {
          await writeFile(execution.path, response, 'utf8');
        }
      },
    },
    {
      tool: createSendDummyMailTool(), schema: dummyMailInput,
      observe(args, message) {
        const input = dummyMailInput.parse(args);
        const result = resultObject(message);
        if (message.status === 'error' || result.status !== 'simulated' || result.sent !== false) {
          return { execution: { name: 'send_dummy_mail', outcome: 'failure', receiver: input.receiver } };
        }
        return { execution: { name: 'send_dummy_mail', outcome: 'success', receiver: input.receiver },
          details: { simulated: true }, logDetails: { simulated: true } };
      },
    },
  ];
}
