import { Response } from "express";

export const sendSuccess = <T>(res: Response, data: T, statusCode = 200) => {
  return res.status(statusCode).json(data);
};

export const sendError = (
  res: Response,
  statusCode: number,
  message: string,
  details?: unknown,
) => {
  return res.status(statusCode).json({
    error: {
      message,
      ...(details === undefined ? {} : { details }),
    },
  });
};
