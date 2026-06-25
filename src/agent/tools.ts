/**
 * AGENT TOOLS (read-only, v1)
 * ---------------------------
 * Each tool exposes a capability to Claude with a JSON schema, and a `run`
 * function that executes against the normalized store and returns text + the
 * citations that back it. Adding a capability = add an AgentTool here.
 *
 * v1 tools are read-only by design — except gmail_send (staged, user-confirmed)
 * and slack_send_dm (sends on behalf of the bot to another user).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { WebClient } from "@slack/web-api";
import type { Repository } from "../store/repository.js";
import type { AppUser } from "../identity/identity.js";
import type { CredentialService } from "../identity/credentials.js";
import type { Candidate, Stage } from "../types.js";
import { ACTIVE_STAGES } from "../types.js";
import { computePipelineMetrics, findStaleCandidates } from "../logic/metrics.js";
import { candidateCitation, candidateUrl, type Citation } from "./citations.js";
import type { GoogleAuth } from "../google/oauth.js";
import type { GranolaAuth } from "../granola/oauth.js";
import {
  googleApiGet,
  gcalListEvents,
  gcalFindSlots,
  driveSearch,
  driveReadFile,
  type GmailDraft,
} from "../google/gmail.js";
import {
  granolaListMeetings,
  granolaGetMeetings,
  granolaGetTranscript,
  granolaQuery,
  type GranolaTimeRange,
} from "../granola/client.js";

export interface ToolContext {
  repo: Repository;
  user: AppUser;
  credentials: CredentialService;
  /** Google token provider; null when Google OAuth isn't configured. */
  google: GoogleAuth | null;
  /** Granola token provider; null when Granola OAuth isn't configured. */
  granolaAuth: GranolaAuth | null;
  /** Slack WebClient for DM tools; null when Slack isn't configured. */
  slackClient: WebClient | null;
  /** Mutable: tools add provider names here to make Slack offer Connect buttons.
   *  Supports multiple (e.g. a client switch reconnects ashby + google at once). */
  connectRequest: { providers: string[] };
  /** Mutable: a write tool stages a draft here for Slack to confirm. */
  pendingSend: { draft?: GmailDraft };
}

export interface ToolResult {
  text: string;
  citations: Citation[];
}

export interface AgentTool {
  def: Anthropic.Tool;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Queue a provider for a Slack Connect button (deduped). */
function requestConnect(ctx: ToolContext, provider: string): void {
  if (!ctx.connectRequest.providers.includes(provider)) ctx.connectRequest.providers.push(provider);
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
    const safe = { ...found };
    delete safe.raw;
    return {
      text: `Candidate detail (JSON):\n${JSON.stringify(safe, null, 2)}`,
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
    let provider = String(input.provider ?? "").toLowerCase().trim();
    if (!provider) return { text: "No provider specified.", citations: [] };
    if (!ctx.credentials.enabled) {
      return { text: "Connections are not enabled (CREDENTIAL_ENC_KEY unset). Tell the user to contact an admin.", citations: [] };
    }
    if (GOOGLE_ALIASES.has(provider)) provider = "google";
    requestConnect(ctx, provider);
    return {
      text: `Connection flow for "${provider}" started. The app will show the user a Connect button to securely enter their site and API key. Tell them to click it.`,
      citations: [],
    };
  },
};

/** Provider names that mean "Google" — these go through OAuth, never a key. */
export const GOOGLE_ALIASES = new Set([
  "google",
  "gmail",
  "gcal",
  "googlecalendar",
  "calendar",
  "gdrive",
  "drive",
  "googledrive",
]);

export type AuthStyle = "bearer" | "x-api-key" | "basic" | "query";

/** Block requests to loopback / private / cloud-metadata addresses (SSRF guard). */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").split(":")[0];
  if (h === "localhost" || h === "metadata.google.internal" || h === "::1") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

export function resolveApiUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const baseStr = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const url = /^https?:\/\//i.test(path) ? new URL(path) : new URL(path.replace(/^\//, ""), baseStr);
  if (url.protocol !== "https:") throw new Error("Only https requests are allowed.");
  if (url.host !== base.host) {
    throw new Error(`Refusing to send credentials to ${url.host}; this connection is for ${base.host}.`);
  }
  if (isBlockedHost(url.host)) throw new Error("Refusing to call a private/internal address.");
  return url;
}

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
    if (GOOGLE_ALIASES.has(provider)) {
      return {
        text: "For Gmail, Calendar, or Drive, use the google_read tool (it uses the user's Google sign-in), not api_request.",
        citations: [],
      };
    }
    if (provider === "granola") {
      return {
        text: "For Granola, use the dedicated granola_* tools — do not use api_request.",
        citations: [],
      };
    }
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

