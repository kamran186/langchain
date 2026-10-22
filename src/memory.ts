import type { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { createHash, randomUUID } from "node:crypto";
import type { SemanticMatch } from "./semantic.js";
import type { RequestContext, SessionContext } from "./context.js";
import { fingerprint, ReviewError, type MemoryBatch } from "./memory-review.js";

export type Episode = {
  text: string;
  intent: string;
  steps: string[];
  resolvedAmbiguity: string[];
  outcome: string;
  sourceSessionId?: string;
};
export type SemanticRecord = { id: string; text: string; version?: string; writeId?: string };
export type SemanticBatchQuery = { candidateId: string; text: string };
export type SemanticBatchMatches = { candidateId: string; matches: SemanticMatch[]; error?: string };
export interface MemoryPort {
  searchSemantic(context: SessionContext, query: string): Promise<SemanticMatch[]>;
  searchSemanticBatch(context: SessionContext, queries: SemanticBatchQuery[]): Promise<SemanticBatchMatches[]>;
  getSemantic(context: SessionContext, ids: string[]): Promise<SemanticRecord[]>;
  createSemantic(context: SessionContext, text: string, writeId?: string): Promise<SemanticRecord>;
  updateSemantic(context: SessionContext, ids: string[], text: string, writeId?: string, expected?: SemanticMatch[]): Promise<SemanticRecord[]>;
  searchProcedural(context: RequestContext & { sessionId?: string }, query: string): Promise<string[]>;
  saveProcedural(context: RequestContext, text: string, proposalId?: string): Promise<SemanticRecord>;
  searchEpisodic(context: RequestContext & { sessionId?: string }, query: string): Promise<Episode[]>;
  saveEpisode(context: RequestContext & { sessionId?: string }, episode: Episode, episodeId?: string): Promise<void>;
  saveReview(context: RequestContext, batch: MemoryBatch): Promise<void>;
  getReview(context: RequestContext, batchId: string): Promise<MemoryBatch | null>;
}

export class PostgresMemory implements MemoryPort {
  constructor(private readonly store: PostgresStore, private readonly similarityThreshold = 0.66) {}

  async searchSemantic(context: SessionContext, query: string): Promise<SemanticMatch[]> {
    const items = await this.store.search(semanticNamespace(context), {
      query, limit: 5, mode: "vector", similarityThreshold: this.similarityThreshold,
    });
    return items.map((item) => ({
      id: item.key,
      text: String(item.value.text),
      version: recordVersion(item.value),
      ...(item.score === undefined ? {} : { score: item.score }),
    }));
  }

  async searchSemanticBatch(context: SessionContext, queries: SemanticBatchQuery[]): Promise<SemanticBatchMatches[]> {
    const results: SemanticBatchMatches[] = [];
    // Bound embedding/database work while preparing a single combined review.
    for (let index = 0; index < queries.length; index += 4) {
      results.push(...await Promise.all(queries.slice(index, index + 4).map(async ({ candidateId, text }) => {
        try { return { candidateId, matches: await this.searchSemantic(context, text) }; }
        catch { return { candidateId, matches: [], error: "Could not search existing Semantic Memory; edit to retry or skip." }; }
      })));
    }
    return results;
  }

  async getSemantic(context: SessionContext, ids: string[]): Promise<SemanticRecord[]> {
    const ns = semanticNamespace(context);
    return Promise.all([...new Set(ids)].map(async (id) => {
      const item = await this.store.get(ns, id);
      if (!item) throw new ReviewError(`Semantic Memory not found: ${id}`, 409);
      return { id, text: String(item.value.text), version: recordVersion(item.value),
        ...(typeof item.value.writeId === "string" ? { writeId: item.value.writeId } : {}) };
    }));
  }

  async createSemantic(context: SessionContext, text: string, writeId?: string): Promise<SemanticRecord> {
    const id = writeId ?? randomUUID();
    const record = { id, text: requiredText(text) };
    const existing = writeId ? await this.store.get(semanticNamespace(context), id) : null;
    if (existing) {
      if (existing.value.text !== record.text) throw new ReviewError("Write retry conflicts with saved text", 409);
      return record;
    }
    await this.store.put(semanticNamespace(context), id, {
      ...context, text: record.text, writeId: id, updatedAt: new Date().toISOString(),
    });
    return record;
  }

  async updateSemantic(context: SessionContext, ids: string[], text: string, writeId?: string, expected?: SemanticMatch[]): Promise<SemanticRecord[]> {
    if (ids.length === 0) throw new Error("At least one Semantic Memory ID is required");
    const targetNamespace = semanticNamespace(context);
    const uniqueIds = [...new Set(ids)];
    const existing = await Promise.all(uniqueIds.map((id) => this.store.get(targetNamespace, id)));
    for (let index = 0; index < uniqueIds.length; index += 1) {
      if (!existing[index]) throw new Error(`Semantic Memory not found: ${uniqueIds[index]}`);
    }
    const value = requiredText(text);
    const updatedAt = new Date().toISOString();
    for (const [index, id] of uniqueIds.entries()) {
      const current = existing[index]!;
      if (writeId && current.value.writeId === writeId && current.value.text === value) continue;
      const match = expected?.find((item) => item.id === id);
      if (expected && (!match || (match.version ? match.version !== recordVersion(current.value) : match.text !== current.value.text))) {
        throw new ReviewError("Semantic Memory changed since review", 409);
      }
    }
    for (const [index, id] of uniqueIds.entries()) {
      if (writeId && existing[index]!.value.writeId === writeId && existing[index]!.value.text === value) continue;
      await this.store.put(targetNamespace, id, { ...context, text: value, ...(writeId ? { writeId } : {}), updatedAt });
    }
    return uniqueIds.map((id) => ({ id, text: value }));
  }

  async searchProcedural(context: RequestContext & { sessionId?: string }, query: string): Promise<string[]> {
    const items = await this.store.search(namespace(context.organizationId, "procedural"), {
      query, limit: 5, mode: "text",
    });
    return items.map((item) => String(item.value.text));
  }

  async saveProcedural(context: RequestContext, text: string, proposalId?: string): Promise<SemanticRecord> {
    const id = proposalId ?? randomUUID(), value = requiredText(text), ns = namespace(context.organizationId, "procedural");
    const existing = proposalId ? await this.store.get(ns, id) : null;
    if (existing) {
      if (existing.value.text !== value) throw new ReviewError("Write retry conflicts with saved text", 409);
      return { id, text: value };
    }
    await this.store.put(ns, id, {
      ...context, text: value, updatedAt: new Date().toISOString(),
    }, false);
    return { id, text: value };
  }

  async searchEpisodic(context: RequestContext & { sessionId?: string }, query: string): Promise<Episode[]> {
    const items = await this.store.search(namespace(context.organizationId, "episodic"), {
      query, limit: 5, mode: "vector",
    });
    return items.map((item) => ({
      text: String(item.value.text),
      intent: String(item.value.intent),
      steps: stringArray(item.value.steps),
      resolvedAmbiguity: stringArray(item.value.resolvedAmbiguity),
      outcome: String(item.value.outcome),
      ...(typeof item.value.sourceSessionId === "string" ? { sourceSessionId: item.value.sourceSessionId } : {}),
    }));
  }

  async saveEpisode(context: RequestContext & { sessionId?: string }, episode: Episode, episodeId?: string): Promise<void> {
    await this.store.put(namespace(context.organizationId, "episodic"), episodeId ?? randomUUID(), {
      ...episode, ...context, ...(context.sessionId === undefined ? {} : { sourceSessionId: context.sessionId }), createdAt: new Date().toISOString(),
    });
  }

  async saveReview(context: RequestContext, batch: MemoryBatch): Promise<void> {
    if (batch.context.organizationId !== context.organizationId) throw new ReviewError("Review belongs to another organization", 403);
    await this.store.put(reviewNamespace(context.organizationId), batch.batchId, { batch: structuredClone(batch) }, false);
  }

  async getReview(context: RequestContext, batchId: string): Promise<MemoryBatch | null> {
    const item = await this.store.get(reviewNamespace(context.organizationId), batchId);
    return item ? structuredClone(item.value.batch as MemoryBatch) : null;
  }
}

function recordVersion(value: Record<string, unknown>): string { return fingerprint([value.text, value.updatedAt]); }
function reviewNamespace(organizationId: string): string[] {
  return ["organizations", createHash("sha256").update(organizationId).digest("hex"), "memory_reviews"];
}

function semanticNamespace(context: SessionContext): string[] {
  if (typeof context.sessionId !== "string" || !context.sessionId.trim()) throw new Error("sessionId is required for Semantic Memory");
  return ["organizations", createHash("sha256").update(context.organizationId).digest("hex"),
    "sessions", createHash("sha256").update(context.sessionId).digest("hex"), "semantic"];
}

function namespace(organizationId: string, kind: "procedural" | "episodic"): string[] {
  const key = createHash("sha256").update(organizationId).digest("hex");
  return ["organizations", key, kind];
}

function requiredText(text: string): string {
  const value = text.trim();
  if (!value) throw new Error("Memory text is required");
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
