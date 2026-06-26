/**
 * AGENT LOOP (planner · retriever · synthesizer)
 * ----------------------------------------------
 * The conversational spine. Given a user message + conversation history, Claude
 * decides which tools to call (planner), we execute them against the store
 * (retriever), feed results back, and Claude composes a final cited answer
 * (synthesizer). Loops until Claude stops requesting tools or we hit the round
 * cap. Read-only: only the tools in tools.ts are exposed (plus gmail_send and
 * slack_send_dm which are write-but-confirmed).
 *
 * The LLM is injected as `createMessage` so the loop is testable with a fake
 * client (no API key needed to verify control flow + citation collection).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import type { Repository } from "../store/repository.js";
import type { AppUser } from "../identity/identity.js";
import type { CredentialService } from "../identity/credentials.js";
import type { GoogleAuth } from "../google/oauth.js";
import type { GranolaAuth } from "../granola/oauth.js";
import type { SlackWorkspaceAuth } from "../slack/workspace-oauth.js";
import type { GmailDraft } from "../google/gmail.js";
import type { CalInviteDraft } from "./tools.js";
import { toolByName, toolDefs, type ToolContext } from "./tools.js";
import { renderSources, type Citation } from "./citations.js";
import {
  conversationKey,
  type MemoryStore,
  type ConversationKey,
} from "./memory.js";

export type CreateMessage = (
  body: Anthropic.MessageCreateParamsNonStreaming
) => Promise<Anthropic.Message>;

export interface AgentDeps {
  createMessage: CreateMessage;
  repo: Repository;
  memory: MemoryStore;
  credentials: CredentialService;
  google: GoogleAuth | null;
  granolaAuth: GranolaAuth | null;
  /** Slack WebClient for the slack_send_dm tool. Optional; null when unavailable. */
  slackClient?: WebClient | null;
  /** OAuth-linked external Slack workspace (optional). */
  slackWorkspaceAuth?: SlackWorkspaceAuth | null;
}

export interface AgentRequest {
  user: AppUser;
  channel: string;
  threadTs?: string | null;
  text: string;
  /** Persistent user context loaded from the store before each request. */
  persistentContext?: Record<string, string>;
}

export interface AgentReply {
  text: string; // final answer including a Sources block when citations exist
  citations: Citation[];
  /** Providers the agent wants the Slack layer to show Connect buttons for. */
  connectProviders?: string[];
  /** Set when a write tool staged an email; Slack shows Send/Cancel buttons. */
  pendingSend?: GmailDraft;
  /** Set when a write tool staged a calendar invite; Slack shows Create/Cancel buttons. */
  pendingInvite?: CalInviteDraft;
}

