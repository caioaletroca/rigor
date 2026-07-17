#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  symlinkSync,
  readlinkSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "fs";
import { resolve, join, dirname, relative } from "path";
import { createInterface } from "readline";
import { platform, homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_SOURCE = resolve(__dirname, "skills");
const HOME = homedir();

const ASSISTANTS = [
  {
    name: "Claude Code",
    skillsRoot: join(HOME, ".claude", "skills"),
    detectDir: join(HOME, ".claude"),
  },
  {
    name: "Cursor",
    skillsRoot: join(HOME, ".cursor", "skills"),
    detectDir: join(HOME, ".cursor"),
  },
  {
    name: "OpenCode",
    skillsRoot: join(HOME, ".opencode", "skills"),
    detectDir: join(HOME, ".opencode"),
  },
];

// --- Skill Discovery ---

function discoverSkills() {
  const skills = [];

  for (const entry of readdirSync(SKILLS_SOURCE)) {
    const entryPath = join(SKILLS_SOURCE, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    // Direct skill: skills/<name>/SKILL.md
    if (existsSync(join(entryPath, "SKILL.md"))) {
      skills.push({ name: entry, sourcePath: entryPath });
      continue;
    }

    // Nested skills: skills/<namespace>/<name>/SKILL.md (e.g., lang/go)
    for (const sub of readdirSync(entryPath)) {
      const subPath = join(entryPath, sub);
      if (statSync(subPath).isDirectory() && existsSync(join(subPath, "SKILL.md"))) {
        skills.push({ name: `${entry}-${sub}`, sourcePath: subPath });
      }
    }
  }

  return skills;
}

// --- Symlink Helpers ---

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question(question, (answer) => {
      rl.close();
      r(answer.trim());
    });
  });
}

function log(msg) {
  console.log(`  ${msg}`);
}

function logHeader(msg) {
  console.log(`\n${msg}`);
  console.log("-".repeat(msg.length));
}

function createSymlink(target, linkPath) {
  const linkDir = dirname(linkPath);
  if (!existsSync(linkDir)) {
    mkdirSync(linkDir, { recursive: true });
  }

  if (existsSync(linkPath)) {
    try {
      const existing = readlinkSync(linkPath);
      if (resolve(existing) === resolve(target)) {
        return "exists";
      }
    } catch {
      // Not a symlink
    }
    unlinkSync(linkPath);
  }

  const type = platform() === "win32" ? "junction" : "dir";
  symlinkSync(target, linkPath, type);
  return "created";
}

function isRigorSymlink(linkPath) {
  try {
    const target = resolve(readlinkSync(linkPath));
    return target.startsWith(resolve(SKILLS_SOURCE));
  } catch {
    return false;
  }
}

function removeLegacySymlink(skillsRoot) {
  const legacyPath = join(skillsRoot, "rigor");
  if (existsSync(legacyPath) && isRigorSymlink(legacyPath)) {
    unlinkSync(legacyPath);
    log(`Removed legacy symlink: ${legacyPath}`);
    return true;
  }
  return false;
}

// --- Assistant Selection ---

function detectAssistants() {
  return ASSISTANTS.filter((a) => existsSync(a.detectDir));
}

async function selectAssistants(detected) {
  if (detected.length > 0) {
    log(`Detected: ${detected.map((a) => a.name).join(", ")}`);
    const answer = await ask(`\n  Install for these? (y/n/all) [y]: `);

    if (answer.toLowerCase() === "all") return ASSISTANTS;
    if (answer.toLowerCase() !== "n") return detected;
  } else {
    log("No coding assistants detected in home directory.");
  }

  console.log("\n  Available assistants:");
  ASSISTANTS.forEach((a, i) => log(`  ${i + 1}. ${a.name}`));
  const choice = await ask(`\n  Select (comma-separated numbers, or 'all'): `);

  if (choice.toLowerCase() === "all") return ASSISTANTS;

  const indices = choice.split(",").map((s) => parseInt(s.trim()) - 1);
  return indices
    .filter((i) => i >= 0 && i < ASSISTANTS.length)
    .map((i) => ASSISTANTS[i]);
}

