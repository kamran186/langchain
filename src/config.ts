function readConfig() {
    const apiKey = process.env.BEDROCK_API_KEY?.trim();

    if (!apiKey) {
        throw new Error(
            "BEDROCK_API_KEY is missing. Copy .env.example to .env and enter your key.",
        );
    }
    const port = Number(process.env.PORT?.trim() || "3000");

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be an integer between 1 and 65535.");
    }

    return {
        apiKey,
        region: process.env.BEDROCK_REGION?.trim() || "us-east-1",
        model: process.env.BEDROCK_MODEL?.trim() || "qwen.qwen3-vl-235b-a22b",
        host: process.env.HOST?.trim() || "127.0.0.1",
        port,
    };
}

export const config = readConfig();