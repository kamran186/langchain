import { createHash } from "node:crypto";
import { z } from "zod";

import { memoryStore } from "./checkpointer.js";

const ScopeSchema = z.object({
  organizationId: z.string().trim().min(1).max(128),
  threadId: z.string().trim().min(1).max(128),
});

export type SessionScope = z.infer<typeof ScopeSchema>;

export const ConclusionSchema = z.object({
  conclusion: z.string().trim().min(1).max(24000),
  topics: z
    .array(z.string().trim().min(1).max(80))
    .max(30),
}).strict();

const EpisodeSchema = ScopeSchema.extend({
  id: z.string(),
  ...ConclusionSchema.shape,

  processedMessageCount: z.number().int().nonnegative(),
  processedPrefixHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/),

  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type Episode = z.infer<typeof EpisodeSchema>;

const TranscriptSchema = ScopeSchema.extend({
  id: z.string(),
  messages: z.array(z.unknown()),
  updatedAt: z.string().datetime(),
}).strict();

function digest(parts: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

function sessionId(scope: SessionScope): string {
  return digest([
    scope.organizationId,
    scope.threadId,
  ]);
}

function organizationNamespace(
  kind: "session-episodes-v2" | "session-transcripts-v2",
  organizationId: string,
): string[] {
  return [kind, digest([organizationId])];
}

function sameNamespace(
  actual: string[],
  expected: string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (part, index) => part === expected[index],
    )
  );
}

// Sorting object keys makes hashes stable across serialization.
export function transcriptHash(
  messages: readonly unknown[],
): string {
  const json = JSON.stringify(
    messages,
    (_key, value: unknown) => {
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return Object.fromEntries(
          Object.entries(value).sort(
            ([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
          ),
        );
      }

      return value;
    },
  );

  return createHash("sha256")
    .update(json)
    .digest("hex");
}

export async function saveSessionTranscript(
  input: SessionScope,
  messages: unknown[],
): Promise<void> {
  const scope = ScopeSchema.parse(input);
  const id = sessionId(scope);

  const transcript = TranscriptSchema.parse({
    ...scope,
    id,
    messages,
    updatedAt: new Date().toISOString(),
  });

  await memoryStore.put(
    organizationNamespace(
      "session-transcripts-v2",
      scope.organizationId,
    ),
    id,
    { ...transcript },
    false,
  );
}

export async function loadSessionTranscript(
  input: SessionScope,
) {
  const scope = ScopeSchema.parse(input);
  const id = sessionId(scope);

  const item = await memoryStore.get(
    organizationNamespace(
      "session-transcripts-v2",
      scope.organizationId,
    ),
    id,
  );

  if (!item) {
    return null;
  }

  const transcript = TranscriptSchema.parse(item.value);

  if (
    transcript.id !== id ||
    transcript.organizationId !== scope.organizationId ||
    transcript.threadId !== scope.threadId
  ) {
    throw new Error("Invalid session transcript scope.");
  }

  return transcript;
}

export async function loadSessionEpisode(
  input: SessionScope,
): Promise<Episode | null> {
  const scope = ScopeSchema.parse(input);
  const id = sessionId(scope);

  const item = await memoryStore.get(
    organizationNamespace(
      "session-episodes-v2",
      scope.organizationId,
    ),
    id,
  );

  if (!item) {
    return null;
  }

  const episode = EpisodeSchema.parse(item.value);

  if (
    episode.id !== id ||
    episode.organizationId !== scope.organizationId ||
    episode.threadId !== scope.threadId
  ) {
    throw new Error("Invalid session conclusion scope.");
  }

  return episode;
}

type EpisodeUpdate = Omit<
  Episode,
  "id" | "organizationId" | "threadId" | "updatedAt"
>;

export async function saveSessionEpisode(
  input: SessionScope,
  update: EpisodeUpdate,
): Promise<void> {
  const scope = ScopeSchema.parse(input);

  const episode = EpisodeSchema.parse({
    ...update,
    ...scope,
    id: sessionId(scope),
    updatedAt: new Date().toISOString(),
  });

  await memoryStore.put(
    organizationNamespace(
      "session-episodes-v2",
      scope.organizationId,
    ),
    episode.id,
    { ...episode },
    false,
  );
}

// Organization-wide retrieval. No records are deleted.
export async function loadEpisodes({
  organizationId,
}: Pick<SessionScope, "organizationId">): Promise<Episode[]> {
  const organization = ScopeSchema.shape.organizationId.parse(
    organizationId,
  );

  const namespace = organizationNamespace(
    "session-episodes-v2",
    organization,
  );

  const episodes = new Map<string, Episode>();
  const pageSize = 100;

  for (let offset = 0; ; offset += pageSize) {
    const items = await memoryStore.search(namespace, {
      filter: { organizationId: organization },
      limit: pageSize,
      offset,
    });

    for (const item of items) {
      const episode = EpisodeSchema.parse(item.value);

      if (
        !sameNamespace(item.namespace, namespace) ||
        episode.organizationId !== organization ||
        episode.id !== item.key ||
        episode.id !== sessionId(episode)
      ) {
        throw new Error(
          "Invalid organization session conclusion.",
        );
      }

      episodes.set(episode.id, episode);
    }

    if (items.length < pageSize) {
      break;
    }
  }

  return [...episodes.values()];
}