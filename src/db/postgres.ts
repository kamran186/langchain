import { BedrockEmbeddings } from "@langchain/aws";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import pg from "pg";
import { PostgresMemory } from "../memory.js";
import { CustomerRepository } from "./customers.js";

export async function connectPostgres(config: {
  databaseUrl: string;
  region: string;
  bedrockApiKey?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
}) {
  const embeddings = new BedrockEmbeddings({
    region: config.region,
    bedrockBearerToken: config.bedrockApiKey,
    model: config.embeddingModel ?? "amazon.titan-embed-text-v2:0",
    dimensions: config.embeddingDimensions ?? 512,
  });
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const checkpointer = new PostgresSaver(pool);
  const customers = new CustomerRepository(pool);
  const store = PostgresStore.fromConnString(config.databaseUrl, {
    index: { dims: config.embeddingDimensions ?? 512, embed: embeddings, fields: ["text"] },
  });
  try {
    await checkpointer.setup();
    await store.setup();
    await customers.ensureSchema();
  } catch (error) {
    await Promise.allSettled([store.stop(), pool.end()]);
    throw error;
  }
  return {
    checkpointer, store, customers, memory: new PostgresMemory(store),
    close: async () => { await store.stop(); await pool.end(); },
  };
}
