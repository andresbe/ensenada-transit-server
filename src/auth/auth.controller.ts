import { Request, Response } from "express";
import { sendSuccess } from "../shared/response";
import {
  guestAuth,
  login,
  loginConductor,
  refreshToken,
  register,
  socialAuth,
} from "./auth.service";
import { validateEmail, validateLoginInput, validateRegisterInput } from "./validators";
import { loginAdmin, publicAdmin, getActiveAdmin } from "./admin.service";
import { AppError } from "../shared/errors";

export const adminLoginHandler = async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const { email, password } = validateLoginInput(req.body);
  sendSuccess(res, await loginAdmin(email, password));
};

export const adminMeHandler = async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.user) throw new AppError("Unauthorized.", 401);
  const user = publicAdmin(await getActiveAdmin(req.user));
  sendSuccess(res, { user });
};

export const registerHandler = async (req: Request, res: Response): Promise<void> => {
  const input = validateRegisterInput(req.body);
  const result = await register(input);
  sendSuccess(res, result, 201);
};

export const loginHandler = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = validateLoginInput(req.body);
  const result = await login(email, password);
  sendSuccess(res, result);
};

export const conductorLoginHandler = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const email = validateEmail(body.email);

  if (typeof body.password !== "string" || body.password.length === 0) {
    res.status(400).json({ error: { message: "password is required." } });
    return;
  }

  const result = await loginConductor(email, body.password);
  sendSuccess(res, result);
};

export const socialHandler = async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const body = req.body as {
    password?: unknown;
    provider?: unknown;
    provider_token?: unknown;
    email?: unknown;
    display_name?: unknown;
    photo_url?: unknown;
  };

  if (body.provider !== "google" && body.provider !== "apple") {
    res.status(400).json({ error: { message: "provider must be 'google' or 'apple'." } });
    return;
  }
  if (typeof body.provider_token !== "string" || body.provider_token.trim() === "") {
    res.status(400).json({ error: { message: "provider_token is required." } });
    return;
  }

  const result = await socialAuth({
    password: typeof body.password === "string" ? body.password : undefined,
    provider: body.provider,
    provider_token: body.provider_token,
    email: typeof body.email === "string" ? body.email : undefined,
    display_name: typeof body.display_name === "string" ? body.display_name : undefined,
    photo_url: typeof body.photo_url === "string" ? body.photo_url : undefined,
  });

  sendSuccess(res, result);
};

export const guestHandler = async (_req: Request, res: Response): Promise<void> => {
  const result = await guestAuth();
  sendSuccess(res, result, 201);
};

export const refreshHandler = async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const body = req.body as { token?: unknown };
  if (typeof body.token !== "string" || body.token.trim() === "") {
    res.status(400).json({ error: { message: "token is required." } });
    return;
  }
  const result = await refreshToken(body.token);
  sendSuccess(res, result);
};