const googleRead: AgentTool = {
  def: {
    name: "google_read",
    description:
      "READ from the current user's connected Google account (Gmail, Calendar, Drive) with a GET to " +
      "the Google REST API. Use for 'find an email from X', 'what's on my calendar', 'find a doc'. " +
      "Examples: Gmail search → '/gmail/v1/users/me/messages?q=from:vinay'; a message → " +
      "'/gmail/v1/users/me/messages/{id}'; Calendar → " +
      "'/calendar/v3/calendars/primary/events?timeMin=...'; Drive → '/drive/v3/files?q=...'. " +
      "Host must be *.googleapis.com. Requires the user to have connected Google.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Google API path or full https://*.googleapis.com URL." },
      },
      required: ["path"],
    },
  },
  async run(input, ctx) {
    if (!ctx.google) return { text: "Google isn't configured on this server.", citations: [] };
    const token = await ctx.google.getAccessToken(ctx.user.slackUserId);
    if (!token) {
      requestConnect(ctx, "google");
      return { text: "The user hasn't connected Google yet. Offer them the Connect Google button.", citations: [] };
    }
    try {
      const r = await googleApiGet(token, String(input.path ?? ""));
      return {
        text: `HTTP ${r.status} from Google (${new URL(r.url).pathname})\n${r.body}`,
        citations: [{ label: "Google", url: r.url, source: "google" }],
      };
    } catch (err) {
      return { text: `Google read failed: ${err instanceof Error ? err.message : String(err)}`, citations: [] };
    }
  },
};

const gmailSend: AgentTool = {
  def: {
    name: "gmail_send",
    description:
      "Prepare an email to send from the user's Gmail. This does NOT send immediately — it stages a " +
      "draft and the user must confirm with a Send button in Slack. Use after drafting an email the " +
      "user asked for. Always show the user the draft in your reply too.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text email body." },
        cc: { type: "string", description: "Optional CC address(es)." },
      },
      required: ["to", "subject", "body"],
    },
  },
  async run(input, ctx) {
    if (!ctx.google) return { text: "Google isn't configured on this server.", citations: [] };
    const token = await ctx.google.getAccessToken(ctx.user.slackUserId);
    if (!token) {
      requestConnect(ctx, "google");
      return { text: "The user hasn't connected Google yet. Offer the Connect Google button.", citations: [] };
    }
    const draft: GmailDraft = {
      to: String(input.to ?? ""),
      subject: String(input.subject ?? ""),
      body: String(input.body ?? ""),
      cc: input.cc ? String(input.cc) : undefined,
    };
    if (!draft.to || !draft.body) return { text: "Need at least a recipient and a body.", citations: [] };
    ctx.pendingSend.draft = draft;
    return {
      text: `Draft staged for ${draft.to} (subject: "${draft.subject}"). Tell the user to review it and press Send to confirm — it has NOT been sent yet.`,
      citations: [],
    };
  },
};

// ---------------------------------------------------------------------------
// Slack DM tool
// ---------------------------------------------------------------------------

