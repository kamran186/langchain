import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

import { config } from "../config.js";
import {
  sessionKey,
  type RequestContext,
} from "./interpretation.js";

export const checkpointer = PostgresSaver.fromConnString(
  config.databaseUrl,
);

export const memoryStore = PostgresStore.fromConnString(
  config.databaseUrl,
);

export type Episode = {
  id: string;
  prompt: string;
  steps: unknown[];
  outcome: string;
  createdAt: string;
};

// Called once during application startup.
// Creates the required tables and applies adapter migrations.
export async function initializeMemory(): Promise<void> {
  await checkpointer.setup();
  await memoryStore.setup();
}

let closing: Promise<void> | undefined;

export function closeMemory(): Promise<void> {
  closing ??= Promise.all([
    checkpointer.end(),
    memoryStore.stop(),
  ]).then(() => undefined);

  return closing;
}

function namespace(context: RequestContext): string[] {
  return ["episodes", sessionKey(context)];
}

export async function loadEpisodes(
  context: RequestContext,
): Promise<Episode[]> {
  const item = await memoryStore.get(
    namespace(context),
    "recent",
  );

  return (item?.value.episodes ?? []) as Episode[];
}

export async function saveEpisode(
  context: RequestContext,
  episode: Episode,
): Promise<void> {
  // Existing conversation service serializes requests per session
  // within this application process.
  const existing = await loadEpisodes(context);

  const episodes = [
    episode,
    ...existing.filter((item) => item.id !== episode.id),
  ].slice(0, 5);

  await memoryStore.put(namespace(context), "recent", {
    episodes,
  });
}