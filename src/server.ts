import { app } from "./api/app.js";
import { config } from "./config.js";
import {
  closeMemory,
  initializeMemory,
} from "./graph/checkpointer.js";

function reportError(error: unknown): void {
  console.error(
    "API server failed:",
    error instanceof Error ? error.message : String(error),
  );

  process.exitCode = 1;
}

async function main(): Promise<void> {
  await initializeMemory();

  const server = app.listen(config.port, config.host, () => {
    console.log(
      `API listening at http://${config.host}:${config.port}`,
    );
  });

  let stopping = false;

  function shutdown(): void {
    if (stopping) {
      return;
    }

    stopping = true;

    server.close((error) => {
      if (error) {
        reportError(error);
      }

      void closeMemory().catch(reportError);
    });
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.on("error", (error) => {
    reportError(error);
    shutdown();
  });
}

void main().catch((error: unknown) => {
  reportError(error);
  void closeMemory().catch(reportError);
});