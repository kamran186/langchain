import { createServer } from "node:http";
import * as z from "zod";
import { numericValues } from "./calculator.js";
import { RequestError } from "./errors.js";

const MAX_BODY_BYTES = 8_192;
const MAX_PROMPT_LENGTH = 2_000;

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new RequestError("Request body is too large.", 413);
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new RequestError("Request body must be valid JSON.", 400);
  }
}

function validateQuery(body) {
  if (typeof body?.prompt !== "string" || !body.prompt.trim()) {
    throw new RequestError("Provide a non-empty string in the prompt field.", 400);
  }
  if (body.prompt.length > MAX_PROMPT_LENGTH) throw new RequestError("Prompt is too long.", 413);
  if (numericValues(body.prompt).length < 2) {
    throw new RequestError("Use DMAS operations with at least two numeric values.");
  }
  if (body.saveTextFile !== undefined && typeof body.saveTextFile !== "boolean") {
    throw new RequestError("saveTextFile must be true or false.", 400);
  }
  const emailTo = typeof body.emailTo === "string" ? body.emailTo.trim() : body.emailTo;
  if (emailTo !== undefined && !z.email().safeParse(emailTo).success) {
    throw new RequestError("emailTo must be a valid email address.", 400);
  }
  return { prompt: body.prompt.trim(), saveTextFile: body.saveTextFile === true, emailTo };
}

function formatResult(result, { saveTextFile, emailTo }) {
  const body = result.operation
    ? { operation: result.operation.operation, a: result.operation.a, b: result.operation.b, result: result.result }
    : { expression: result.expression, result: result.result };
  body.steps = result.steps;
  body.explanation = result.explanation;
  body.display = result.displayText;
  if (saveTextFile) {
    body.file = result.savedFile
      ? { status: "saved", path: result.savedFile }
      : { status: "failed", error: result.saveError };
  }
  if (emailTo) body.email = result.emailDraft;
  return body;
}

export function createApiHandler(graph) {
  return async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/query") {
      sendJson(response, 404, { error: "Use POST /query." });
      return;
    }
    try {
      const input = validateQuery(await readJsonBody(request));
      const result = await graph.invoke(input);
      sendJson(response, result.saveError ? 500 : 200, formatResult(result, input));
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(response, error.statusCode, { error: error.message });
      } else {
        console.error("Bedrock request failed:", error?.name || "UnknownError");
        sendJson(response, 502, { error: "Bedrock request failed. Check the API key, model access, and region." });
      }
    }
  };
}

export function createApiServer(graph) {
  return createServer(createApiHandler(graph));
}