const slackSendDm: AgentTool = {
  def: {
    name: "slack_send_dm",
    description:
      "Send a direct message to any Slack user by their email address or Slack display name. " +
      "Use this to notify a recruiter, alert a hiring manager, or relay information to a teammate. " +
      "Examples: 'tell Sarah the candidate moved to offer', 'DM john@co.com that the interview is confirmed'. " +
      "The message is sent immediately from the Robotman bot. Always confirm with the requesting user " +
      "what you are about to send before calling this tool, unless they explicitly ask you to just send it.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient's email address (preferred) or Slack display name.",
        },
        message: {
          type: "string",
          description: "The message text to send. Supports Slack mrkdwn formatting.",
        },
      },
      required: ["to", "message"],
    },
  },
  async run(input, ctx) {
    if (!ctx.slackClient) {
      return { text: "Slack client isn't available — cannot send DMs.", citations: [] };
    }
    const to = String(input.to ?? "").trim();
    const message = String(input.message ?? "").trim();
    if (!to || !message) return { text: "Need both a recipient and a message.", citations: [] };

    let channelId: string | null = null;

    // Try to resolve by email first.
    if (to.includes("@")) {
      try {
        const res = await ctx.slackClient.users.lookupByEmail({ email: to });
        channelId = res.user?.id ?? null;
      } catch {
        // fall through to name lookup
      }
    }

    // Fall back: search by display name.
    if (!channelId) {
      try {
        const list = await ctx.slackClient.users.list({});
        const members = list.members ?? [];
        const match = members.find(
          (u) =>
            u.name?.toLowerCase() === to.toLowerCase() ||
            u.real_name?.toLowerCase() === to.toLowerCase() ||
            u.profile?.display_name?.toLowerCase() === to.toLowerCase()
        );
        channelId = match?.id ?? null;
      } catch {
        // ignore
      }
    }

    if (!channelId) {
      return {
        text: `Could not find a Slack user matching "${to}". Try using their exact email address.`,
        citations: [],
      };
    }

    try {
      await ctx.slackClient.chat.postMessage({
        channel: channelId,
        text: message,
        unfurl_links: false,
      });
      return {
        text: `✅ DM sent to ${to}: "${message.slice(0, 100)}${message.length > 100 ? "…" : ""}"`,
        citations: [],
      };
    } catch (err) {
      return {
        text: `Failed to send DM: ${err instanceof Error ? err.message : String(err)}`,
        citations: [],
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Google Calendar tools
// ---------------------------------------------------------------------------

async function getGoogleToken(ctx: ToolContext): Promise<string | null> {
  if (!ctx.google) return null;
  const token = await ctx.google.getAccessToken(ctx.user.slackUserId);
  if (!token) requestConnect(ctx, "google");
  return token;
}

const gcalListEventsTool: AgentTool = {
  def: {
    name: "gcal_list_events",
    description:
      "List Google Calendar events in a time window. Use for 'what's on my calendar', " +
      "'when is the interview for X', 'show me this week's interviews', or any question " +
      "about scheduled meetings or events. Supports an optional keyword search (q) that " +
      "matches against event title, description, location, and attendees — great for " +
      "finding all events related to a specific candidate by name.",
    input_schema: {
      type: "object",
      properties: {
        time_min: { type: "string", description: "Start of window, ISO 8601 (e.g. '2025-06-01T00:00:00Z'). Default: now." },
        time_max: { type: "string", description: "End of window, ISO 8601. Default: 7 days from now." },
        q: { type: "string", description: "Free-text search — candidate name, event title keyword, etc." },
        calendar_id: { type: "string", description: "Calendar to query. Default: 'primary'." },
        max_results: { type: "number", description: "Max events to return (default 25, max 50)." },
      },
    },
  },
  async run(input, ctx) {
    const token = await getGoogleToken(ctx);
    if (!token) return { text: "The user hasn't connected Google yet. Offer the Connect Google button.", citations: [] };

    const now = new Date();
    const timeMin = String(input.time_min ?? now.toISOString());
    const timeMax = String(input.time_max ?? new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString());

    try {
      const { events, status } = await gcalListEvents(token, {
        calendarId: input.calendar_id ? String(input.calendar_id) : undefined,
        timeMin,
        timeMax,
        q: input.q ? String(input.q) : undefined,
        maxResults: input.max_results ? Math.min(Number(input.max_results), 50) : 25,
      });

      if (status === 401 || status === 403) {
        requestConnect(ctx, "google");
        return { text: "Google Calendar access was denied — the user may need to reconnect Google.", citations: [] };
      }
      if (events.length === 0) {
        return { text: `No calendar events found between ${timeMin} and ${timeMax}${input.q ? ` matching "${input.q}"` : ""}.`, citations: [] };
      }

      const lines = events.map((e) => {
        const attendeeStr = e.attendees.length ? ` | attendees: ${e.attendees.join(", ")}` : "";
        const loc = e.location ? ` | location: ${e.location}` : "";
        return `• ${e.summary} | start: ${e.start} | end: ${e.end}${loc}${attendeeStr} | link: ${e.htmlLink}`;
      });

      return {
        text: `${events.length} event(s) found:\n${lines.join("\n")}`,
        citations: events.map((e) => ({ label: e.summary, url: e.htmlLink, source: "gcal" })),
      };
    } catch (err) {
      return { text: `Calendar error: ${err instanceof Error ? err.message : String(err)}`, citations: [] };
    }
  },
};

const gcalFindAvailabilityTool: AgentTool = {
  def: {
    name: "gcal_find_availability",
    description:
      "Find free time slots in the user's primary Google Calendar — use when scheduling " +
      "an interview or checking availability. Returns gaps of at least `min_minutes` " +
      "that fall within the requested window.",
    input_schema: {
      type: "object",
      properties: {
        time_min: { type: "string", description: "Start of the window to search, ISO 8601. Default: now." },
        time_max: { type: "string", description: "End of the window, ISO 8601. Default: 5 business days from now." },
        min_minutes: { type: "number", description: "Minimum slot length in minutes (default 30)." },
      },
    },
  },
  async run(input, ctx) {
    const token = await getGoogleToken(ctx);
    if (!token) return { text: "The user hasn't connected Google yet. Offer the Connect Google button.", citations: [] };

    const now = new Date();
    const timeMin = String(input.time_min ?? now.toISOString());
    const timeMax = String(input.time_max ?? new Date(now.getTime() + 5 * 24 * 60 * 60_000).toISOString());
    const minMinutes = input.min_minutes ? Number(input.min_minutes) : 30;

    try {
      const { slots, status } = await gcalFindSlots(token, { timeMin, timeMax, minMinutes });

      if (status === 401 || status === 403) {
        requestConnect(ctx, "google");
        return { text: "Google Calendar access denied — the user may need to reconnect Google.", citations: [] };
      }
      if (slots.length === 0) {
        return { text: `No free slots of ${minMinutes}+ minutes found between ${timeMin} and ${timeMax}.`, citations: [] };
      }

      const lines = slots.map((s) => `• ${s.start} → ${s.end} (${s.durationMinutes} min free)`);
      return { text: `${slots.length} free slot(s) of ${minMinutes}+ min:\n${lines.join("\n")}`, citations: [] };
    } catch (err) {
      return { text: `Availability check error: ${err instanceof Error ? err.message : String(err)}`, citations: [] };
    }
  },
};

// ---------------------------------------------------------------------------
// Google Drive tools
// ---------------------------------------------------------------------------

const driveSearchTool: AgentTool = {
  def: {
    name: "drive_search",
    description:
      "Search Google Drive for files by name or content. Use for 'find the JD for X role', " +
      "'look up the scorecard template', 'find a doc about candidate Y'. " +
      "Returns file names, types, last-modified dates, and view links. " +
      "Follow up with drive_read_file to read the contents.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for in file names and content." },
        max_results: { type: "number", description: "Max files to return (default 10)." },
      },
      required: ["query"],
    },
  },
  async run(input, ctx) {
    const token = await getGoogleToken(ctx);
    if (!token) return { text: "The user hasn't connected Google yet. Offer the Connect Google button.", citations: [] };

    const q = String(input.query ?? "").trim();
    if (!q) return { text: "No search query provided.", citations: [] };

    try {
      const { files, status } = await driveSearch(token, { q, maxResults: input.max_results ? Number(input.max_results) : 10 });

      if (status === 401 || status === 403) {
        requestConnect(ctx, "google");
        return { text: "Google Drive access denied — the user may need to reconnect Google.", citations: [] };
      }
      if (files.length === 0) return { text: `No Drive files found matching "${q}".`, citations: [] };

      const lines = files.map((f) => {
        const modified = f.modifiedTime ? ` | modified: ${f.modifiedTime.slice(0, 10)}` : "";
        const link = f.webViewLink ? ` | link: ${f.webViewLink}` : "";
        return `• [${f.id}] ${f.name} (${f.mimeType})${modified}${link}`;
      });

      return {
        text: `${files.length} file(s) found for "${q}":\n${lines.join("\n")}\n\nUse drive_read_file with the [id] to read a file's contents.`,
        citations: files.filter((f) => f.webViewLink).map((f) => ({ label: f.name, url: f.webViewLink!, source: "drive" })),
      };
    } catch (err) {
      return { text: `Drive search error: ${err instanceof Error ? err.message : String(err)}`, citations: [] };
    }
  },
};

