import type { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { PostgresMemory, type SemanticRecord, type Episode } from "../src/memory.js";
import type { SessionContext } from "../src/context.js";
import { createHash } from "node:crypto";

export class StoreFixture {
  items = new Map<string, { namespace: string[]; key: string; value: Record<string, unknown> }>();
  async put(namespace: string[], key: string, value: Record<string, unknown>) {
    this.items.set(JSON.stringify([namespace, key]), { namespace, key, value: structuredClone(value) });
  }
  async get(namespace: string[], key: string) {
    const item = this.items.get(JSON.stringify([namespace, key]));
    return item ? structuredClone(item) : null;
  }
  async search(namespace: string[]) {
    return [...this.items.values()].filter((item) => JSON.stringify(item.namespace) === JSON.stringify(namespace))
      .map((item) => ({ ...structuredClone(item), score: 0.9 }));
  }
}

export class MemoryFixture extends PostgresMemory {
  readonly backend: StoreFixture;
  searches: string[] = [];
  semanticContexts: SessionContext[] = [];
  constructor(backend = new StoreFixture()) { super(backend as unknown as PostgresStore); this.backend = backend; }
  get semantic(): SemanticRecord[] {
    return [...this.backend.items.values()].filter((item) => item.namespace.at(-1) === "semantic")
      .map((item) => ({ id: item.key, text: String(item.value.text) }));
  }
  set semantic(records: SemanticRecord[]) {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const ns = ["organizations", hash("org-1"), "sessions", hash("session-1"), "semantic"];
    for (const [key, item] of this.backend.items) if (item.namespace.at(-1) === "semantic") this.backend.items.delete(key);
    for (const item of records) void this.backend.put(ns, item.id, { text: item.text });
  }
  get procedural(): string[] {
    return [...this.backend.items.values()].filter((item) => item.namespace.at(-1) === "procedural").map((item) => String(item.value.text));
  }
  get episodes(): Episode[] {
    return [...this.backend.items.values()].filter((item) => item.namespace.at(-1) === "episodic").map((item) => item.value as unknown as Episode);
  }
  override async searchSemantic(context: SessionContext, query: string) {
    this.searches.push(query); return super.searchSemantic(context, query);
  }
  override async createSemantic(context: SessionContext, text: string, writeId?: string) {
    this.semanticContexts.push(structuredClone(context)); return super.createSemantic(context, text, writeId);
  }
}
