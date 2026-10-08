import { AsyncLocalStorage } from "node:async_hooks";
export type LineRole = "admin" | "operator" | "viewer";
export type LineContext = { lineId: string; adminId: string; role: LineRole; tokenVersion: number };
export const lineContext = new AsyncLocalStorage<LineContext>();
export function currentLine() { return lineContext.getStore(); }