const driveReadFileTool: AgentTool = {
  def: {
    name: "drive_read_file",
    description:
      "Read the contents of a Google Drive file by its ID (get the ID from drive_search). " +
      "Google Docs are returned as plain text, Google Sheets as CSV, PDFs as base64.",
    input_schema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The Drive file ID (from drive_search results)." },
      },
      required: ["file_id"],
    },
  },
  async run(input, ctx) {
    const token = await getGoogleToken(ctx);
    if (!token) return { text: "The user hasn't connected Google yet. Offer the Connect Google button.", citations: [] };

    const fileId = String(input.file_id ?? "").trim();
    if (!fileId) return { text: "No file_id provided.", citations: [] };

    try {
      const { file, status, error } = await driveReadFile(token, fileId);

      if (status === 401 || status === 403) {
        requestConnect(ctx, "google");
        return { text: "Google Drive access denied — the user may need to reconnect.", citations: [] };
      }
      if (!file) return { text: `Could not read file (HTTP ${status}): ${error ?? "unknown error"}`, citations: [] };

      const truncNote = file.truncated ? "\n…[content truncated]" : "";
      const encodingNote = file.encoding === "base64" ? `\n(PDF/binary — base64 encoded, ${file.content.length} chars)` : "";
      const citation = file.webViewLink ? [{ label: file.name, url: file.webViewLink, source: "drive" }] : [];

      return {
        text: `File: ${file.name} (${file.mimeType})\n\n${file.content}${encodingNote}${truncNote}`,
        citations: citation,
      };
    } catch (err) {
      return { text: `Drive read error: ${err instanceof Error ? err.message : String(err)}`, citations: [] };
    }
  },
};

