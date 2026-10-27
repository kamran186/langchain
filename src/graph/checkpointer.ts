import { createHash } from "node:crypto";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { z } from "zod";

import { config } from "../config.js";
import {
  FactSchema,
  mergeFacts,
  type Fact,
  type RequestContext,
} from "./interpretation.js";

export const checkpointer = PostgresSaver.fromConnString(
  config.databaseUrl,
);

export const memoryStore = PostgresStore.fromConnString(
  config.databaseUrl,
);

const EPISODE_LIMIT = 5;

const EMPLOYEE_PREFERENCE_KEYS = [
  "preferred_name",
  "mention_name_in_replies",
] as const;

const EpisodeSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  steps: z.array(z.unknown()),
  outcome: z.string(),
  createdAt: z.string(),
  employeeId: z.string().optional(),
  threadId: z.string().optional(),
}).strict();

export type Episode = z.infer<typeof EpisodeSchema>;

function scopeKey(parts: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

function episodeNamespace(
  context: RequestContext,
): string[] {
  return [
    "episodes-org-v1",
    scopeKey([context.organizationId]),
  ];
}

function employeeNamespace(
  context: RequestContext,
): string[] {
  return [
    "employee-profile-v1",
    scopeKey([
      context.organizationId,
      context.employeeId,
    ]),
  ];
}

export function isEmployeePreference(
  fact: Pick<Fact, "subject" | "key">,
): boolean {
  return (
    fact.subject === "self" &&
    EMPLOYEE_PREFERENCE_KEYS.some(
      (key) => key === fact.key,
    )
  );
}

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

export async function loadEmployeePreferences(
  context: RequestContext,
): Promise<Fact[]> {
  const namespace = employeeNamespace(context);

  const items = await Promise.all(
    EMPLOYEE_PREFERENCE_KEYS.map((key) =>
      memoryStore.get(namespace, key),
    ),
  );

  return items.flatMap((item) =>
    item ? [FactSchema.parse(item.value)] : [],
  );
}

export async function saveEmployeePreferences(
  context: RequestContext,
  input: Fact[],
): Promise<void> {
  const preferences = mergeFacts(
    [],
    FactSchema.array()
      .parse(input)
      .filter(isEmployeePreference),
  );

  const namespace = employeeNamespace(context);

  await Promise.all(
    preferences.map((fact) =>
      memoryStore.put(
        namespace,
        fact.key,
        { ...fact },
        false,
      ),
    ),
  );
}

export async function loadEpisodes(
  context: RequestContext,
): Promise<Episode[]> {
  const items = await memoryStore.search(
    episodeNamespace(context),
    {
      limit: EPISODE_LIMIT,
    },
  );

  return items.map((item) =>
    EpisodeSchema.parse(item.value),
  );
}

export async function saveEpisode(
  context: RequestContext,
  input: Episode,
): Promise<void> {
  const namespace = episodeNamespace(context);

  const episode = EpisodeSchema.parse({
    ...input,
    employeeId: context.employeeId,
    threadId: context.threadId,
  });

  await memoryStore.put(
    namespace,
    episode.id,
    { ...episode },
    false,
  );

  // Delete older records in batches without replacing a shared list.
  while (true) {
    const older = await memoryStore.search(namespace, {
      offset: EPISODE_LIMIT,
      limit: 100,
    });

    if (older.length === 0) {
      break;
    }

    await Promise.all(
      older.map((item) =>
        memoryStore.delete(namespace, item.key),
      ),
    );
  }
}