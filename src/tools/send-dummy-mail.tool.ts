import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const dummyMailInput = z.object({
  receiver: z.email(),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(64000),
}).strict();

export function createSendDummyMailTool() {
  return tool(async ({ receiver, subject }) => JSON.stringify({
    status: 'simulated', sent: false, receiver, subject,
    message: 'Dummy mail prepared. No email was sent.',
  }), {
    name: 'send_dummy_mail',
    description: 'Prepare a dummy email with receiver, subject, and body when the user explicitly asks for a simulated or dummy email. Return a simulation result only: no email is delivered. The final answer must say that no email was sent.',
    schema: dummyMailInput,
  });
}
