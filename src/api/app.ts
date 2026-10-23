import express, { type ErrorRequestHandler } from "express";

import { conversationRouter } from "./conversation.routes.js";

export const app = express();

app.disable("x-powered-by");

app.use("/conversation", conversationRouter);

app.use((_req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Endpoint not found.",
    },
  });
});

const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  next,
) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const type =
    typeof error === "object" && error !== null && "type" in error
      ? error.type
      : undefined;

  if (type === "entity.parse.failed") {
    res.status(400).json({
      error: {
        code: "INVALID_JSON",
        message: "The request body must be valid JSON.",
      },
    });
    return;
  }

  if (type === "entity.too.large") {
    res.status(413).json({
      error: {
        code: "BODY_TOO_LARGE",
        message: "The request body exceeds 256 KB.",
      },
    });
    return;
  }

  if (type === "charset.unsupported" || type === "encoding.unsupported") {
    res.status(415).json({
      error: {
        code: "UNSUPPORTED_ENCODING",
        message: "Use UTF-8 JSON.",
      },
    });
    return;
  }

  console.error(
    "Conversation request failed:",
    error instanceof Error ? error.message : error,
  );

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
    },
  });
};

app.use(errorHandler);