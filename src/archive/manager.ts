import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { CycleState } from "../state/schema.js";

export interface ArchiveResult {
  path: string;
  evidenceCount: number;
}

export class ArchiveManager {
  private readonly rigorDir: string;
  private readonly statePath: string;
  private readonly evidenceDir: string;
  private readonly historyDir: string;

  constructor(projectRoot: string) {
    this.rigorDir = join(projectRoot, ".rigor");
    this.statePath = join(this.rigorDir, "state.json");
    this.evidenceDir = join(this.rigorDir, "evidence");
    this.historyDir = join(this.rigorDir, "history");
  }

  restoreEvidence(archivePath: string): void {
    const archivedEvidenceDir = join(archivePath, "evidence");
    if (!existsSync(archivedEvidenceDir)) {
      throw new Error("Cannot restore evidence: archive evidence does not exist.");
    }

    rmSync(this.evidenceDir, { recursive: true, force: true });
    mkdirSync(this.evidenceDir, { recursive: true });
    for (const file of readdirSync(archivedEvidenceDir)) {
      cpSync(join(archivedEvidenceDir, file), join(this.evidenceDir, file), { recursive: true });
    }
  }

  archive(state: CycleState, completedAt = new Date()): ArchiveResult {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(state.cycle_id)) {
      throw new Error("Cannot archive cycle: cycle ID is not a safe directory name.");
    }

    if (!existsSync(this.statePath)) {
      throw new Error("Cannot archive cycle: active state.json does not exist.");
    }

    mkdirSync(this.historyDir, { recursive: true });
    const archiveName = this.archiveName(state.cycle_id, completedAt);
    const archivePath = this.nextArchivePath(archiveName);
    const stagingPath = `${archivePath}.tmp`;
    const archiveEvidenceDir = join(stagingPath, "evidence");
    const evidenceFiles = this.evidenceFiles();

    try {
      mkdirSync(archiveEvidenceDir, { recursive: true });
      copyFileSync(this.statePath, join(stagingPath, "state.json"));
      for (const file of evidenceFiles) {
        const destination = join(archiveEvidenceDir, file);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(this.evidenceDir, file), destination);
      }

      this.validateArchive(stagingPath, state, evidenceFiles);
      renameSync(stagingPath, archivePath);
      return { path: archivePath, evidenceCount: evidenceFiles.length };
    } catch (error) {
      rmSync(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  private evidenceFiles(directory = this.evidenceDir, prefix = ""): string[] {
    if (!existsSync(directory)) return [];

    return readdirSync(directory).flatMap((file) => {
      if (file.endsWith(".tmp")) return [];
      const path = join(directory, file);
      const relativePath = join(prefix, file);
      return lstatSync(path).isDirectory()
        ? this.evidenceFiles(path, relativePath)
        : [relativePath];
    });
  }

  private validateArchive(
    archivePath: string,
    state: CycleState,
    evidenceFiles: string[],
  ): void {
    const archivedState = JSON.parse(
      readFileSync(join(archivePath, "state.json"), "utf-8"),
    ) as CycleState;
    if (archivedState.cycle_id !== state.cycle_id) {
      throw new Error("Cannot archive cycle: copied state does not match active cycle.");
    }

    const archivedEvidence = this.evidenceFiles(join(archivePath, "evidence"));
    if (
      archivedEvidence.length !== evidenceFiles.length ||
      evidenceFiles.some((file) => !archivedEvidence.includes(file))
    ) {
      throw new Error("Cannot archive cycle: copied evidence does not match active evidence.");
    }
  }

  private archiveName(cycleId: string, completedAt: Date): string {
    const timestamp = completedAt.toISOString().replace(/[:.]/g, "-");
    return `${cycleId}-${timestamp}`;
  }

  private nextArchivePath(name: string): string {
    let candidate = join(this.historyDir, name);
    let suffix = 1;
    while (existsSync(candidate) || existsSync(`${candidate}.tmp`)) {
      candidate = join(this.historyDir, `${name}-${suffix}`);
      suffix++;
    }
    return candidate;
  }
}
