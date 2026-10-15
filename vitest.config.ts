import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], exclude: ['tests/bedrock.integration.test.ts'], testTimeout: 30000 } });
