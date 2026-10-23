import type { StructuredToolInterface } from "@langchain/core/tools";

import { add, divide, multiply } from "./arithmetic.js";
import { getCustomer } from "./customer.js";
import { console } from "./dummytool.js";

// Both model binding and execution use this single list.
// Import each new tool from its own file and add it here.
export const availableTools: StructuredToolInterface[] = [
  add,
  multiply,
  divide,
  getCustomer,
  console
];

export const toolsByName = new Map<string, StructuredToolInterface>();

for (const registeredTool of availableTools) {
  if (toolsByName.has(registeredTool.name)) {
    throw new Error(`Duplicate tool name: ${registeredTool.name}`);
  }

  toolsByName.set(registeredTool.name, registeredTool);
}