import "dotenv/config";
import { connectPostgres } from "./postgres.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const { close } = await connectPostgres({
  databaseUrl,
  region: process.env.BEDROCK_REGION ?? "us-east-1",
  bedrockApiKey: process.env.BEDROCK_API_KEY,
  embeddingModel: process.env.BEDROCK_EMBEDDING_MODEL,
  embeddingDimensions: Number(process.env.BEDROCK_EMBEDDING_DIMENSIONS ?? 512),
});
console.log("Postgres checkpoints, memory store, and customers table initialized");
await close();