// --- Commands ---

async function install() {
  logHeader("Rigor Installer");
  log(`Skills source: ${SKILLS_SOURCE}`);

  const skills = discoverSkills();
  log(`Skills found: ${skills.length} (${skills.map((s) => s.name).join(", ")})`);

  const detected = detectAssistants();
  const targets = await selectAssistants(detected);

  if (!targets || targets.length === 0) {
    log("No assistants selected. Aborting.");
    process.exit(0);
  }

  logHeader("Creating symlinks");

  for (const assistant of targets) {
    log(`\n  ${assistant.name}:`);
    removeLegacySymlink(assistant.skillsRoot);

    let created = 0;
    let existing = 0;

    for (const skill of skills) {
      const linkPath = join(assistant.skillsRoot, skill.name);
      const result = createSymlink(skill.sourcePath, linkPath);
      if (result === "created") created++;
      else existing++;
    }

    log(`  ${created} created, ${existing} already linked`);
  }

  logHeader("Done");
  log("Rigor skills installed as per-skill symlinks.");
  log("Run 'git pull' in the rigor repo to update skills.\n");
}

async function uninstall() {
  logHeader("Uninstalling Rigor skills");

  let removed = 0;

  for (const assistant of ASSISTANTS) {
    if (!existsSync(assistant.skillsRoot)) continue;

    // Remove legacy single symlink
    if (removeLegacySymlink(assistant.skillsRoot)) removed++;

    // Remove per-skill symlinks
    for (const entry of readdirSync(assistant.skillsRoot)) {
      const entryPath = join(assistant.skillsRoot, entry);
      if (isRigorSymlink(entryPath)) {
        unlinkSync(entryPath);
        log(`Removed: ${entryPath}`);
        removed++;
      }
    }
  }

  if (removed === 0) {
    log("No Rigor symlinks found.");
  } else {
    log(`\nRemoved ${removed} symlink(s).`);
  }
  console.log();
}

function status() {
  logHeader("Rigor Installation Status");
  log(`Skills source: ${SKILLS_SOURCE}`);

  const skills = discoverSkills();
  log(`Skills available: ${skills.length}`);

  for (const assistant of ASSISTANTS) {
    console.log(`\n  ${assistant.name}:`);

    if (!existsSync(assistant.detectDir)) {
      log("  not detected");
      continue;
    }

    // Check for legacy symlink
    const legacyPath = join(assistant.skillsRoot, "rigor");
    if (existsSync(legacyPath) && isRigorSymlink(legacyPath)) {
      log("  WARNING: legacy single symlink detected (run install to fix)");
    }

    let installed = 0;
    let missing = 0;

    for (const skill of skills) {
      const linkPath = join(assistant.skillsRoot, skill.name);
      if (existsSync(linkPath) && isRigorSymlink(linkPath)) {
        installed++;
      } else {
        missing++;
        log(`  missing: ${skill.name}`);
      }
    }

    if (missing === 0) {
      log(`  all ${installed} skills installed`);
    } else {
      log(`  ${installed} installed, ${missing} missing`);
    }
  }
  console.log();
}

// --- CLI ---

const command = process.argv[2] || "install";

switch (command) {
  case "install":
    await install();
    break;
  case "uninstall":
    await uninstall();
    break;
  case "status":
    status();
    break;
  case "help":
    console.log(`
Rigor Installer
---------------
Usage: node install.mjs [command]

Commands:
  install     Symlink rigor skills to your coding assistants (default)
  uninstall   Remove all rigor symlinks
  status      Show installation status per skill per assistant
  help        Show this message

Installs per-skill symlinks to:
  Claude Code   ~/.claude/skills/<skill-name>/
  Cursor        ~/.cursor/skills/<skill-name>/
  OpenCode      ~/.opencode/skills/<skill-name>/

Examples:
  node install.mjs              # Install for detected assistants
  node install.mjs status       # Check what's installed
  node install.mjs uninstall    # Remove all symlinks
`);
    break;
  default:
    console.error(
      `Unknown command: ${command}. Run 'node install.mjs help' for usage.`
    );
    process.exit(1);
}
