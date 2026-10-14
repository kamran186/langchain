import "dotenv/config";
import { ChatBedrockConverse } from "@langchain/aws";
import { createCalculatorGraph } from "./graph.js";
import { createApiServer } from "./http.js";
import { createReportTools } from "./tools/report.js";

export function start() {
  const apiKey = process.env.BEDROCK_API_KEY?.trim();
  if (!apiKey) throw new Error("Set BEDROCK_API_KEY in .env before starting the API.");

  const model = new ChatBedrockConverse({
    region: process.env.BEDROCK_REGION || "us-east-1",
    model: process.env.BEDROCK_MODEL || "qwen.qwen3-vl-235b-a22b",
    bedrockBearerToken: apiKey,
    temperature: 0,
    maxTokens: 256,
  });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const reportTools = createReportTools({ outputDir: process.env.REPORTS_DIR });
  return createApiServer(createCalculatorGraph(model, { reportTools })).listen(port, host, () => {
    console.log(`DMAS API listening on http://${host}:${port}`);
  });
}
