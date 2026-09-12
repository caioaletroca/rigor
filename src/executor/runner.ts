import { spawn } from "node:child_process";
import { platform } from "node:os";
import crypto from "node:crypto";
import { redact } from "./redact.js";

export type TerminationReason = "exit" | "timeout" | "cancelled" | "spawn_error" | "output_limit";

export interface CommandResult {
  command: string;
  attempt_id: string;
  started_at: string;
  finished_at: string;
  configured_timeout_ms: number;
  termination_reason: TerminationReason;
  exit_code?: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
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
  const attempt_id = crypto.randomUUID();
  const started_at = new Date().toISOString();
  if (command === "") {
    return {
      command, attempt_id, started_at, finished_at: started_at,
      configured_timeout_ms: options.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      termination_reason: "exit", exit_code: 0, stdout: "", stderr: "",
      stdout_truncated: false, stderr_truncated: false, duration_ms: 0,
      timed_out: false, cancelled: false,
    };
  }

  const start = Date.now();
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  const timeout = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (options.signal?.aborted) {
    return {
      command: redact(command, options.env), attempt_id, started_at, finished_at: new Date().toISOString(),
      configured_timeout_ms: timeout, termination_reason: "cancelled", stdout: "", stderr: "",
      stdout_truncated: false, stderr_truncated: false, duration_ms: 0, timed_out: false, cancelled: true,
    };
  }

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
    let terminationReason: TerminationReason = "exit";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let signal: NodeJS.Signals | undefined;

    const append = (chunks: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        terminationReason = "output_limit";
        terminate("output_limit");
        return;
      }
      const limited = chunk.subarray(0, remaining);
      if (limited.length < chunk.length) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        terminationReason = "output_limit";
        terminate("output_limit");
      }
      outputBytes += limited.length;
      chunks.push(limited);
    };

    const terminate = (reason: "timeout" | "cancelled" | "output_limit") => {
      if (settled || terminating) return;
      terminating = true;
      timedOut = reason === "timeout";
      cancelled = reason === "cancelled";
      terminationReason = reason;
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
      append(stdoutChunks, chunk, "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      append(stderrChunks, chunk, "stderr");
    });
    child.on("error", (error) => {
      append(stderrChunks, Buffer.from(error.message), "stderr");
      terminationReason = "spawn_error";
    });
    child.on("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
      signal = closeSignal ?? undefined;
      const finished_at = new Date().toISOString();
      resolve({
        command: redact(command, options.env), attempt_id, started_at, finished_at,
        configured_timeout_ms: timeout,
        termination_reason: terminationReason,
        exit_code: timedOut || cancelled || terminationReason === "spawn_error" ? undefined : (code ?? -1),
        signal,
        stdout: redact(Buffer.concat(stdoutChunks).toString("utf-8"), options.env),
        stderr: redact(Buffer.concat(stderrChunks).toString("utf-8"), options.env),
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        duration_ms: Date.now() - start,
        timed_out: timedOut,
        cancelled,
      });
    });
  });
}
