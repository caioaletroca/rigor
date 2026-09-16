import { describe, expect, it } from "vitest";
import {
  REGISTERED_TOOL_NAMES,
  RIGOR_SCHEMA_VERSION,
  RIGOR_SERVER_NAME,
  RIGOR_SERVER_VERSION,
  ROOT_AWARE_LIFECYCLE_TOOLS,
  handleServerInfo,
} from "../server-info.js";

function status(result: ReturnType<typeof handleServerInfo>): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("server info tool", () => {
  it("reports the canonical fallback root and sorted root-aware lifecycle tools", () => {
    const result = handleServerInfo({}, "C:\\projects\\rigor\\.");
    const body = status(result);

    expect(body).toMatchObject({
      server_name: RIGOR_SERVER_NAME,
      server_version: RIGOR_SERVER_VERSION,
      schema_version: RIGOR_SCHEMA_VERSION,
      fallback_root: "C:\\projects\\rigor",
      reconnect_required: false,
    });
    expect(body.root_aware_lifecycle_tools).toEqual([...ROOT_AWARE_LIFECYCLE_TOOLS].sort());
    expect(REGISTERED_TOOL_NAMES).toEqual([...REGISTERED_TOOL_NAMES].sort());
  });

  it("requires reconnect only for older client schemas", () => {
    const result = handleServerInfo({ client_schema_version: RIGOR_SCHEMA_VERSION - 1 }, process.cwd());

    expect(status(result).reconnect_required).toBe(true);
    expect(result.structuredContent?.guidance).toContain("Reconnect the MCP client to refresh its cached tool schema.");
  });
});
