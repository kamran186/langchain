import { createApp } from './app.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const { app, pool } = await createApp({ env });
const server = app.listen(env.PORT, () => console.info(`Listening on port ${env.PORT}`));
for (const signal of ['SIGINT','SIGTERM'] as const) {
  process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))));
}
