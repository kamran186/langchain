import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/tools/index.js";

const context = { organizationId: "org-1", employeeId: "employee-1", userId: "user-1", sessionId: "session-1", threadId: "thread-1" };

describe("ToolRegistry", () => {
  it("executes a newly registered read tool by name", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "lookup_city",
      description: "Look up a city by code",
      effect: "read",
      schema: z.object({ code: z.string() }),
      run: async ({ code }) => ({ city: code === "NYC" ? "New York" : "Unknown" }),
    });

    const results = await registry.executeReads(
      [{ id: "call-1", name: "lookup_city", args: { code: "NYC" } }],
      context,
    );

    expect(results).toEqual([
      { id: "call-1", name: "lookup_city", result: { city: "New York" } },
    ]);
  });

  it("does not stage a write with missing required fields", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "create_note",
      description: "Create a note",
      effect: "write",
      schema: z.object({ text: z.string().min(1) }),
      preview: ({ text }) => ({ target: "notes", fields: { text }, effect: "Create note" }),
      run: async () => ({ id: "note-1" }),
    });

    expect(() =>
      registry.prepareWrites(
        [{ id: "call-2", name: "create_note", args: {} }],
        context,
      ),
    ).toThrow(/text/i);
  });

  it("executes only the frozen, approved write proposal", async () => {
    const writes: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "create_note",
      description: "Create a note",
      effect: "write",
      schema: z.object({ text: z.string().min(1) }),
      preview: ({ text }) => ({ target: "notes", fields: { text }, effect: "Create note" }),
      run: async ({ text }) => {
        writes.push(text);
        return { id: "note-1" };
      },
    });

    const proposal = registry.prepareWrites(
      [{ id: "call-3", name: "create_note", args: { text: "hello" } }],
      context,
    );

    await expect(
      registry.executeApprovedWrites(proposal, "wrong-id", context),
    ).rejects.toThrow(/approval/i);
    await expect(
      registry.executeApprovedWrites(proposal, proposal.id, { ...context, organizationId: "another-org" }),
    ).rejects.toThrow(/approval/i);
    expect(writes).toEqual([]);

    const results = await registry.executeApprovedWrites(proposal, proposal.id, context);
    expect(results).toEqual([
      { id: "call-3", name: "create_note", result: { id: "note-1" } },
    ]);
    expect(writes).toEqual(["hello"]);
  });

  it.each(["create_note", "entry:1"])("executes all ten writes with repeated call ID %s and keeps retries idempotent", async (callId) => {
    const records = new Map<string, string>();
    const registry = new ToolRegistry();
    registry.register({
      name: "create_note", description: "Create a note", effect: "write",
      schema: z.object({ text: z.string() }),
      preview: ({ text }) => ({ target: "notes", fields: { text }, effect: "Create note" }),
      run: async ({ text }, toolContext) => {
        const key = toolContext.idempotencyKey!;
        if (!records.has(key)) records.set(key, text);
        return { text: records.get(key) };
      },
    });
    const calls = Array.from({ length: 10 }, (_, index) => ({
      id: callId, name: "create_note", args: { text: `Note ${index + 1}` },
    }));
    const proposal = registry.prepareWrites(calls, context);
    expect(records.size).toBe(0);
    const results = await registry.executeApprovedWrites(proposal, proposal.id, context);
    expect(records.size).toBe(10);
    expect(records.get(`${proposal.id}:${callId}`)).toBe("Note 1");
    expect(results.map((result) => result.result)).toEqual([
      { text: "Note 1" }, { text: "Note 2" }, { text: "Note 3" }, { text: "Note 4" }, { text: "Note 5" },
      { text: "Note 6" }, { text: "Note 7" }, { text: "Note 8" }, { text: "Note 9" }, { text: "Note 10" },
    ]);

    // Rehydrating the approved checkpoint must produce the same keys for all ten entries.
    const restored = JSON.parse(JSON.stringify(proposal));
    expect(await registry.executeApprovedWrites(restored, restored.id, context)).toEqual(results);
    expect(records.size).toBe(10);
  });
});
