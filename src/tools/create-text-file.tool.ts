import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const textFileInput = z.object({
  content: z.string().trim().min(1).max(64000),
}).strict();

export function createTextFileTool(outputDir = path.resolve('output')) {
  return tool(async ({ content }) => {
    try {
      await mkdir(outputDir, { recursive: true });
      const filePath = path.join(outputDir, `${randomUUID()}.txt`);
      await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
      return JSON.stringify({ status: 'created', path: filePath, bytes: Buffer.byteLength(content, 'utf8') });
    } catch {
      return JSON.stringify({ error: 'Text file creation failed' });
    }
  }, {
    name: 'create_text_file',
    description: 'Save the prepared response as a new .txt file in the project output folder when the user explicitly asks for a text file or export. Gather required facts first, supply the response text as content, and include the returned path in the final answer. Do not use when no file is requested.',
    schema: textFileInput,
  });
}
