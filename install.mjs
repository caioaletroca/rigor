#!/usr/bin/env node

import { existsSync, mkdirSync, symlinkSync, readlinkSync, unlinkSync } from "fs";
import { resolve, join, dirname } from "path";
import { createInterface } from "readline";
import { platform, homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_SOURCE = resolve(__dirname, "skills");
const HOME = homedir();

const ASSISTANTS = [
  {
    name: "Claude Code",
    skillsDir: join(HOME, ".claude", "skills", "rigor"),
    detectDir: join(HOME, ".claude"),
  },
  {
    name: "Cursor",
    skillsDir: join(HOME, ".cursor", "skills", "rigor"),
    detectDir: join(HOME, ".cursor"),
  },
  {
    name: "OpenCode",
    skillsDir: join(HOME, ".opencode", "skills", "rigor"),
    detectDir: join(HOME, ".opencode"),
  },
];

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
        log(`Already linked: ${linkPath}`);
        return "exists";
      }
    } catch {
      // Not a symlink
    }
    log(`Removing existing: ${linkPath}`);
    unlinkSync(linkPath);
  }

  // On Windows, use 'junction' for directories (no admin required)
  const type = platform() === "win32" ? "junction" : "dir";
  symlinkSync(target, linkPath, type);
  log(`Linked: ${linkPath} -> ${target}`);
  return "created";
}

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

async function install() {
  logHeader(`Rigor Installer`);
  log(`Skills source: ${SKILLS_SOURCE}`);
  log(`Home directory: ${HOME}`);

  const detected = detectAssistants();
  const targets = await selectAssistants(detected);

  if (!targets || targets.length === 0) {
    log("No assistants selected. Aborting.");
    process.exit(0);
  }

  logHeader("Creating symlinks");
  for (const assistant of targets) {
    createSymlink(SKILLS_SOURCE, assistant.skillsDir);
  }

  logHeader("Done");
  log("Rigor skills installed globally for your user.");
  log("All projects will have access to rigor: skills.");
  log("Run 'git pull' in the rigor repo to update skills.\n");
}

async function uninstall() {
  logHeader("Uninstalling Rigor skills");

  let removed = 0;
  for (const assistant of ASSISTANTS) {
    if (existsSync(assistant.skillsDir)) {
      try {
        readlinkSync(assistant.skillsDir);
        unlinkSync(assistant.skillsDir);
        log(`Removed: ${assistant.skillsDir}`);
        removed++;
      } catch {
        log(`Skipped (not a symlink): ${assistant.skillsDir}`);
      }
    }
  }

  if (removed === 0) {
    log("No Rigor symlinks found.");
  } else {
    log(`Removed ${removed} symlink(s).`);
  }
  console.log();
}

function status() {
  logHeader("Rigor Installation Status");
  log(`Skills source: ${SKILLS_SOURCE}`);
  console.log();

  for (const assistant of ASSISTANTS) {
    const exists = existsSync(assistant.skillsDir);
    let state = "not installed";

    if (exists) {
      try {
        const target = readlinkSync(assistant.skillsDir);
        state = resolve(target) === resolve(SKILLS_SOURCE)
          ? "installed (current)"
          : `linked to: ${target}`;
      } catch {
        state = "exists (not a symlink)";
      }
    }

    log(`${assistant.name}: ${state}`);
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
  install     Symlink rigor skills to your home directory (default)
  uninstall   Remove rigor symlinks
  status      Show installation status for each assistant
  help        Show this message

Installs to:
  Claude Code   ~/.claude/skills/rigor/
  Cursor        ~/.cursor/skills/rigor/
  OpenCode      ~/.opencode/skills/rigor/

Examples:
  node install.mjs              # Install for detected assistants
  node install.mjs status       # Check what's installed
  node install.mjs uninstall    # Remove all symlinks
`);
    break;
  default:
    console.error(`Unknown command: ${command}. Run 'node install.mjs help' for usage.`);
    process.exit(1);
}
