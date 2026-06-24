/**
 * AGENT TOOLS (read-only, v1)
 * ---------------------------
 * Each tool exposes a capability to Claude with a JSON schema, and a `run`
 * function that executes against the normalized store and returns text + the
 * citations that back it. Adding a capability = add an AgentTool here. When
 * Gmail/Drive/Calendar adapters land, their tools slot in the same way (and
 * will use the requesting user's OAuth token from the TokenStore).
 *
 * v1 tools are read-only by design — no tool can mutate a source system.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Repository } from "../store/repository.js";
import type { AppUser } from "../identity/identity.js";
import type { CredentialService } from "../identity/credentials.js";
import type { Candidate, Stage } from "../types.js";
import { ACTIVE_STAGES } from "../types.js";
import { computePipelineMetrics, findStaleCandidates } from "../logic/metrics.js";
import { candidateCitation, candidateUrl, type Citation } from "./citations.js";

export interface ToolContext {
  repo: Repository;
  user: AppUser;
  credentials: CredentialService;
  /** Mutable: a tool sets `.provider` to make Slack offer a Connect button. */
  connectRequest: { provider?: string };
}

export interface ToolResult {
  text: string;
  citations: Citation[];
}

export interface AgentTool {
  def: Anthropic.Tool;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

function describe(c: Candidate): string {
  return [
    `name: ${c.name}`,
    `source: ${c.source}`,
    `role: ${c.role ?? "n/a"}`,
    `stage: ${c.stage}`,
    `owner: ${c.ownerEmail ?? "n/a"}`,
    `last_activity: ${c.lastActivityAt}`,
    `url: ${candidateUrl(c)}`,
  ].join(", ");
}

const searchCandidates: AgentTool = {
  def: {
    name: "search_candidates",
    description:
      "Search candidates and prospects across Ashby and Gem by name, role, stage, or owner. " +
      "Use this to find people before asking for detail. Returns matching records with their " +
      "current stage, owner, last activity, and a source link.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name or role keywords to match (optional)." },
        stage: {
          type: "string",
          description: "Filter to a pipeline stage.",
          enum: ["lead", "applied", "screen", "interview", "offer", "hired", "rejected", "archived"],
        },
        source: { type: "string", description: "Filter to a source.", enum: ["ashby", "gem"] },
        owner_email: { type: "string", description: "Filter to candidates owned by this email." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
    },
  },
  async run(input, ctx) {
    const all = await ctx.repo.allCandidates();
    const q = (input.query as string | undefined)?.toLowerCase().trim();
    const stage = input.stage as Stage | undefined;
    const source = input.source as string | undefined;
    const owner = (input.owner_email as string | undefined)?.toLowerCase();
    const limit = (input.limit as number | undefined) ?? 20;

    let matches = all;
    if (q) matches = matches.filter((c) => `${c.name} ${c.role ?? ""}`.toLowerCase().includes(q));
    if (stage) matches = matches.filter((c) => c.stage === stage);
    if (source) matches = matches.filter((c) => c.source === source);
    if (owner) matches = matches.filter((c) => c.ownerEmail?.toLowerCase() === owner);

    const top = matches.slice(0, limit);
    if (top.length === 0) return { text: "No matching candidates found.", citations: [] };
    return {
      text: `${matches.length} match(es)${matches.length > top.length ? ` (showing ${top.length})` : ""}:\n` +
        top.map(describe).join("\n"),
      citations: top.map(candidateCitation),
    };
  },
};

const getCandidate: AgentTool = {
  def: {
    name: "get_candidate",
    description:
      "Get full detail for one candidate by their id (e.g. 'ashby:123') or exact/near name. " +
      "Use after search_candidates to dig into a specific person.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Candidate id like 'ashby:123' (preferred)." },
        name: { type: "string", description: "Candidate name if id is unknown." },
      },
    },
  },
  async run(input, ctx) {
    const all = await ctx.repo.allCandidates();
    const id = input.id as string | undefined;
    const name = (input.name as string | undefined)?.toLowerCase();
    const found =
      (id && all.find((c) => c.id === id)) ||
      (name && all.find((c) => c.name.toLowerCase().includes(name)));
    if (!found) return { text: "No candidate matched that id or name.", citations: [] };
    const detail = {
      ...found,
      // raw holds the source's full record (timeline, stage history, etc.).
      raw: found.raw ?? "(no raw payload stored)",
    };
    return {
      text: `Candidate detail (JSON):\n${JSON.stringify(detail, null, 2)}`,
      citations: [candidateCitation(found)],
    };
  },
};