// ---------------------------------------------------------------------------
// Granola meeting-notes tools
// ---------------------------------------------------------------------------

/**
 * Resolve a valid Granola access token for this user. Priority:
 *   1. OAuth token via GranolaAuth (SSO flow — preferred)
 *   2. Raw API key stored in CredentialService under "granola" (legacy key-based)
 *   3. Org-wide env var GRANOLA_API_KEY
 * Queues a connect request and returns null when nothing is available.
 */
async function getGranolaToken(ctx: ToolContext): Promise<string | null> {
  // 1. OAuth SSO token (preferred)
  if (ctx.granolaAuth) {
    const token = await ctx.granolaAuth.getAccessToken(ctx.user.slackUserId);
    if (token) return token;
  }
  // 2. Legacy per-user API key
  try {
    const cred = await ctx.credentials.get(ctx.user.slackUserId, "granola");
    if (cred?.secret) return cred.secret;
  } catch {
    // not found
  }
  // 3. Org-wide env key
  const { config } = await import("../config.js");
  if (config.granola.apiKey) return config.granola.apiKey;

  requestConnect(ctx, "granola");
  return null;
}

const granolaListMeetingsTool: AgentTool = {
  def: {
    name: "granola_list_meetings",
    description:
      "List recent Granola meeting notes with titles, dates, and IDs. Use as a starting " +
      "point to browse what meetings exist before diving into details. Supports time ranges " +
      "(this_week, last_week, last_30_days, custom). For answering questions ABOUT meeting " +
      "content, prefer granola_query instead.",
    input_schema: {
      type: "object",
      properties: {
        time_range: {
          type: "string",
          enum: ["this_week", "last_week", "last_30_days", "custom"],
          description: "Time window to list meetings from. Default: last_30_days.",
        },
        custom_start: { type: "string", description: "ISO date (YYYY-MM-DD). Required when time_range is 'custom'." },
        custom_end: { type: "string", description: "ISO date (YYYY-MM-DD). Required when time_range is 'custom'." },
        folder_id: { type: "string", description: "Optional — filter to a specific Granola folder." },
      },
    },
  },
  async run(input, ctx) {
    const key = await getGranolaToken(ctx);
    if (!key) return { text: "Granola isn't connected. Offer the Connect Granola button.", citations: [] };

    const result = await granolaListMeetings(key, {
      time_range: (input.time_range as GranolaTimeRange) ?? "last_30_days",
      folder_id: input.folder_id ? String(input.folder_id) : undefined,
      custom_start: input.custom_start ? String(input.custom_start) : undefined,
      custom_end: input.custom_end ? String(input.custom_end) : undefined,
    });

    if (result.status === 401 || result.status === 403) {
      requestConnect(ctx, "granola");
      return { text: "Granola access denied — the user may need to reconnect Granola.", citations: [] };
    }
    return { text: result.text, citations: [] };
  },
};

