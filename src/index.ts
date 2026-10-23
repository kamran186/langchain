import { conversationAskSchema } from "./api/conversation.schema.js";
import { askConversation } from "./api/conversation.service.js";

async function main() {
const [
  organizationId,
  threadId,
  employeeId,
  ...words
] = process.argv.slice(2);

const input = conversationAskSchema.parse({
  organizationId,
  threadId,
  employeeId,
  message: words.join(" "),
});

console.log(JSON.stringify(await askConversation(input), null, 2));
}

main().catch((error: unknown) => {
console.error(
  error instanceof Error ? error.message : String(error),
);
process.exitCode = 1;
});