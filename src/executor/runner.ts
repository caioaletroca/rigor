import { spawn } from "node:child_process";
import { platform } from "node:os";

export interface CommandResult {
  command: string;
  exit_code?: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  cancelled: boolean;
}

export interface RunOptions {
  cwd: string;
  timeout_ms?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export async function runCommand(
  command: string,
  options: RunOptions,
): Promise<CommandResult> {
  if (command === "") {
    return {
      command,
      exit_code: 0,
      stdout: "",
      stderr: "",
      duration_ms: 0,
      timed_out: false,
      cancelled: false,
    };
  }

  const start = Date.now();
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  const timeout = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      env,
      windowsHide: true,
      detached: platform() !== "win32",
    });
    child.stdin?.end();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let terminating = false;
    let settled = false;

    const append = (chunks: Buffer[], chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) return;
      const limited = chunk.subarray(0, remaining);
      outputBytes += limited.length;
      chunks.push(limited);
    };

    const terminate = (reason: "timeout" | "cancelled") => {
      if (settled || terminating) return;
      terminating = true;
      timedOut = reason === "timeout";
      cancelled = reason === "cancelled";
      clearTimeout(timeoutHandle);
      if (platform() === "win32" && child.pid !== undefined) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
      } else if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
          setTimeout(() => {
            if (!settled) {
              try {
                process.kill(-child.pid!, "SIGKILL");
              } catch {
                // The process group has already exited.
              }
            }
          }, 1_000).unref();
        } catch {
          child.kill("SIGTERM");
        }
      }
    };

    const timeoutHandle = setTimeout(() => terminate("timeout"), timeout);
    const onAbort = () => terminate("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout?.on("data", (chunk: Buffer) => {
      append(stdoutChunks, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      append(stderrChunks, chunk);
    });
    child.on("error", (error) => {
      append(stderrChunks, Buffer.from(error.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        command,
        exit_code: timedOut || cancelled ? undefined : (code ?? -1),
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        duration_ms: Date.now() - start,
        timed_out: timedOut,
        cancelled,
      });
    });
  });
}
