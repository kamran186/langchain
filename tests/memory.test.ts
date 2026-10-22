import { describe, expect, it } from "vitest";
import type { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { PostgresMemory } from "../src/memory.js";
import { createHash } from "node:crypto";

const organizationA = { organizationId: "org-a", employeeId: "employee-a", userId: "user-a", sessionId: "session-1" };
const organizationB = { organizationId: "org-b", employeeId: "employee-a", userId: "user-a", sessionId: "session-1" };

class MemoryStoreFixture {
  private readonly items = new Map<string, Record<string, unknown>>();
  private key(namespace: string[], id: string): string { return `${namespace.join("/")}/${id}`; }

  async put(namespace: string[], id: string, value: Record<string, unknown>): Promise<void> {
    this.items.set(this.key(namespace, id), structuredClone(value));
  }

  async get(namespace: string[], id: string) {
    const value = this.items.get(this.key(namespace, id));
    return value ? { key: id, value } : null;
  }

  async search(namespace: string[], options: { query?: string }) {
    const prefix = `${namespace.join("/")}/`;
    return [...this.items.entries()]
      .filter(([key, value]) => key.startsWith(prefix) &&
        (!options.query || String(value.text).toLowerCase().includes(options.query.toLowerCase())))
      .map(([key, value]) => ({ key: key.slice(prefix.length), value, score: 0.9 }));
  }
}

describe("PostgresMemory", () => {
  it("shares Semantic Memory within an organization and isolates updates across organizations", async () => {
    const memory = new PostgresMemory(new MemoryStoreFixture() as unknown as PostgresStore);
    const created = await memory.createSemantic(organizationA, "I prefer jazz");

    expect(await memory.searchSemantic({ ...organizationA, employeeId: "another-employee", userId: "" }, "jazz")).toEqual([
      { id: created.id, text: "I prefer jazz", score: 0.9, version: expect.any(String) },
    ]);
    expect(await memory.searchSemantic(organizationB, "jazz")).toEqual([]);
    await expect(memory.updateSemantic(organizationB, [created.id], "I prefer rock"))
      .rejects.toThrow(/not found/i);
    await memory.updateSemantic(organizationA, [created.id], "I prefer rock");
    expect(await memory.searchSemantic(organizationA, "rock")).toEqual([
      { id: created.id, text: "I prefer rock", score: 0.9, version: expect.any(String) },
    ]);
  });

  it("stores Procedural and Episodic Memory separately", async () => {
    const memory = new PostgresMemory(new MemoryStoreFixture() as unknown as PostgresStore);
    await memory.saveProcedural(organizationA, "Always use concise replies");
    await memory.saveEpisode(organizationA, {
      text: "Looked up the server time and answered",
      intent: "What time is it?",
      steps: ["Called get_server_time"],
      resolvedAmbiguity: [],
      outcome: "Answered with time",
    });

    expect(await memory.searchProcedural(organizationA, "concise")).toEqual(["Always use concise replies"]);
    expect((await memory.searchEpisodic(organizationA, "server time"))[0].outcome)
      .toBe("Answered with time");
    expect(await memory.searchEpisodic(organizationB, "server time")).toEqual([]);
  });

  it("uses a stable key for an approved retry", async () => {
    const memory = new PostgresMemory(new MemoryStoreFixture() as unknown as PostgresStore);
    await memory.createSemantic(organizationA, "I prefer jazz", "review-1");
    await memory.createSemantic(organizationA, "I prefer jazz", "review-1");
    expect(await memory.searchSemantic(organizationA, "jazz")).toHaveLength(1);
  });

  it("stores raw context metadata even when organizationId and userId are empty", async () => {
    const store = new MemoryStoreFixture();
    const memory = new PostgresMemory(store as unknown as PostgresStore);
    const context = { organizationId: "", employeeId: "", userId: "  ", sessionId: "session-1" };
    await memory.createSemantic(context, "I prefer jazz");
    await memory.saveProcedural(context, "Always test changes");
    await memory.saveEpisode(context, { text: "Jazz episode", intent: "jazz", steps: [], resolvedAmbiguity: [], outcome: "Done" });
    const records = await store.search(["organizations"], {});
    expect(records).toHaveLength(3);
    for (const record of records) expect(record.value).toMatchObject(context);
    expect(await memory.searchSemantic(context, "jazz")).toHaveLength(1);
  });

  it("never falls back to organization-only legacy Semantic records", async () => {
    const store = new MemoryStoreFixture();
    const orgHash = createHash("sha256").update(organizationA.organizationId).digest("hex");
    await store.put(["organizations", orgHash, "semantic"], "legacy-id", { text: "Old fact" });
    const memory = new PostgresMemory(store as unknown as PostgresStore);
    expect(await memory.searchSemantic(organizationA, "Old")).toEqual([]);
    await expect(memory.updateSemantic(organizationA, ["legacy-id"], "Changed")).rejects.toThrow(/not found/);
    expect((await store.get(["organizations", orgHash, "semantic"], "legacy-id"))?.value.text).toBe("Old fact");
  });
});
