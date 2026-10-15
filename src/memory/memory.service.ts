import { z } from 'zod';
import type { CustomerFilters } from '../tools/get-customers.tool.js';
import type { Scope } from './memory.repository.js';
import { createMemoryRepository } from './memory.repository.js';

const candidate = z.object({ type: z.literal('semantic'), key: z.string().min(2).max(150), content: z.string().min(5).max(1000) });
type Execution = { name: 'get_customers'; filters: CustomerFilters; outcome: 'success' | 'empty' | 'failure'; count?: number };

export function isReusableProcedureInstruction(message: string): boolean {
  return /^(?:please\s+)?(?:always\b|from now on\b|in future\b)/i.test(message.trim());
}

export function extractExplicitFacts(message: string) {
  const result: z.infer<typeof candidate>[] = [];
  const text = message.trim();
  const fact = /^(?:please\s+)?remember that\s+(.+?)[.!]?$/i.exec(text)
    ?? /^(customer\s+.+?\s+(?:belongs to|prefers|is|has)\s+.+?)[.!]?$/i.exec(text);
  if (fact) {
    const content = fact[1]!.replace(/[.!]$/, '').trim();
    const parts = /^(.+?)\s+(belongs to|prefers|is|has)\b\s+(.+)$/i.exec(content);
    const subject = parts?.[1] ?? content;
    const relation = parts?.[2]?.toLowerCase() ?? 'fact';
    const detail = parts?.[3]?.toLowerCase() ?? '';
    const aspect = relation === 'is' ? (/\b(active|inactive)\b/.test(detail) ? 'status' : /\b(healthcare|finance|retail|technology)\b/.test(detail) ? 'industry' : detail.split(/\s+/)[0])
      : relation === 'has' ? detail.split(/\s+/)[0] : relation;
    const parsed = candidate.safeParse({ type: 'semantic', key: `${subject.toLowerCase().replace(/\s+/g, ' ')}:${aspect}`, content });
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}

export function episodeSummary(request: string, executions: Execution[]) {
  const actions = executions.map((item) =>
    `${item.name} ${JSON.stringify(item.filters)}: ${item.outcome}${item.count === undefined ? '' : ` (${item.count} records)`}`);
  return `Request: ${request.slice(0, 300)}. ${actions.length ? `Actions: ${actions.join('; ')}. ` : ''}Outcome: ${executions.some(x => x.outcome === 'failure') ? 'tool failure' : 'completed'}.`;
}

export async function saveTurnMemories(
  repository: ReturnType<typeof createMemoryRepository>, scope: Scope, turnId: string,
  message: string, executions: Execution[],
): Promise<{ episodeSaved: true; semanticUpdates: number }> {
  const key = `turn:${turnId}`;
  const updates = extractExplicitFacts(message);
  await repository.saveTurn(scope, key, episodeSummary(message, executions), { request: message, executions }, updates);
  return {
    episodeSaved: true,
    semanticUpdates: updates.length,
  };
}
