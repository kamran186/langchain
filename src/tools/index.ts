import type { z } from "zod";
import { createHash } from "node:crypto";
import { sessionContext, type SessionContext } from "../context.js";

export type ToolContext = SessionContext & { threadId: string; idempotencyKey?: string };
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type ToolResult = { id: string; name: string; result: unknown };
export type ToolPreview = { target: string; fields: Record<string, unknown>; effect: string };
export type RegisteredTool<T extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  effect: "read" | "write";
  schema: T;
  run: (args: z.output<T>, context: ToolContext) => Promise<unknown>;
  preview?: (args: z.output<T>, context: ToolContext) => ToolPreview;
  authorize?: (context: ToolContext) => boolean;
};
export type WriteProposal = SessionContext & {
  id: string;
  threadId: string;
  calls: ToolCall[];
  previews: ToolPreview[];
};

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register<T extends z.ZodType>(tool: RegisteredTool<T>): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    if (tool.effect === "write" && !tool.preview) {
      throw new Error(`Write tool requires a preview: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as RegisteredTool);
  }

  list(context: ToolContext): RegisteredTool[] {
    return [...this.tools.values()].filter((tool) => tool.authorize?.(context) ?? true);
  }

  get(name: string, context: ToolContext): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool || (tool.authorize && !tool.authorize(context))) {
      throw new Error(`Tool unavailable or unauthorized: ${name}`);
    }
    return tool;
  }

  readKey(call: ToolCall, context: ToolContext): string {
    const tool = this.get(call.name, context);
    if (tool.effect !== "read") throw new Error(`Not a read tool: ${call.name}`);
    const args = tool.schema.parse(call.args);
    const canonical = JSON.stringify([context.organizationId, context.sessionId, call.name, args], (_key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
      }
      return value;
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  async executeReads(calls: ToolCall[], context: ToolContext): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of calls) {
      const tool = this.get(call.name, context);
      if (tool.effect !== "read") throw new Error(`Write approval required: ${call.name}`);
      const args = tool.schema.parse(call.args);
      results.push({ id: call.id, name: call.name, result: await tool.run(args, context) });
    }
    return results;
  }

  prepareWrites(calls: ToolCall[], context: ToolContext): WriteProposal {
    if (calls.length === 0) throw new Error("No write calls to prepare");
    const frozenCalls: ToolCall[] = [];
    const previews: ToolPreview[] = [];
    for (const call of calls) {
      const tool = this.get(call.name, context);
      if (tool.effect !== "write" || !tool.preview) {
        throw new Error(`Not a registered write tool: ${call.name}`);
      }
      const args = tool.schema.parse(call.args) as Record<string, unknown>;
      frozenCalls.push({ id: call.id, name: call.name, args: structuredClone(args) });
      previews.push(structuredClone(tool.preview(args, context)));
    }
    const body = { ...sessionContext(context), threadId: context.threadId, calls: frozenCalls, previews };
    return { id: proposalId(body), ...body };
  }

  async executeApprovedWrites(
    proposal: WriteProposal,
    approvalId: string,
    context: ToolContext,
  ): Promise<ToolResult[]> {
    const { id, ...body } = proposal;
    if (
      approvalId !== id ||
      proposalId(body) !== id ||
      proposal.organizationId !== context.organizationId ||
      proposal.sessionId !== context.sessionId ||
      proposal.threadId !== context.threadId
    ) {
      throw new Error("Write approval does not match the frozen proposal");
    }
    const results: ToolResult[] = [];
    const reservedKeys = new Set(proposal.calls.map((call) => `${id}:${call.id}`));
    const usedKeys = new Set<string>();
    for (const [index, call] of proposal.calls.entries()) {
      const tool = this.get(call.name, context);
      if (tool.effect !== "write") throw new Error(`Not a write tool: ${call.name}`);
      const args = tool.schema.parse(call.args);
      // Keep existing retry keys, but never let repeated model IDs merge distinct writes.
      let idempotencyKey = `${id}:${call.id}`;
      if (usedKeys.has(idempotencyKey)) {
        idempotencyKey = `${id}:entry:${index}`;
        while (reservedKeys.has(idempotencyKey) || usedKeys.has(idempotencyKey)) idempotencyKey += ":";
      }
      usedKeys.add(idempotencyKey);
      results.push({
        id: call.id,
        name: call.name,
        result: await tool.run(args, { ...context, ...sessionContext(proposal), idempotencyKey }),
      });
    }
    return results;
  }
}

function proposalId(value: Omit<WriteProposal, "id">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
