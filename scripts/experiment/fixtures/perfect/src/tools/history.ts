// Fixture: scorecard validation
import { CallToolResult } from "@modelcontextprotocol/sdk";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function handleCycleHistory(): CallToolResult {
  const historyDir = ".rigor/history";
  if (!existsSync(historyDir)) {
    return textResult("[]");
  }
  return textResult("cycle_history result");
}
