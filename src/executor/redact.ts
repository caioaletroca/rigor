const SECRET_NAME = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|auth)/i;

export function redact(value: string, env?: Record<string, string>): string {
  let result = value;
  for (const [key, secret] of Object.entries(env ?? {})) {
    if (secret && SECRET_NAME.test(key)) result = result.split(secret).join("[REDACTED]");
  }
  return result.replace(/((?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization)\s*[=:]\s*)([^\s,'";]+)/gi, "$1[REDACTED]");
}

export function redactEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, SECRET_NAME.test(key) ? "[REDACTED]" : value]));
}
