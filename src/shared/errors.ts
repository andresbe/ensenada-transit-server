import { NextFunction, Request, Response } from "express";
import { sendError } from "./response";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
};

export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const parserError = error as { type?: string } | null;
  if (parserError?.type === "entity.too.large") return sendError(res, 413, "JSON body exceeds the allowed size.");
  if (parserError?.type === "entity.parse.failed") return sendError(res, 400, "Invalid JSON body.");
  if (error instanceof AppError) {
    return sendError(res, error.statusCode, error.message, error.details);
  }

  const databaseCode = (error as {code?: string} | null)?.code;
  if (databaseCode === "42501") return sendError(res,403,"No tienes permiso para acceder a este recurso.");
  if (databaseCode === "23503") return sendError(res,400,"Referenced record does not exist.");
  if (databaseCode === "23505") return sendError(res,409,"Record already exists.");
  if (databaseCode === "23502" || databaseCode === "23514" || databaseCode === "22P02" || databaseCode === "22003") return sendError(res,400,"Invalid record values.");

  console.error(error);
  return sendError(res, 500, "Internal server error");
};
