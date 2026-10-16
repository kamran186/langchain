import { z } from 'zod';
import type { ToolExecution } from '../agent/state.js';
import type { Scope } from './memory.repository.js';
import { createMemoryRepository } from './memory.repository.js';
import type { ChatBedrockConverse } from '@langchain/aws';
import { refineMemory } from './refine-memory.js';

const candidate = z.object({ type: z.literal('semantic'), key: z.string().min(2).max(150), content: z.string().min(5).max(1000) });

export function isReusableProcedureInstruction(message: string): boolean {
  const text = message.trim().replace(/\s+/g, ' ');
  const action = '(?:display|show|present|format|include|sort|prefix|prepend|append|respond|answer|use|write|return|list|name|put)';
  const future = '(?:from now on|going forward|in (?:the )?future|for future|permanently|by default)';
  const persistentBehavior = new RegExp(`\\balways\\s+${action}\\b|\\b(?:whenever|every time)\\s+you\\s+${action}\\b|\\b${future}\\b.{0,100}\\b${action}\\b|\\b${action}\\b.{0,100}\\b${future}\\b`, 'i');
  return /\bprocedural memor(?:y|ies)\b/i.test(text)
    || /\b(?:save|store|add|set|update|change|remember|keep|learn)\b.{0,100}\b(?:preference|instruction|rule|default)\b/i.test(text)
    || /\bremember\s+to\b/i.test(text)
    || /\bremember that\b.{0,150}\b(?:should|must|need to)\b/i.test(text)
    || persistentBehavior.test(text);
}

export function extractExplicitFacts(message: string) {
  const result: z.infer<typeof candidate>[] = [];
  if (isReusableProcedureInstruction(message)) return result;
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

export function episodeSummary(request: string, executions: ToolExecution[]) {
  const actions = executions.map((item) => {
    if (item.name === 'get_customers') return `${item.name} ${JSON.stringify(item.filters)}: ${item.outcome}${item.count === undefined ? '' : ` (${item.count} records)`}`;
    if (item.name === 'create_text_file') return `${item.name}: ${item.outcome}${item.path ? ` (${item.path})` : ''}`;
    return `${item.name} for ${item.receiver}: ${item.outcome} (simulation only; no email sent)`;
  });
  return `Request: ${request.slice(0, 300)}. ${actions.length ? `Actions: ${actions.join('; ')}. ` : ''}Outcome: ${executions.some(x => x.outcome === 'failure') ? 'tool failure' : 'completed'}.`;
}

export async function saveTurnMemories(
  repository: ReturnType<typeof createMemoryRepository>, scope: Scope, turnId: string,
  message: string, executions: ToolExecution[], model: ChatBedrockConverse,
): Promise<{ episodeSaved: boolean; semanticUpdates: number; semanticDuplicates: number }> {
  if (isReusableProcedureInstruction(message)) return { episodeSaved: false, semanticUpdates: 0, semanticDuplicates: 0 };
  const key = `turn:${turnId}`;
  let semanticDuplicates = 0;
  const updates = [];
  for (const update of extractExplicitFacts(message)) {
    if (await repository.findByOriginal(scope, 'semantic', message)) {
      semanticDuplicates++;
      continue;
    }
    const candidates = (await repository.retrieve(scope, update.content, 20, ['semantic'])).semantic;
    const refined = await refineMemory(model, 'semantic', update.content, candidates);
    if (refined.equivalentMemoryId) { semanticDuplicates++; continue; }
    updates.push({ ...update, content: refined.content, originalStatement: message });
  }
  await repository.saveTurn(scope, key, episodeSummary(message, executions), { request: message, executions }, updates);
  return {
    episodeSaved: true,
    semanticUpdates: updates.length,
    semanticDuplicates,
  };
}