const pipelineMetrics: AgentTool = {
  def: {
    name: "pipeline_metrics",
    description:
      "Get counts of candidates by pipeline stage and the active total across Ashby and Gem. " +
      "Use for questions like 'how's the pipeline' or 'how many in interview'.",
    input_schema: { type: "object", properties: {} },
  },
  async run(_input, ctx) {
    const m = computePipelineMetrics(await ctx.repo.allCandidates());
    return { text: `Pipeline metrics (JSON):\n${JSON.stringify(m, null, 2)}`, citations: [] };
  },
};

const findStale: AgentTool = {
  def: {
    name: "find_stale_candidates",
    description:
      "List active-stage candidates with no activity for N+ days (default 7). Use for " +
      "'who is stuck', 'who needs follow up', 'what slipped'. Returns most-stale first.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Inactivity threshold in days (default 7)." },
        owner_email: { type: "string", description: "Limit to a specific owner." },
      },
    },
  },
  async run(input, ctx) {
    const days = (input.days as number | undefined) ?? 7;
    const owner = (input.owner_email as string | undefined)?.toLowerCase();
    let candidates = await ctx.repo.allCandidates();
    if (owner) candidates = candidates.filter((c) => c.ownerEmail?.toLowerCase() === owner);
    const stale = findStaleCandidates(candidates, days);
    if (stale.length === 0) {
      return { text: `No candidates inactive for ${days}+ days in stages: ${ACTIVE_STAGES.join(", ")}.`, citations: [] };
    }
    return {
      text:
        `${stale.length} stale (${days}+ days):\n` +
        stale.map((s) => `${describe(s.candidate)}, days_inactive: ${s.daysInactive}`).join("\n"),
      citations: stale.map((s) => candidateCitation(s.candidate)),
    };
  },
};

const getMyConnections: AgentTool = {
  def: {
    name: "get_my_connections",
    description:
      "List which integrations the current user has personally connected (their own API keys). " +
      "Call this when the user asks about a data source to check whether they've connected it yet.",
    input_schema: { type: "object", properties: {} },
  },
  async run(_input, ctx) {
    const conns = await ctx.credentials.list(ctx.user.slackUserId);
    if (conns.length === 0) return { text: "The user has not connected any integrations yet.", citations: [] };
    return {
      text: "Connected integrations:\n" + conns.map((c) => `- ${c.provider}${c.baseUrl ? ` (${c.baseUrl})` : ""}`).join("\n"),
      citations: [],
    };
  },
};

const connectIntegration: AgentTool = {
  def: {
    name: "connect_integration",
    description:
      "Start connecting an integration for the current user. Call this when the user wants data " +
      "from a source they haven't connected, or explicitly asks to connect one (e.g. 'I want my " +
      "Granola notes', 'connect Ashby'). This makes the app show a secure Connect button that opens " +
      "a form asking for their site/base URL and API key — do NOT ask the user to type their API key " +
      "in chat. Pass the provider name (e.g. 'granola', 'ashby', 'gem').",
    input_schema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Integration name, lowercase (e.g. 'granola')." },
      },
      required: ["provider"],
    },
  },
  async run(input, ctx) {
    const provider = String(input.provider ?? "").toLowerCase().trim();
    if (!provider) return { text: "No provider specified.", citations: [] };
    if (!ctx.credentials.enabled) {
      return { text: "Connections are not enabled (CREDENTIAL_ENC_KEY unset). Tell the user to contact an admin.", citations: [] };
    }
    ctx.connectRequest.provider = provider;
    return {
      text: `Connection flow for "${provider}" started. The app will show the user a Connect button to securely enter their site and API key. Tell them to click it.`,
      citations: [],
    };
  },
};

export type AuthStyle = "bearer" | "x-api-key" | "basic" | "query";

/**
 * Build the request URL, restricted to the credential's own host (prevents the
 * agent from sending a user's key to an arbitrary server). `path` may be a path
 * relative to the base URL or a full URL on the same host. HTTPS only.
 */
