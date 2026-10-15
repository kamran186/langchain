import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CustomerFilters } from '../tools/get-customers.tool.js';
import type { Scope } from './memory.repository.js';
import { createMemoryRepository } from './memory.repository.js';

const candidate = z.object({ type: z.enum(['semantic','procedural']), key: z.string().min(2).max(150), content: z.string().min(5).max(1000) });
type Execution = { name: 'get_customers'; filters: CustomerFilters; outcome: 'success' | 'empty' | 'failure'; count?: number };

export function extractExplicitMemories(message: string) {
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
  const procedure = /^(?:please\s+)?(?:always|from now on,?\s*|in future,?\s*)(.+?)[.!]?$/i.exec(text);
  if (procedure) {
    const content = procedure[1]!.replace(/[.!]$/, '').trim();
    const lower = content.toLowerCase();
    const key = /email/.test(lower) ? 'customer-email'
      : /table|format|display|present|show/.test(lower) ? 'customer-format'
      : /sort|alphabet/.test(lower) ? 'customer-sort'
      : /concise|summary|summaries/.test(lower) ? 'customer-summary'
      : createHash('sha256').update(lower.split(/\s+/).slice(0, 4).join(' ')).digest('hex').slice(0, 20);
    const parsed = candidate.safeParse({ type: 'procedural', key, content });
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
): Promise<void> {
  const key = `turn:${turnId}`;
  await repository.saveTurn(scope, key, episodeSummary(message, executions), { request: message, executions }, extractExplicitMemories(message));
}
