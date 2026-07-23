#!/usr/bin/env node

/**
 * Rigor CLI -- Commander-based entry point.
 *
 * Subcommands:
 *   serve    Start the MCP gate server (default)
 *   install  Install Rigor skills into an AI coding tool
 */

import { Command } from "commander";
import { createServer } from "./server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { handleInstallCommands } from "./tools/scaffold.js";

const program = new Command();

program
  .name("rigor")
  .description("Deterministic quality gate enforcement for AI-assisted development")
  .version("0.1.0");

// ---------------------------------------------------------------------------
// serve -- start MCP server (default command)
// ---------------------------------------------------------------------------

program
  .command("serve", { isDefault: true })
  .description("Start the MCP gate server over stdio")
  .option("--project-root <path>", "Project root directory", process.cwd())
  .action(async (opts: { projectRoot: string }) => {
    const { server } = createServer(opts.projectRoot);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });

// ---------------------------------------------------------------------------
// install -- install skills into an AI coding tool
// ---------------------------------------------------------------------------

program
  .command("install")
  .description("Install Rigor skills as slash commands for your AI coding tool")
  .requiredOption(
    "--client <name>",
    "Target client: opencode, claude, or hermes",
  )
  .option("--global", "Install globally (all projects) instead of per-project", false)
  .option("--project-root <path>", "Project root directory (for per-project installs)", process.cwd())
  .action(async (opts: { client: string; global: boolean; projectRoot: string }) => {
    const client = opts.client as "opencode" | "claude" | "hermes";
    if (!["opencode", "claude", "hermes"].includes(client)) {
      process.stderr.write(`Unknown client: ${opts.client}. Use opencode, claude, or hermes.\n`);
      process.exit(1);
    }

    const result = await handleInstallCommands(
      { client, global: opts.global },
      opts.projectRoot,
    );

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    process.stdout.write(text + "\n");

    if (result.isError) {
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`rigor fatal: ${message}\n`);
  process.exit(1);
});
