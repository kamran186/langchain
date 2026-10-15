import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/bedrock.integration.test.ts'], testTimeout: 60000 } });
