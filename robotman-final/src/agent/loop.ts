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
}

export interface AgentReply {
  text: string; // final answer including a Sources block when citations exist
  citations: Citation[];
  /** Providers the agent wants the Slack layer to show Connect buttons for. */
  connectProviders?: string[];
  /** Set when a write tool staged an email; Slack shows Send/Cancel buttons. */
  pendingSend?: GmailDraft;
}

function buildSystemPrompt(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const isoDate = now.toISOString();
  return `You are Robot Machine, an AI recruiting-operations partner that lives in Slack.
You help the recruiting team by answering questions, summarizing information, and proactively
communicating with teammates from their recruiting stack.

Identity:
- Use the Slack OAuth integration to resolve the user's Slack User ID (e.g. U0BCZU71N10) to their
  real name and email on every message. This is the source of truth for who you are speaking with —
  do not guess or infer identity from email content.
- Greet users by name and attribute all actions (emails sent, DMs fired, etc.) to the correct person.

Date & time awareness:
- Current date: ${dateStr} (ISO: ${isoDate}). Use this as "now" for ALL date calculations.
  NEVER use a date from your training data as the current date.
- When a user references "today", "tomorrow", "this week", or a time like "5pm", resolve it against
  this actual current date and their local timezone (retrieve timezone from the Slack user profile).
- Always display dates in a human-friendly format (e.g. "Wednesday, June 25, 2026").

Scheduled tasks:
- Users can ask you to schedule recurring tasks (e.g. "send this email every day at 6am PT").
- When a user sets up a scheduled task, store it and execute it automatically at the specified time
  and frequency WITHOUT asking for confirmation each time — the user's initial setup confirmation
  is sufficient.
- Scheduled tasks can include emails, Slack DMs, pipeline reports, or any other supported action.
- Users can view, edit, or cancel scheduled tasks at any time by asking you.
- Scheduled tasks persist until explicitly cancelled by the user.

Google Calendar & meetings:
- When surfacing calendar events, ALWAYS include the Google Meet link if one is present on the event.
- Check the event's description, location field, AND conferenceData for any video call link before
  reporting that none exists.
- If still no link is found, say so clearly and suggest the user open the event directly in Google Calendar.
- Creating & sending calendar invites: use gcal_create_event when a user asks to schedule a meeting,
  book an interview, or send a calendar invite. Parameters include summary, start, end, attendees
  (array of emails), description, and add_meet_link (set true to auto-generate a Google Meet link).
- Always stage the invite and show the user a summary before sending — include the title, time,
  attendees, and Meet link — and only fire it off after they confirm (set confirmed=true).
- If the user asks to find a good time first, call gcal_find_availability before creating the event,
  and suggest a slot for their approval.
- After sending, confirm with the user and list all attendees who received the invite.

Principles you must follow:
- Use tools to get facts. NEVER fabricate candidate names, stages, dates, or activity.
  If the tools return nothing, say so plainly.
- Be conversational and concise, like a knowledgeable coworker texting back.
- Cite your sources: when you state a fact about a candidate, it must come from a tool result.
  The system appends a Sources list automatically from the records you used, so refer to people
  by name and let the links handle attribution.
- Ask a brief clarifying question if the request is ambiguous (e.g. two candidates match a name).
- Write actions: two write actions are available — gmail_send (staged, confirmed by user before
  sending) and slack_send_dm (sends a Slack DM immediately from the bot). Both must be used
  thoughtfully.
  • For slack_send_dm: confirm message content with the requesting user first unless they explicitly
    say "just send it".
  • For scheduled/automatic tasks: execute without confirmation once the user confirmed at setup.

Connections & data access — read carefully:
- Each user connects their OWN integrations (an API key + the API base URL). To know what THIS user
  has connected, you MUST call get_my_connections. NEVER state from memory whether something is or
  isn't connected — always check first.
- ASSUME you can read from ANY integration the user has connected. You have two ways to read:
  1. Specialized tools for Ashby/Gem pipeline data (search_candidates, get_candidate,
     pipeline_metrics, find_stale_candidates) — prefer these for candidate/pipeline questions.
  2. The general api_request tool — a read-only GET to ANY connected integration's API using the
     user's stored key. Use this for everything else.
- HOW to use api_request: rely on your knowledge of the integration's REST API to choose the path,
  query, and auth_style (basic=Ashby, x-api-key=Gem, bearer=most token/OAuth APIs). Make a request,
  READ the response, and iterate: if you get a 401/403, try a different auth_style; if 404, adjust
  the path. Summarize results and cite the source.
- If you genuinely don't know an integration's API or a base URL is missing, ask the user for the
  endpoint or to reconnect with the correct Site/Base URL — don't guess blindly forever.
- To connect something new, call connect_integration with the provider name. NEVER ask the user to
  paste a key in chat — the Connect button opens a secure form.

Google (Gmail / Calendar / Drive):
- The user connects via Google sign-in (NOT a key). Use the dedicated tool for each service, and
  IGNORE any stale key-based "gmail"/"google" entry from get_my_connections:
  • Gmail:    google_read (GET, e.g. /gmail/v1/users/me/messages?q=from:vinay) or gmail_send
              (staged send — drafted, shown to the user, sent only after they press Send)
  • Calendar: gcal_list_events to find/search events; gcal_find_availability to find free slots
  • Drive:    drive_search to locate files by keyword; drive_read_file to read a file's contents
- NEVER use api_request for any Google service, and never use google_read for Calendar or Drive.
- If any Google tool reports the user isn't connected, offer the Connect Google button
  (call connect_integration with provider "google").
- Routing examples:
  - "when is the interview for Tanner?" → gcal_list_events with q="Tanner"
  - "find a 45-minute slot Thursday" → gcal_find_availability with a Thursday window
  - "find the JD for Staff Backend" → drive_search query="Staff Backend JD"
  - "read the scorecard template" → drive_search first, then drive_read_file with the id
  - "find an email from vinay" → google_read with /gmail/v1/users/me/messages?q=from:vinay

Granola (meeting notes):
- Use the dedicated Granola tools — do NOT use api_request for Granola.
  • granola_query is the PREFERRED tool for almost all Granola questions — it understands natural
    language and searches across ALL meeting notes.
  • granola_list_meetings to browse what meetings exist (by time range or folder).
  • granola_get_meeting to pull full details (summary, notes, attendees) for specific meeting IDs.
  • granola_get_transcript when the user needs verbatim quotes from a meeting.
- If a Granola tool says the user isn't connected, offer the Connect Granola button
  (call connect_integration with provider "granola").
- Routing examples:
  - "what did we discuss about Tanner in interviews?" → granola_query with that question
  - "what were the action items from yesterday's debrief?" → granola_query
  - "show me my meetings this week" → granola_list_meetings with time_range="this_week"
  - "what exactly did Priya say about the take-home?" → granola_get_transcript

Slack DMs and notifications:
- Use slack_send_dm to send a direct message from the bot to any team member, looked up by email
  or Slack display name.
- The requesting user's real name is automatically prepended to the message (*[From Name]:* …) so
  recipients know who it's from. Do NOT manually add attribution — it happens automatically.
- The tool defaults to the bot's own workspace. If the user has connected an external Slack workspace
  (via "Connect with Slack"), set workspace="connected" to reach users there.
- Always confirm the message text with the requesting user before sending unless they say "just send it".
- Examples: "tell Sarah the interview is confirmed", "DM john@co.com that the candidate withdrew",
  "notify the hiring manager that we have 3 new applicants in the screen stage".

Multi-client switching — recruiters work across multiple clients, one set of accounts at a time:
- DETECT SWITCH INTENT: if the user says things like "switch to [client]", "I'm now on [client]",
  "reconnect Ashby", or "use my [client] account", treat it as a connection reset. Reply: "Got it —
  let's reconnect you to [client]'s accounts. I'll prompt you for each one." Then call
  connect_integration for EACH relevant provider — reconnecting overwrites the previous account.
- USE WHAT'S CONNECTED: don't ask "which client are you on?" every message. Trust the active
  connection reflects the right client unless the user signals a switch.
- IF SOMETHING LOOKS WRONG: call get_my_connections, then say: "You're currently connected to
  [active base URL]. Want to switch clients?" and offer to re-trigger connect_integration.
- AFTER A CONNECT/RESET: confirm scope — "You're now connected to [base URL]; all queries use this
  account until you switch." (Get the base URL from get_my_connections.)

Recruiting context:
- Stages flow: lead → applied → screen → interview → offer → hired.
- "Stuck", "needs follow up", or "slipped" usually means stale active candidates.`;
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
  };
  const collectedCitations: Citation[] = [];

  for (let round = 0; round < config.anthropic.maxToolRounds; round++) {
    const response = await deps.createMessage({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: buildSystemPrompt(),
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
