import { createHash } from "node:crypto";
import { z } from "zod";

import { memoryStore } from "./checkpointer.js";

export const ProceduralContextSchema = z.object({
  procedureId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(16000),
});

export type ProceduralContext =
  z.infer<typeof ProceduralContextSchema>;

type ProceduralSearchInput = {
  organizationId: string;
  queries: string[];
};

export async function searchProceduralMemory({
  organizationId,
  queries,
}: ProceduralSearchInput): Promise<ProceduralContext[]> {
  // Keep search phrases as plain words, without wildcard operators.
  const searchQueries = [
    ...new Set(
      queries
        .slice(0, 3)
        .map((query) =>
          (query.match(/[\p{L}\p{N}]+/gu) ?? [])
            .join(" ")
            .toLowerCase(),
        )
        .filter((query) => query.length > 0),
    ),
  ];

  if (searchQueries.length === 0) {
    return [];
  }

  const organizationKey = createHash("sha256")
    .update(JSON.stringify([organizationId]))
    .digest("hex");

  const namespace = [
    "procedural-org-v1",
    organizationKey,
  ];

  const batches = await Promise.all(
    searchQueries.map((query) =>
      memoryStore.search(namespace, {
        query,
        mode: "text",
        filter: { organizationId },
        limit: 5,
      }),
    ),
  );

  const ranked = new Map<
    string,
    {
      procedure: ProceduralContext;
      score: number;
    }
  >();

  for (const items of batches) {
    for (const [position, item] of items.entries()) {
      const sameNamespace =
        item.namespace.length === namespace.length &&
        item.namespace.every(
          (part, index) => part === namespace[index],
        );

      if (
        !sameNamespace ||
        item.value.organizationId !== organizationId ||
        item.value.procedureId !== item.key ||
        typeof item.score !== "number" ||
        !Number.isFinite(item.score) ||
        item.score <= 0
      ) {
        continue;
      }

      const parsed = ProceduralContextSchema.safeParse({
        procedureId: item.key,
        title: item.value.title,
        instructions: item.value.instructions,
      });

      if (!parsed.success) {
        continue;
      }

      const existing = ranked.get(item.key);

      // Combine result positions across the different search phrases.
      ranked.set(item.key, {
        procedure: parsed.data,
        score:
          (existing?.score ?? 0) +
          1 / (60 + position + 1),
      });
    }
  }

  return [...ranked.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.procedure.procedureId.localeCompare(
          right.procedure.procedureId,
        ),
    )
    .slice(0, 3)
    .map(({ procedure }) => procedure);
}