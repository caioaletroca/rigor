/**
 * EvidenceManager — persists gate passage proof to `.rigor/evidence/`.
 *
 * Each gate run produces a JSON file with the checks that were performed,
 * whether they passed, and supporting detail (command, exit code, duration).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ReviewFindings } from "../gates/gate8.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
  command?: string;
  exit_code?: number;
  duration_ms?: number;
  configured_timeout_ms?: number;
  timed_out?: boolean;
  cancelled?: boolean;
  attempt_id?: string;
  started_at?: string;
  finished_at?: string;
  termination_reason?: string;
  signal?: string;
  stdout?: string;
  stderr?: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

export type Gate0AttemptOutcome =
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "execution_error"
  | "interrupted";

export interface Gate0AttemptProgress {
  check_name: string;
  command: string;
  started_at: string;
  configured_timeout_ms?: number;
}

export interface Gate0Attempt {
  version: 1;
  id: string;
  owner_id?: string;
  started_at: string;
  current_check?: Gate0AttemptProgress;
  finished_at?: string;
  outcome?: Gate0AttemptOutcome;
}

export interface GateEvidence {
  gate: string;
  entity_id: string;
  passed: boolean;
  timestamp: string;
  checks: CheckResult[];
  review_submissions?: ReviewFindings[];
  gate_0_attempt?: Gate0Attempt;
}

export type Gate0AttemptClassification =
  | "active"
  | "live"
  | "stale"
  | "interrupted"
  | "terminal_passed"
  | "terminal_failed"
  | "failed"
  | "inconsistent";

export function classifyGate0Attempt(
  evidence: GateEvidence | null,
  taskStatus: string,
  isActive: boolean,
  staleAfterMs = Number.POSITIVE_INFINITY,
  now = Date.now(),
): Gate0AttemptClassification | null {
  const attempt = evidence?.gate_0_attempt;
  if (!attempt) return null;
  const startedAt = Date.parse(attempt.started_at);
  if (!Number.isFinite(startedAt)) return "inconsistent";
  if (attempt.finished_at && !Number.isFinite(Date.parse(attempt.finished_at))) return "inconsistent";
  if (!attempt.finished_at) {
    if (isActive) return "live";
    return now - startedAt >= staleAfterMs ? "stale" : "interrupted";
  }
  if (!attempt.outcome || (attempt.outcome === "passed") !== evidence.passed) {
    return "inconsistent";
  }
  if (attempt.outcome === "passed") {
    return taskStatus === "doing" || taskStatus === "done" ? "terminal_passed" : "inconsistent";
  }
  return taskStatus === "doing" || taskStatus === "failed" ? "terminal_failed" : "inconsistent";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RIGOR_DIR = ".rigor";
const EVIDENCE_DIR = "evidence";

// ---------------------------------------------------------------------------
// EvidenceManager
// ---------------------------------------------------------------------------

export class EvidenceManager {
  private readonly evidenceDir: string;

  constructor(projectRoot: string) {
    this.evidenceDir = join(projectRoot, RIGOR_DIR, EVIDENCE_DIR);

    if (!existsSync(this.evidenceDir)) {
      mkdirSync(this.evidenceDir, { recursive: true });
    }
  }

  /**
   * Persist gate evidence to disk.
   *
   * File naming: `gate-0-task-<entity_id>.json`
   * (dots in the entity id are kept as-is).
   *
   * @returns The absolute path of the written file.
   */
  save(evidence: GateEvidence): string {
    const filePath = this.pathFor(evidence.gate, evidence.entity_id);
    this.write(filePath, evidence);
    return filePath;
  }

  saveTerminalGate0Attempt(evidence: GateEvidence): string {
    const attempt = evidence.gate_0_attempt;
    if (
      evidence.gate !== "gate_0" ||
      !attempt?.finished_at ||
      !attempt.outcome
    ) {
      throw new Error("Terminal Gate 0 evidence requires a finished attempt.");
    }

    const attemptPath = this.attemptPathFor(evidence.entity_id, attempt.id);
    mkdirSync(join(this.evidenceDir, `gate_0-task-${evidence.entity_id}`), { recursive: true });
    if (!existsSync(attemptPath)) this.write(attemptPath, evidence);
    const current = this.load("gate_0", evidence.entity_id);
    if (!current) {
      this.write(this.pathFor("gate_0", evidence.entity_id), evidence);
    } else if (current.gate_0_attempt?.id === attempt.id) {
      this.write(this.pathFor("gate_0", evidence.entity_id), evidence);
    } else {
      const currentFinishedAt = current.gate_0_attempt?.finished_at ?? current.gate_0_attempt?.started_at ?? "";
      const attemptFinishedAt = attempt.finished_at ?? attempt.started_at ?? "";
      if (attemptFinishedAt > currentFinishedAt) {
        this.write(this.pathFor("gate_0", evidence.entity_id), evidence);
      } else {
        throw new Error(`Terminal Gate 0 attempt ${attempt.id} is not newer than the canonical attempt.`);
      }
    }
    return this.pathFor("gate_0", evidence.entity_id);
  }

  pathFor(gate: string, entityId: string): string {
    return join(this.evidenceDir, `${gate}-task-${entityId}.json`);
  }

  attemptPathFor(entityId: string, attemptId: string): string {
    return join(this.evidenceDir, `gate_0-task-${entityId}`, `${attemptId}.json`);
  }

  private write(filePath: string, evidence: GateEvidence): void {
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(evidence, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
  }

  /**
   * Load previously saved evidence for a gate + entity pair.
   *
   * @returns The parsed evidence, or `null` when no file exists.
   */
  load(gate: string, entityId: string): GateEvidence | null {
    const filePath = this.pathFor(gate, entityId);

    if (!existsSync(filePath)) {
      return null;
    }

    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as GateEvidence;
  }

  /**
   * Delete evidence for a specific gate + entity pair.
   *
   * @returns `true` if the file existed and was deleted, `false` otherwise.
   */
  delete(gate: string, entityId: string): boolean {
    const filePath = this.pathFor(gate, entityId);

    if (!existsSync(filePath)) {
      return false;
    }

    unlinkSync(filePath);
    return true;
  }

  latestTerminalGate0Attempt(entityId: string): GateEvidence | null {
    const historyDir = join(this.evidenceDir, `gate_0-task-${entityId}`);
    if (!existsSync(historyDir)) return null;

    return readdirSync(historyDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(historyDir, file), "utf-8")) as GateEvidence)
      .filter((evidence) => {
        const attempt = evidence.gate_0_attempt;
        return evidence.gate === "gate_0" &&
          evidence.entity_id === entityId &&
          Boolean(attempt?.finished_at && attempt.outcome) &&
          (attempt?.outcome === "passed") === evidence.passed;
      })
      .sort((a, b) =>
        (b.gate_0_attempt?.finished_at ?? b.gate_0_attempt?.started_at ?? "").localeCompare(
          a.gate_0_attempt?.finished_at ?? a.gate_0_attempt?.started_at ?? "",
        ),
      )[0] ?? null;
  }

  taskEvidenceSummary(entityId: string): { latest?: Gate0AttemptOutcome; prior: Gate0AttemptOutcome[] } {
    const latest = this.load("gate_0", entityId)?.gate_0_attempt?.outcome;
    const historyDir = join(this.evidenceDir, `gate_0-task-${entityId}`);
    if (!existsSync(historyDir)) return { latest, prior: [] };
 
    const prior = readdirSync(historyDir)

      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(historyDir, file), "utf-8")) as GateEvidence)
      .map((evidence) => evidence.gate_0_attempt)
      .filter((attempt): attempt is Gate0Attempt => Boolean(attempt?.outcome))
      .sort((a, b) => (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at))
      .filter((attempt) => attempt.id !== this.load("gate_0", entityId)?.gate_0_attempt?.id)
      .map((attempt) => attempt.outcome!);
    return { latest, prior };
  }

  taskEvidenceCount(entityId: string): number {
    let count = 0;
    for (const gate of ["gate_0", "gate_1", "custom_post_task"]) {
      if (existsSync(this.pathFor(gate, entityId))) count++;
    }
    const historyDir = join(this.evidenceDir, `gate_0-task-${entityId}`);
    return count + (existsSync(historyDir) ? this.countFiles(historyDir) : 0);
  }

  /** Delete all task-owned evidence while preserving epic review and acceptance evidence. */
  deleteTaskEvidence(entityId: string): number {
    let count = 0;
    for (const gate of ["gate_0", "gate_1", "custom_post_task"]) {
      if (this.delete(gate, entityId)) count++;
    }
    const historyDir = join(this.evidenceDir, `gate_0-task-${entityId}`);
    if (existsSync(historyDir)) {
      count += this.countFiles(historyDir);
      rmSync(historyDir, { recursive: true, force: true });
    }
    return count;
  }

  private countFiles(directory: string): number {
    return readdirSync(directory).reduce((count, entry) => {
      const path = join(directory, entry);
      return count + (lstatSync(path).isDirectory() ? this.countFiles(path) : 1);
    }, 0);
  }

  /**
   * Delete evidence for all known gates (gate_0, gate_8, gate_9) for a
   * given entity. This legacy entity-wide operation is only appropriate for
   * epic-owned evidence.
   */
  deleteAll(entityId: string): number {
    const gates = ["gate_0", "gate_8", "gate_9"];
    let count = 0;
    for (const gate of gates) {
      if (this.delete(gate, entityId)) count++;
    }
    return count;
  }

  countAll(): number {
    return existsSync(this.evidenceDir) ? this.countFiles(this.evidenceDir) : 0;
  }

  /**
   * Delete all files in the evidence directory.
   *
   * @returns The number of files deleted.
   */
  clearAll(): number {
    if (!existsSync(this.evidenceDir)) {
      return 0;
    }

    const fileCount = this.countAll();
    const stagingDir = `${this.evidenceDir}.clearing`;
    if (existsSync(stagingDir)) {
      throw new Error("Evidence cleanup staging directory already exists.");
    }

    renameSync(this.evidenceDir, stagingDir);
    try {
      mkdirSync(this.evidenceDir, { recursive: true });
      rmSync(stagingDir, { recursive: true, force: true });
       return fileCount;
    } catch (error) {
      rmSync(this.evidenceDir, { recursive: true, force: true });
      if (existsSync(stagingDir)) {
        renameSync(stagingDir, this.evidenceDir);
      }
      throw error;
    }
  }
}
