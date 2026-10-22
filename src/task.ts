import type { AssistantModel, TaskModelInput } from "./graph.js";
import type { MemoryPort } from "./memory.js";
import type { RequestContext } from "./context.js";
import type { ToolCall, ToolContext, ToolRegistry, ToolResult, WriteProposal } from "./tools/index.js";

export function describeReadResults(results: ToolResult[]): string {
  const empty = results.length > 0 && results.every(({ result }) => {
    if (Array.isArray(result)) return result.length === 0;
    if (!result || typeof result !== "object" || "error" in result) return false;
    const lists = Object.values(result).filter(Array.isArray);
    return lists.length > 0 && lists.every((list) => list.length === 0);
  });
  return empty
    ? "No matching records were found for the requested filters in this organization."
    : "Retrieved data is included in the results.";
}

/** One graph node calls this helper to collect reads and freeze every intended write. */
export async function prepareWriteProposal(
  calls: ToolCall[],
  registry: ToolRegistry,
  context: ToolContext,
  model: AssistantModel,
  modelInput: TaskModelInput,
): Promise<{ proposal: WriteProposal | null; readResults: ToolResult[]; response?: string }> {
  const readResults: ToolResult[] = [];
  let planned = calls;
  let response: string | undefined;
  for (let round = 0; round < 4; round += 1) {
    for (const call of planned) {
      if (!modelInput.tools.some((tool) => tool.name === call.name)) {
        throw new Error(`Tool not selected for this request: ${call.name}`);
      }
    }
    const reads = planned.filter((call) => registry.get(call.name, context).effect === "read");
    if (!reads.length) break;
    readResults.push(...await registry.executeReads(reads, context));
    const revised = await model.planTask({ ...modelInput, results: [...modelInput.results, ...readResults] });
    planned = revised.calls;
    response = revised.response;
  }
  if (planned.some((call) => registry.get(call.name, context).effect === "read")) {
    throw new Error("Too many read steps while preparing the write");
  }
  const writes = planned.filter((call) => registry.get(call.name, context).effect === "write");
  return { proposal: writes.length ? registry.prepareWrites(writes, context) : null, readResults, response };
}

/** Summarization and persistence intentionally live in one graph node. */
export async function recordEpisode(
  model: AssistantModel,
  memory: MemoryPort,
  context: RequestContext,
  input: { prompt: string; steps: string[]; outcome: string },
  episodeId?: string,
): Promise<void> {
  const episode = await model.summarizeEpisode(input);
  await memory.saveEpisode(context, episode, episodeId);
}
