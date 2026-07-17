/**
 * EvidenceManager — persists gate passage proof to `.rigor/evidence/`.
 *
 * Each gate run produces a JSON file with the checks that were performed,
 * whether they passed, and supporting detail (command, exit code, duration).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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
}

export interface GateEvidence {
  gate: string;
  entity_id: string;
  passed: boolean;
  timestamp: string;
  checks: CheckResult[];
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
    const filename = `${evidence.gate}-task-${evidence.entity_id}.json`;
    const filePath = join(this.evidenceDir, filename);
    const tmpPath = `${filePath}.tmp`;

    const data = JSON.stringify(evidence, null, 2);
    writeFileSync(tmpPath, data, "utf-8");
    renameSync(tmpPath, filePath);

    return filePath;
  }

  /**
   * Load previously saved evidence for a gate + entity pair.
   *
   * @returns The parsed evidence, or `null` when no file exists.
   */
  load(gate: string, entityId: string): GateEvidence | null {
    const filename = `${gate}-task-${entityId}.json`;
    const filePath = join(this.evidenceDir, filename);

    if (!existsSync(filePath)) {
      return null;
    }

    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as GateEvidence;
  }
}
