/**
 * GRANOLA MCP CLIENT
 * ------------------
 * Calls the Granola MCP server (https://mcp.granola.ai/mcp) via the MCP
 * Streamable HTTP transport. Each helper maps 1:1 to a Granola MCP tool.
 *
 * Auth: Granola uses a bearer token stored per-user in the CredentialService
 * under the key "granola". Users connect via /connect in Slack (same flow as
 * other integrations). The token is the user's Granola API key.
 *
 * Tools exposed:
 *   granolaListMeetings    — list meetings in a time range
 *   granolaGetMeetings     — get full details for specific meeting IDs
 *   granolaGetTranscript   — get verbatim transcript for a meeting
 *   granolaQuery           — natural-language search across all meeting notes
 */

const GRANOLA_MCP_URL = "https://mcp.granola.ai/mcp";

// ---------------------------------------------------------------------------
// JSON-RPC / MCP transport
// ---------------------------------------------------------------------------

interface McpRequest {
  jsonrpc: "2.0";
  id: number;
  method: "tools/call";
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface McpResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

let _rpcId = 1;

async function callMcpTool(
  apiKey: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError: boolean; status: number }> {
  const body: McpRequest = {
    jsonrpc: "2.0",
    id: _rpcId++,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  const res = await fetch(GRANOLA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return {
      text: `Granola MCP returned HTTP ${res.status}: ${await res.text()}`,
      isError: true,
      status: res.status,
    };
  }

  // The MCP server may respond as plain JSON or as SSE (text/event-stream).
  const contentType = res.headers.get("content-type") ?? "";
  let rpc: McpResponse;

  if (contentType.includes("text/event-stream")) {
    // SSE: read the stream and find the first `data:` line containing our JSON.
    const raw = await res.text();
    const dataLine = raw
      .split("\n")
      .find((l) => l.startsWith("data:") && l.includes('"jsonrpc"'));
    if (!dataLine) {
      return { text: "Granola MCP: no data in SSE stream.", isError: true, status: res.status };
    }
    rpc = JSON.parse(dataLine.slice("data:".length).trim()) as McpResponse;
  } else {
    rpc = (await res.json()) as McpResponse;
  }

  if (rpc.error) {
    return {
      text: `Granola MCP error ${rpc.error.code}: ${rpc.error.message}`,
      isError: true,
      status: res.status,
    };
  }

  const textContent = (rpc.result?.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");

  return {
    text: textContent || "(empty response from Granola)",
    isError: rpc.result?.isError === true,
    status: res.status,
  };
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export type GranolaTimeRange = "this_week" | "last_week" | "last_30_days" | "custom";

export interface GranolaListMeetingsOpts {
  time_range?: GranolaTimeRange;
  folder_id?: string;
  custom_start?: string; // ISO date, required when time_range = "custom"
  custom_end?: string;
}

export async function granolaListMeetings(
  apiKey: string,
  opts: GranolaListMeetingsOpts = {}
): Promise<{ text: string; isError: boolean; status: number }> {
  const args: Record<string, unknown> = {
    time_range: opts.time_range ?? "last_30_days",
  };
  if (opts.folder_id) args["folder_id"] = opts.folder_id;
  if (opts.custom_start) args["custom_start"] = opts.custom_start;
  if (opts.custom_end) args["custom_end"] = opts.custom_end;
  return callMcpTool(apiKey, "list_meetings", args);
}

export async function granolaGetMeetings(
  apiKey: string,
  meetingIds: string[]
): Promise<{ text: string; isError: boolean; status: number }> {
  return callMcpTool(apiKey, "get_meetings", { meeting_ids: meetingIds });
}

export async function granolaGetTranscript(
  apiKey: string,
  meetingId: string
): Promise<{ text: string; isError: boolean; status: number }> {
  return callMcpTool(apiKey, "get_meeting_transcript", { meeting_id: meetingId });
}

export async function granolaQuery(
  apiKey: string,
  query: string,
  documentIds?: string[]
): Promise<{ text: string; isError: boolean; status: number }> {
  const args: Record<string, unknown> = { query };
  if (documentIds?.length) args["document_ids"] = documentIds;
  return callMcpTool(apiKey, "query_granola_meetings", args);
}
