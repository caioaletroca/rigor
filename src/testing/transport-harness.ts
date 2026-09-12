import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ProjectContextRegistry } from "../context.js";
import { createServer, type ServerContext } from "../server.js";

export type HarnessClient = "opencode" | "claude" | "hermes";

export interface HarnessSession {
  client: Client;
  server: ServerContext;
  projectRoot: string;
  clientStyle: HarnessClient;
  close(): Promise<void>;
  call<T extends Record<string, unknown> = Record<string, unknown>>(name: string, args?: T): Promise<CallToolResult>;
}

export interface HarnessRegistry {
  readonly registry: ProjectContextRegistry;
}

export function createHarnessRegistry(projectRoot: string): HarnessRegistry {
  return { registry: new ProjectContextRegistry(projectRoot) };
}

export async function createHarnessSession(
  projectRoot: string,
  clientStyle: HarnessClient,
  harnessRegistry?: HarnessRegistry,
): Promise<HarnessSession> {
  const shared = harnessRegistry ?? createHarnessRegistry(projectRoot);
  const server = createServer(projectRoot, shared.registry);
  const client = new Client(
    { name: `${clientStyle}-integration-client`, version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    server,
    projectRoot,
    clientStyle,
    call: async (name, args) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
      await server.server.close();
    },
  };
}

export async function withHarnessSessions<T>(
  sessions: Array<{ projectRoot: string; clientStyle: HarnessClient }>,
  callback: (active: HarnessSession[]) => Promise<T>,
): Promise<T> {
  const registry = createHarnessRegistry(sessions[0]?.projectRoot ?? process.cwd());
  const active = await Promise.all(
    sessions.map(({ projectRoot, clientStyle }) => createHarnessSession(projectRoot, clientStyle, registry)),
  );
  try {
    return await callback(active);
  } finally {
    await Promise.all(active.map((session) => session.close()));
  }
}
