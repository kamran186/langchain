import { json, Router } from "express";

import { proceduralMemorySchema } from "./procedural-memory.schema.js";
import { saveProceduralMemory } from "./procedural-memory.service.js";

export const proceduralMemoryRouter = Router();

proceduralMemoryRouter.all(
  "/",

  (req, res, next) => {
    if (req.method !== "QUERY") {
      res.setHeader("Allow", "QUERY");

      res.status(405).json({
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Use the QUERY method.",
        },
      });

      return;
    }

    next();
  },

  json({ limit: "256kb" }),

  async (req, res) => {
    const parsed = proceduralMemorySchema.safeParse(
      req.body,
    );

    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message:
            "Provide organizationId, employeeId, procedureId, title, and instructions.",
          details: parsed.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
      });

      return;
    }

    const procedure = await saveProceduralMemory(
      parsed.data,
    );

    res.status(200).json({
      saved: true,
      scope: "organization",
      procedure,
    });
  },
);