const granolaGetMeetingTool: AgentTool = {
  def: {
    name: "granola_get_meeting",
    description:
      "Get full details for one or more Granola meetings by ID — includes AI summary, " +
      "private notes, and attendees. Use after granola_list_meetings to drill into a " +
      "specific meeting. Pass up to 10 IDs at once.",
    input_schema: {
      type: "object",
      properties: {
        meeting_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of Granola meeting UUIDs (from granola_list_meetings).",
        },
      },
      required: ["meeting_ids"],
    },
  },
  async run(input, ctx) {
    const key = await getGranolaToken(ctx);
    if (!key) return { text: "Granola isn't connected. Offer the Connect Granola button.", citations: [] };

    const ids = (input.meeting_ids as string[]) ?? [];
    if (!ids.length) return { text: "No meeting IDs provided.", citations: [] };

    const result = await granolaGetMeetings(key, ids.slice(0, 10));

    if (result.status === 401 || result.status === 403) {
      requestConnect(ctx, "granola");
      return { text: "Granola access denied — the user may need to reconnect Granola.", citations: [] };
    }
    return { text: result.text, citations: [] };
  },
};

const granolaGetTranscriptTool: AgentTool = {
  def: {
    name: "granola_get_transcript",
    description:
      "Get the verbatim transcript for a single Granola meeting by ID. Use when the user " +
      "needs exact quotes or wants to know precisely what was said — not just summaries. " +
      "For summarized content or action items, use granola_query instead.",
    input_schema: {
      type: "object",
      properties: {
        meeting_id: { type: "string", description: "The Granola meeting UUID." },
      },
      required: ["meeting_id"],
    },
  },
  async run(input, ctx) {
    const key = await getGranolaToken(ctx);
    if (!key) return { text: "Granola isn't connected. Offer the Connect Granola button.", citations: [] };

    const meetingId = String(input.meeting_id ?? "").trim();
    if (!meetingId) return { text: "No meeting_id provided.", citations: [] };

    const result = await granolaGetTranscript(key, meetingId);

    if (result.status === 401 || result.status === 403) {
      requestConnect(ctx, "granola");
      return { text: "Granola access denied — the user may need to reconnect Granola.", citations: [] };
    }
    return { text: result.text, citations: [] };
  },
};

const granolaQueryTool: AgentTool = {
  def: {
    name: "granola_query",
    description:
      "Search and answer questions across all Granola meeting notes using natural language. " +
      "This is the PREFERRED Granola tool for most questions — use it for: 'what did we " +
      "discuss about candidate X', 'what were the action items from my last debrief', " +
      "'what did the team say about the Staff Backend role', 'summarize recent interview " +
      "feedback'. Optionally scope to specific meeting IDs.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language question about your meeting notes." },
        meeting_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional — limit search to specific meeting UUIDs.",
        },
      },
      required: ["query"],
    },
  },
  async run(input, ctx) {
    const key = await getGranolaToken(ctx);
    if (!key) return { text: "Granola isn't connected. Offer the Connect Granola button.", citations: [] };

    const query = String(input.query ?? "").trim();
    if (!query) return { text: "No query provided.", citations: [] };

    const ids = input.meeting_ids ? (input.meeting_ids as string[]) : undefined;
    const result = await granolaQuery(key, query, ids);

    if (result.status === 401 || result.status === 403) {
      requestConnect(ctx, "granola");
      return { text: "Granola access denied — the user may need to reconnect Granola.", citations: [] };
    }
    return { text: result.text, citations: [] };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const tools: AgentTool[] = [
  searchCandidates,
  getCandidate,
  pipelineMetrics,
  findStale,
  getMyConnections,
  connectIntegration,
  apiRequest,
  googleRead,
  gmailSend,
  slackSendDm,
  gcalListEventsTool,
  gcalFindAvailabilityTool,
  driveSearchTool,
  driveReadFileTool,
  granolaListMeetingsTool,
  granolaGetMeetingTool,
  granolaGetTranscriptTool,
  granolaQueryTool,
];

export const toolDefs: Anthropic.Tool[] = tools.map((t) => t.def);
export const toolByName: Map<string, AgentTool> = new Map(tools.map((t) => [t.def.name, t]));
