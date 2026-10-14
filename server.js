import { pathToFileURL } from "node:url";
import { start } from "./src/runtime.js";

export { arithmeticTools, calculate, langChainTools } from "./src/tools/arithmetic.js";
export { evaluateExpression } from "./src/calculator.js";
export { createCalculatorGraph } from "./src/graph.js";
export { createApiHandler, createApiServer } from "./src/http.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    start();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