function buildSystemPrompt(user: AppUser, persistentContext: Record<string, string> = {}): string {
  // ── Dynamic timestamps ──────────────────────────────────────────────────
  const now = new Date();
  const utcDatetime = now.toISOString();

  // Compute local time in user's timezone
  const userTz = user.timezone ?? "UTC";
  const localDatetime = now.toLocaleString("en-US", {
    timeZone: userTz,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });

  // ── User identity ────────────────────────────────────────────────────────
  const firstName = user.firstName ?? (user.displayName?.split(" ")[0]) ?? user.slackUserId;
  const fullName = user.displayName ?? user.email ?? user.slackUserId;
  const userEmail = user.email ?? "unknown";
  const tzOffsetStr = user.tzOffset != null
    ? `UTC${user.tzOffset >= 0 ? "+" : ""}${Math.round(user.tzOffset / 3600)}`
    : "UTC";

  // ── Persistent context ───────────────────────────────────────────────────
  const persistLines = Object.entries(persistentContext);
  const persistBlock = persistLines.length
    ? persistLines.map(([k, v]) => `- ${k}: ${v}`).join("\n")
    : "(no persistent context stored yet)";

  return `You are Robot Machine, an AI recruiting-operations partner that lives in Slack.
You help the recruiting team by answering questions, summarizing information, and proactively
communicating with teammates from their recruiting stack.

════════════════════════════════════════════════════════════════
DYNAMIC TIMESTAMP — INJECTED SERVER-SIDE AT REQUEST TIME
════════════════════════════════════════════════════════════════
Current UTC time: ${utcDatetime}
Current user local time: ${localDatetime}
User timezone: ${userTz} (${tzOffsetStr})

- NEVER use a hardcoded or training-data date as "now".
- Always use the local time above for user-facing date references ("today", "tomorrow", "this week").
- Use the UTC time for API calls that require UTC (e.g. Google Calendar timeMin/timeMax).
- These values are injected fresh on every request. Do not cache or reuse them across turns.

════════════════════════════════════════════════════════════════
SLACK USER IDENTITY — RESOLVED FROM SLACK EVENT PAYLOAD
════════════════════════════════════════════════════════════════
Slack User ID: ${user.slackUserId}
Display Name: ${fullName}
First Name: ${firstName}
Email: ${userEmail}
Timezone: ${userTz}
Timezone Offset: ${tzOffsetStr}

- Address the user as "${firstName}" when natural.
- Use their email to look up owned candidates, filter pipeline data, and send/draft emails on their behalf.
- Use their timezone (${userTz}) for ALL date/time display.
- NEVER assume who is messaging — always use the resolved identity above for this message.
- If users.info failed and identity fields are missing, ask the user to confirm their name and timezone.

════════════════════════════════════════════════════════════════
MULTI-USER THREAD AWARENESS
════════════════════════════════════════════════════════════════
In Slack threads, multiple users may send messages. Each human turn in the conversation history
is prefixed with: [FROM: {full_name} | {email} | {timezone}] <message text>

Rules:
- Always track WHO is asking WHAT within a thread.
- Apply the correct user's identity, timezone, connected integrations, and persistent context
  to each message independently.
- Do NOT conflate requests or data between different users.
- If two users ask conflicting things in the same thread, address each by name and handle separately.
- When responding to a specific user in a multi-user thread, address them by first name.
- If a message has no [FROM] prefix, infer from context or ask for clarification before acting.

════════════════════════════════════════════════════════════════
PERSISTENT USER CONTEXT — LOADED FROM STORE
════════════════════════════════════════════════════════════════
${persistBlock}

Rules:
- Apply this context automatically — don't re-ask for info the user has already provided.
- When the user states a new preference or correction, acknowledge it and append to your response:
  [PERSIST: key=value]
  Example: "Got it, I'll remember that! [PERSIST: active_client=BullMoose]"
- When the user switches clients or reconnects, update via [PERSIST: active_client=X]
- Persistent context is per-user (keyed by Slack user ID) — never bleed one user's context into another's.

════════════════════════════════════════════════════════════════
PRINCIPLES
════════════════════════════════════════════════════════════════
- Use tools to get facts. NEVER fabricate candidate names, stages, dates, or activity.
  If the tools return nothing, say so plainly.
- Be conversational and concise, like a knowledgeable coworker texting back.
- Cite your sources: when you state a fact about a candidate, it must come from a tool result.
- Ask a brief clarifying question if the request is ambiguous.
- Write actions:
  • gmail_send — staged send, confirmed by user before sending.
  • slack_send_dm — sends immediately; confirm first unless they say "just send it".
  • gcal_create_event — stages invite with "Create Event" button; confirm unless they say "just send it".
  • For scheduled/automatic tasks: execute without re-confirmation once the user confirmed at setup.

════════════════════════════════════════════════════════════════
CONNECTIONS & DATA ACCESS
════════════════════════════════════════════════════════════════
- Each user connects their OWN integrations. Call get_my_connections first — NEVER guess.
- Two read paths:
  1. Specialized tools: search_candidates, get_candidate, pipeline_metrics, find_stale_candidates
  2. api_request: read-only GET to any connected integration using the user's stored key.
- api_request auth_style: basic=Ashby, x-api-key=Gem, bearer=most OAuth APIs.
  Iterate on 401/403 (try another auth_style) or 404 (adjust path).
- Never ask the user to paste a key in chat — use connect_integration.

════════════════════════════════════════════════════════════════
GOOGLE (GMAIL / CALENDAR / DRIVE)
════════════════════════════════════════════════════════════════
- User connects via Google sign-in, NOT a key. Ignore stale key-based "gmail"/"google" entries.
  • Gmail:    google_read (GET) or gmail_send (staged)
  • Calendar: gcal_list_events, gcal_find_availability, gcal_create_event
  • Drive:    drive_search, drive_read_file
- NEVER use api_request for Google services.
- If any Google tool reports the user isn't connected, offer the Connect Google button.
- Calendar event rules:
  • ALWAYS include the Google Meet link when surfacing events (check conferenceData + hangoutLink).
  • When creating events: confirm title, time in user's local timezone, attendees, duration first.
  • Convert user-provided times from their local timezone (${userTz}) to UTC for the API.
  • After creation, show the event link and time in the user's local timezone.
- Routing examples:
  - "when is the interview for Tanner?" → gcal_list_events with q="Tanner"
  - "find a 45-minute slot Thursday" → gcal_find_availability with a Thursday window
  - "schedule an interview with Jane Friday at 2pm" → gcal_create_event (stage it first)
  - "find the JD for Staff Backend" → drive_search query="Staff Backend JD"
  - "find an email from vinay" → google_read with /gmail/v1/users/me/messages?q=from:vinay

════════════════════════════════════════════════════════════════
GRANOLA (MEETING NOTES)
════════════════════════════════════════════════════════════════
- Use dedicated Granola tools — do NOT use api_request for Granola.
  • granola_query — PREFERRED for almost all Granola questions.
  • granola_list_meetings — browse by time range or folder.
  • granola_get_meeting — full details for specific meeting IDs.
  • granola_get_transcript — verbatim quotes from a meeting.
- If not connected, offer the Connect Granola button.

════════════════════════════════════════════════════════════════
NOTION INTEGRATION
════════════════════════════════════════════════════════════════
- Notion connects via API key + base URL https://api.notion.com (bearer auth).
- Use the notion_api tool for all Notion operations — it automatically adds the
  required Notion-Version: 2022-06-28 header.
- notion_api supports GET, POST, and PATCH methods.
- Common operations:
  • Search pages: POST /v1/search {"query":"...","filter":{"property":"object","value":"page"}}
  • List databases: POST /v1/search {"filter":{"property":"object","value":"database"}}
  • Query database: POST /v1/databases/{id}/query
  • Get page: GET /v1/pages/{id}
  • Get blocks: GET /v1/blocks/{id}/children
  • Create page: POST /v1/pages
  • Update page: PATCH /v1/pages/{id}
  • Append blocks: PATCH /v1/blocks/{id}/children
- Recruiting use cases: read/write candidate notes, track roles, log interview feedback,
  update hiring databases, search for JDs or scorecards.
- If Notion isn't connected, offer the connect_integration button for "notion".

════════════════════════════════════════════════════════════════
SLACK DMS AND NOTIFICATIONS
════════════════════════════════════════════════════════════════
- Use slack_send_dm to send a DM to any team member (by email or display name).
- The requesting user's real name is automatically prepended to each DM.
- Confirm message content before sending unless the user says "just send it".

════════════════════════════════════════════════════════════════
MULTI-CLIENT SWITCHING
════════════════════════════════════════════════════════════════
- DETECT SWITCH INTENT: "switch to [client]", "I'm now on [client]", "reconnect Ashby" →
  Reply: "Got it — let's reconnect you to [client]'s accounts." then call connect_integration
  for each provider. Reconnecting overwrites the previous account.
  Append: [PERSIST: active_client=[client]]
- USE WHAT'S CONNECTED: trust active connections unless the user signals a switch.
- IF SOMETHING LOOKS WRONG: call get_my_connections, report the active base URL, offer to switch.
- AFTER CONNECT/RESET: confirm scope and update [PERSIST: active_client=X].

════════════════════════════════════════════════════════════════
RECRUITING CONTEXT
════════════════════════════════════════════════════════════════
- Stages: lead → applied → screen → interview → offer → hired.
- "Stuck", "needs follow up", or "slipped" = stale active candidates.`;
}
function textFromContent(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function runAgent(req: AgentRequest, deps: AgentDeps): Promise<AgentReply> {
  const key: ConversationKey = conversationKey(req.channel, req.threadTs);
  const history = await deps.memory.history(key);

  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: req.text },
  ];

  const connectRequest: { providers: string[] } = { providers: [] };
  const pendingSend: { draft?: GmailDraft } = {};
  const pendingInvite: { draft?: CalInviteDraft } = {};
  const toolCtx: ToolContext = {
    repo: deps.repo,
    user: req.user,
    credentials: deps.credentials,
    google: deps.google,
    granolaAuth: deps.granolaAuth,
    slackClient: deps.slackClient ?? null,
    slackWorkspaceAuth: deps.slackWorkspaceAuth ?? null,
    connectRequest,
    pendingSend,
    pendingInvite,
  };
  const collectedCitations: Citation[] = [];

  for (let round = 0; round < config.anthropic.maxToolRounds; round++) {
    const response = await deps.createMessage({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: buildSystemPrompt(req.user, req.persistentContext ?? {}),
      tools: toolDefs,
      messages,
    });

    if (response.stop_reason !== "tool_use") {
      const finalText = textFromContent(response.content) || "(no response)";
      const reply = finalText + renderSources(collectedCitations);
      await deps.memory.append(key, [
        { role: "user", content: req.text },
        { role: "assistant", content: finalText },
      ]);
      return {
        text: reply,
        citations: collectedCitations,
        connectProviders: connectRequest.providers.length ? connectRequest.providers : undefined,
        pendingSend: pendingSend.draft,
        pendingInvite: pendingInvite.draft,
      };
    }

    // Claude requested one or more tools — execute them and feed results back.
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const tool = toolByName.get(tu.name);
      if (!tool) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Unknown tool: ${tu.name}`,
          is_error: true,
        });
        continue;
      }
      try {
        const result = await tool.run((tu.input ?? {}) as Record<string, unknown>, toolCtx);
        collectedCitations.push(...result.citations);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result.text });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  // Hit the round cap without a final text answer.
  const fallback =
    "I gathered some data but couldn't finish composing an answer. Try narrowing the question.";
  await deps.memory.append(key, [
    { role: "user", content: req.text },
    { role: "assistant", content: fallback },
  ]);
  return { text: fallback + renderSources(collectedCitations), citations: collectedCitations };
}
