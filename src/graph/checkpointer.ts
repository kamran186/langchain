import { createHash } from "node:crypto";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

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

const EMPLOYEE_PREFERENCE_KEYS = [
  "preferred_name",
  "mention_name_in_replies",
] as const;

function employeeNamespace(
  context: RequestContext,
): string[] {
  const key = createHash("sha256")
    .update(JSON.stringify([
      context.organizationId,
      context.employeeId,
    ]))
    .digest("hex");

  return ["employee-profile", key];
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