import { z } from "zod";

function requiredText(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine(
      (value) => !value.includes("\u0000"),
      "Null characters are not allowed.",
    );
}

export const proceduralMemorySchema = z.object({
  organizationId: requiredText(128),
  employeeId: requiredText(128),
  procedureId: requiredText(128),
  title: requiredText(200),
  instructions: requiredText(16000),
}).strict();

export type ProceduralMemoryInput =
  z.infer<typeof proceduralMemorySchema>;