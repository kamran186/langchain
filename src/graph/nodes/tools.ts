import { ToolNode } from "@langchain/langgraph/prebuilt";

import { availableTools } from "../../tools/index.js";

export const toolsNode = new ToolNode(availableTools);