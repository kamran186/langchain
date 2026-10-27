import type {
  StructuredToolInterface,
} from "@langchain/core/tools";

import { add, divide, multiply } from "./arithmetic.js";
import { getCustomer } from "./customer.js";
import { console as consoleTool } from "./dummytool.js";

import {
  getSessionConversation,
} from "./session-history.js";

export const availableTools: StructuredToolInterface[] = [
  add,
  multiply,
  divide,
  getCustomer,
  consoleTool,
  getSessionConversation,
];

export const toolsByName = new Map<
  string,
  StructuredToolInterface
>();

for (const registeredTool of availableTools) {
  if (toolsByName.has(registeredTool.name)) {
    throw new Error(
      `Duplicate tool name: ${registeredTool.name}`,
    );
  }

  toolsByName.set(
    registeredTool.name,
    registeredTool,
  );
}