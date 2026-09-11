import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { redact } from "../executor/redact.js";

const MAX_DIAGNOSTICS = 4_000;
const MAX_MESSAGE = 4_000;
const MAX_FIELD = 512;

function bound(value: string, max = MAX_FIELD): string {
  return redact(value).slice(0, max);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (typeof value === "string") return bound(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [bound(key), sanitize(item, depth + 1)]));
  }
  return value;
}

export interface ResponseContext {
  project_root?: string;
  cycle_id?: string;
  task_id?: string;
  attempt_id?: string;
}

export interface StructuredResponse extends ResponseContext {
  ok: boolean;
  message: string;
  guidance?: string[];
  diagnostics?: string;
}

export function responseResult(
  message: string,
  options: {
    error?: boolean;
    context?: ResponseContext;
    guidance?: string[];
    diagnostics?: unknown;
  } = {},
): CallToolResult {
  const safeMessage = bound(message, MAX_MESSAGE);
  const safeContext = options.context
    ? Object.fromEntries(Object.entries(options.context).map(([key, value]) => [key, value === undefined ? undefined : bound(value)]))
    : undefined;
  const body: StructuredResponse = {
    ok: !options.error,
    message: safeMessage,
    ...safeContext,
    ...(options.guidance?.length ? { guidance: options.guidance.slice(0, 16).map((item) => bound(item)) } : {}),
  };
  if (options.diagnostics !== undefined) {
    const raw = typeof options.diagnostics === "string"
      ? options.diagnostics
      : JSON.stringify(options.diagnostics);
    body.diagnostics = redact(raw).slice(0, MAX_DIAGNOSTICS);
  }
  let structuredBody: Record<string, unknown> = body as unknown as Record<string, unknown>;
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        structuredBody = sanitize({ ...parsed, ...body }) as Record<string, unknown>;
    }
  } catch {
    structuredBody = body as unknown as Record<string, unknown>;
  }
  return {
    content: [{ type: "text", text: safeMessage }],
    structuredContent: structuredBody,
    ...(options.error ? { isError: true } : {}),
  };
}
