import { z } from "zod";

// IDs are required strings and are preserved exactly as supplied, including empty strings.
export const requestContextSchema = z.object({
  organizationId: z.string(),
  employeeId: z.string(),
  userId: z.string(),
});
export type RequestContext = z.infer<typeof requestContextSchema>;

export const sessionContextSchema = requestContextSchema.extend({
  sessionId: z.string().refine((value) => value.trim().length > 0, "sessionId is required"),
});
export type SessionContext = z.infer<typeof sessionContextSchema>;

export function requestContext(input: RequestContext): RequestContext {
  return { organizationId: input.organizationId, employeeId: input.employeeId, userId: input.userId };
}

export function sessionContext(input: SessionContext): SessionContext {
  return { ...requestContext(input), sessionId: input.sessionId };
}
