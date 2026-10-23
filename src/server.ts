
import { app } from "./api/app.js";
import { config } from "./config.js";
const server = app.listen(config.port, config.host, () => {
  console.log(
    "API Call"
  );
});

server.on("error", (error) => {
  console.error("API server failed:", error.message);
  process.exitCode = 1;
});