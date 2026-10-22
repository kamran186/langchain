import { z } from "zod";
import type { RegisteredTool } from "./index.js";

export const serverTimeTool: RegisteredTool = {
  name: "server_time",
  description: "Read the current UTC date and time from the server",
  effect: "read",
  schema: z.object({}),
  run: async () => ({ utc: new Date().toISOString() }),
};
