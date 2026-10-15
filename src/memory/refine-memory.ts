import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { ChatBedrockConverse } from '@langchain/aws';
import { z } from 'zod';

const refinedMemory = z.strictObject({
  content: z.string().trim().min(5).max(1000),
  equivalentMemoryId: z.uuid().nullable().optional(),
});
const instruction = new SystemMessage(`Polish one user-provided long-term memory before storage. Correct spelling, grammar, capitalization, and word order. Keep the original meaning, names, numbers, negation, and scope. Never add facts, conditions, or preferences that the user did not provide. For semantic memory, write a concise factual statement. For procedural memory, write one clear reusable instruction. If wording is ambiguous, keep the uncertain term instead of guessing. Compare only with existing records of the same memory type supplied in the input. Return an existing record's exact ID as equivalentMemoryId only when it states the same meaning, including the same entities and conditions. A changed fact or conflicting instruction is not equivalent, even if it concerns the same topic; use null so it can replace the old key. Reply with only a JSON object shaped exactly as {"content":"polished sentence","equivalentMemoryId":null}.`);

export async function refineMemory(model: ChatBedrockConverse, type: 'semantic' | 'procedural', original: string,
  existing: { id: string; content: string }[] = []): Promise<{ content: string; equivalentMemoryId: string | null }> {
  const response = await model.invoke([instruction, new HumanMessage({ content: JSON.stringify({ memoryType: type, original,
    existing: existing.map(({ id, content }) => ({ id, content })) }) })]);
  const text = typeof response.content === 'string' ? response.content : response.content
    .map(block => typeof block === 'string' ? block : 'text' in block ? String(block.text) : '').join('');
  let parsed: unknown;
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  try { parsed = JSON.parse(fenced?.[1] ?? text); }
  catch { throw new Error('Memory refinement returned invalid JSON'); }
  const result = refinedMemory.safeParse(parsed);
  if (!result.success) throw new Error('Memory refinement returned invalid content');
  const equivalentMemoryId = result.data.equivalentMemoryId ?? existing.find(memory =>
    memory.content.trim().toLocaleLowerCase() === result.data.content.toLocaleLowerCase())?.id ?? null;
  if (equivalentMemoryId && !existing.some(memory => memory.id === equivalentMemoryId)) {
    throw new Error('Memory refinement referenced an unknown memory');
  }
  return { content: result.data.content, equivalentMemoryId };
}
