import { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "../shared/errors";
import { sendError } from "../shared/response";

/**
 * Centralized error handler – must be registered as the last middleware.
 */
export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (error instanceof AppError) {
    sendError(res, error.statusCode, error.message, error.details);
    return;
  }

  console.error("[errorHandler] Unhandled error:", error);
  sendError(res, 500, "Internal server error");
};

/**
 * Wraps an async route handler so that any rejected promise is forwarded
 * to Express's next(err) error pipeline.
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
