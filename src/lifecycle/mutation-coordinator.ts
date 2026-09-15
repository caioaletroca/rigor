import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";

function canonicalProjectRoot(projectRoot: string): string {
  const absolute = normalize(resolve(projectRoot));
  let canonical: string;
  try {
    canonical = normalize(realpathSync.native(absolute));
  } catch {
    canonical = absolute;
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

const queues = new Map<string, Promise<void>>();

export async function withProjectMutationLock<T>(
  projectRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = canonicalProjectRoot(projectRoot);
  const previous = queues.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  queues.set(key, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}