export function resolveApiUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const baseStr = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const url = /^https?:\/\//i.test(path) ? new URL(path) : new URL(path.replace(/^\//, ""), baseStr);
  if (url.protocol !== "https:") throw new Error("Only https requests are allowed.");
  if (url.host !== base.host) {
    throw new Error(`Refusing to send credentials to ${url.host}; this connection is for ${base.host}.`);
  }
  return url;
}

/** Inject the secret per the chosen auth style. Never logs the secret. */
export function applyAuth(
  headers: Record<string, string>,
  url: URL,
  secret: string,
  style: AuthStyle,
  param?: string
): void {
  switch (style) {
    case "x-api-key":
      headers[param || "x-api-key"] = secret;
      break;
    case "basic":
      headers["Authorization"] = `Basic ${Buffer.from(`${secret}:`).toString("base64")}`;
      break;
    case "query":
      url.searchParams.set(param || "api_key", secret);
      break;
    case "bearer":
    default:
      headers["Authorization"] = `Bearer ${secret}`;
  }
}

const MAX_BODY_CHARS = 6000;

const apiRequest: AgentTool = {
  def: {
    name: "api_request",
    description:
      "Make a READ-ONLY (GET) request to a connected integration's API using the current user's " +
      "stored key. Use this to read data from ANY integration the user has connected — including " +
      "ones without a specialized tool. Check get_my_connections first. You choose the path/query " +
      "based on your knowledge of that integration's REST API; the request goes to the integration's " +
      "stored base URL (same host only). Pick auth_style for the API: 'basic' for Ashby, 'x-api-key' " +
      "for Gem, 'bearer' for most token/OAuth APIs. If a call fails, read the error/status and retry " +
      "with a corrected path or auth_style. Returns HTTP status + response body (truncated).",
    input_schema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "A connected integration, e.g. 'ashby', 'gmail'." },
        path: {
          type: "string",
          description: "Path under the base URL (e.g. '/v1/messages?q=from:vinay') or full URL on the same host.",
        },
        auth_style: {
          type: "string",
          enum: ["bearer", "x-api-key", "basic", "query"],
          description: "How to send the key. Default 'bearer'.",
        },
        auth_param: { type: "string", description: "Header/query name for x-api-key or query styles." },
      },
      required: ["provider", "path"],
    },
  },
  async run(input, ctx) {
    const provider = String(input.provider ?? "").toLowerCase().trim();
    const cred = await ctx.credentials.get(ctx.user.slackUserId, provider);
    if (!cred) {
      return { text: `No connection found for "${provider}". Ask the user to connect it (/connect).`, citations: [] };
    }
    if (!cred.baseUrl) {
      return {
        text: `"${provider}" is connected but has no base URL. Ask the user to reconnect and include the Site/Base URL.`,
        citations: [],
      };
    }
    let url: URL;
    try {
      url = resolveApiUrl(cred.baseUrl, String(input.path ?? ""));
    } catch (err) {
      return { text: `Request blocked: ${err instanceof Error ? err.message : String(err)}`, citations: [] };
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    applyAuth(headers, url, cred.secret, (input.auth_style as AuthStyle) ?? "bearer", input.auth_param as string | undefined);

    try {
      const res = await fetch(url, { method: "GET", headers });
      const raw = await res.text();
      const body = raw.length > MAX_BODY_CHARS ? raw.slice(0, MAX_BODY_CHARS) + "\n…[truncated]" : raw;
      return {
        text: `HTTP ${res.status} ${res.statusText} from ${provider} (${url.pathname})\n${body}`,
        citations: [{ label: `${provider} API`, url: `${url.origin}${url.pathname}`, source: provider }],
      };
    } catch (err) {
      return { text: `Request to ${provider} failed: ${err instanceof Error ? err.message : String(err)}`, citations: [] };
    }
  },
};

export const tools: AgentTool[] = [
  searchCandidates,
  getCandidate,
  pipelineMetrics,
  findStale,
  getMyConnections,
  connectIntegration,
  apiRequest,
];

export const toolDefs: Anthropic.Tool[] = tools.map((t) => t.def);
export const toolByName: Map<string, AgentTool> = new Map(tools.map((t) => [t.def.name, t]));
