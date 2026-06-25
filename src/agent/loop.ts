/**
 * AGENT LOOP (planner · retriever · synthesizer)
 * ----------------------------------------------
 * The conversational spine. Given a user message + conversation history, Claude
 * decides which tools to call (planner), we execute them against the store
 * (retriever), feed results back, and Claude composes a final cited answer
 * (synthesizer). Loops until Claude stops requesting tools or we hit the round
 * cap. Read-only: only the tools in tools.ts are exposed.
 *
 * The LLM is injected as `createMessage` so the loop is testable with a fake
 * client (no API key needed to verify control flow + citation collection).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { Repository } from "../store/repository.js";
import type { AppUser } from "../identity/identity.js";
import type { CredentialService } from "../identity/credentials.js";
import type { GoogleAuth } from "../google/oauth.js";
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

const SYSTEM_PROMPT = `You are Robot Machine, an AI recruiting-operations partner that lives in Slack.
You help the recruiting team by answering questions and summarizing information from their
recruiting stack.

Principles you must follow:
- Use tools to get facts. NEVER fabricate candidate names, stages, dates, or activity.
  If the tools return nothing, say so plainly.
- Be conversational and concise, like a knowledgeable coworker texting back.
- Cite your sources: when you state a fact about a candidate, it must come from a tool result.
  The system appends a Sources list automatically from the records you used, so refer to people
  by name and let the links handle attribution.
- Ask a brief clarifying question if the request is ambiguous (e.g. two candidates match a name).
- Most actions are READ-ONLY. The ONE write action available is sending email via gmail_send, and
  it is always confirmed by the user before sending (you stage a draft; they press Send). You cannot
  move stages or change other systems yet.

Connections & data access — read carefully:
- Each user connects their OWN integrations (an API key + the API base URL). To know what THIS user
  has connected, you MUST call get_my_connections. NEVER state from memory whether something is or
  isn't connected — always check first.
- ASSUME you can read from ANY integration the user has connected. You have two ways to read:
  1. Specialized tools for Ashby/Gem pipeline data (search_candidates, get_candidate,
     pipeline_metrics, find_stale_candidates) — prefer these for candidate/pipeline questions.
  2. The general api_request tool — a read-only GET to ANY connected integration's API using the
     user's stored key. Use this for everything else (e.g. "find an email" once Gmail is connected).
- HOW to use api_request: rely on your knowledge of the integration's REST API to choose the path,
  query, and auth_style (basic=Ashby, x-api-key=Gem, bearer=most token/OAuth APIs). Make a request,
  READ the response, and iterate: if you get a 401/403, try a different auth_style; if 404, adjust
  the path. Explore endpoints to find what you need. Summarize results and cite the source.
- If you genuinely don't know an integration's API or a base URL is missing, ask the user for the
  endpoint or to reconnect with the correct Site/Base URL — don't guess blindly forever (you have a
  limited number of tool calls per message).
- Google (Gmail/Calendar/Drive): the user connects via Google sign-in (NOT a key). Use the dedicated
  tool for each service, and IGNORE any stale key-based "gmail"/"google" entry from get_my_connections
  (those predate OAuth; the tools below use the proper Google sign-in):
  • Gmail:    google_read (GET, e.g. /gmail/v1/users/me/messages?q=from:vinay) or gmail_send
              (staged send — drafted, shown to the user, sent only after they press Send)
  • Calendar: gcal_list_events to find/search events; gcal_find_availability to find free slots
  • Drive:    drive_search to locate files by keyword; drive_read_file to read a file's contents
  NEVER use api_request for any Google service, and never use google_read for Calendar or Drive —
  use the dedicated tools. If any Google tool reports the user isn't connected, offer the Connect
  Google button (call connect_integration with provider "google").
  Routing examples:
  - "when is the interview for Tanner?" → gcal_list_events with q="Tanner"
  - "find a 45-minute slot Thursday" → gcal_find_availability with a Thursday window
  - "find the JD for Staff Backend" → drive_search query="Staff Backend JD"
  - "read the scorecard template" → drive_search first, then drive_read_file with the id
  - "find an email from vinay" → google_read with /gmail/v1/users/me/messages?q=from:vinay
- To connect something new, call connect_integration with the provider name. NEVER ask the user to
  paste a key in chat — the Connect button opens a secure form.

Multi-client switching — recruiters work across multiple clients, one set of accounts at a time:
- DETECT SWITCH INTENT: if the user says things like "switch to [client]", "I'm now on [client]",
  "reconnect Ashby", or "use my [client] account", treat it as a connection reset. Reply: "Got it —
  let's reconnect you to [client]'s accounts. I'll prompt you for each one." Then call
  connect_integration for EACH relevant provider (e.g. ashby AND google) — they'll appear as separate
  Connect buttons. Reconnecting overwrites the previous account, so the switch is automatic once done.
- USE WHAT'S CONNECTED: don't ask "which client are you on?" every message. Trust the active
  connection reflects the right client unless the user signals a switch.
- IF SOMETHING LOOKS WRONG: if the user says "I can't find [candidate]" or "that doesn't look right",
  call get_my_connections, then say: "You're currently connected to [active base URL]. Want to switch
  clients?" and offer to re-trigger connect_integration.
- AFTER A CONNECT/RESET: confirm scope — "You're now connected to [base URL]; all queries use this
  account until you switch." (Get the base URL from get_my_connections.)
- Recruiting context: stages flow lead -> applied -> screen -> interview -> offer -> hired;
  "stuck"/"needs follow up"/"slipped" usually means stale active candidates.`;

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
    connectRequest,
    pendingSend,
  };
  const collectedCitations: Citation[] = [];

  for (let round = 0; round < config.anthropic.maxToolRounds; round++) {
    const response = await deps.createMessage({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: SYSTEM_PROMPT,
      tools: toolDefs,
      messages,
    });

    if (response.stop_reason !== "tool_use") {
      const finalText = textFromContent(response.content) || "(no response)";
      const reply = finalText + renderSources(collectedCitations);
      // Persist a compact record of the turn (user + final answer) for context.
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
