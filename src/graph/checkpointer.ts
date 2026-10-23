import { InMemoryStore, MemorySaver } from "@langchain/langgraph";

import {
  sessionKey,
  type RequestContext,
} from "./interpretation.js";

export const checkpointer = new MemorySaver();
export const memoryStore = new InMemoryStore();

export type Episode = {
  id: string;
  prompt: string;
  steps: unknown[];
  outcome: string;
  createdAt: string;
};

function namespace(context: RequestContext): string[] {
  return ["episodes", sessionKey(context)];
}

export async function loadEpisodes(
  context: RequestContext,
): Promise<Episode[]> {
  const item = await memoryStore.get(namespace(context), "recent");
  return (item?.value.episodes ?? []) as Episode[];
}

export async function saveEpisode(
  context: RequestContext,
  episode: Episode,
): Promise<void> {
  // The conversation service already serializes requests per session.
  const existing = await loadEpisodes(context);

  const episodes = [
    episode,
    ...existing.filter((item) => item.id !== episode.id),
  ].slice(0, 5);

  await memoryStore.put(namespace(context), "recent", {
    episodes,
  });
}