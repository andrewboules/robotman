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
  /** Set when the agent wants the Slack layer to show a Connect button. */
  connectProvider?: string;
}

const SYSTEM_PROMPT = `You are Robot Machine, an AI recruiting-operations partner that lives in Slack.
You help the recruiting team by answering questions and summarizing information from their
recruiting stack. Right now you can read from Ashby and Gem via tools.

Principles you must follow:
- Use tools to get facts. NEVER fabricate candidate names, stages, dates, or activity.
  If the tools return nothing, say so plainly.
- Be conversational and concise, like a knowledgeable coworker texting back.
- Cite your sources: when you state a fact about a candidate, it must come from a tool result.
  The system appends a Sources list automatically from the records you used, so refer to people
  by name and let the links handle attribution.
- Ask a brief clarifying question if the request is ambiguous (e.g. two candidates match a name).
- You are READ-ONLY for source data. You cannot move stages, send email, or change anything yet.
  If asked to, explain that write actions aren't enabled yet.
- Connecting integrations: each user connects their OWN API keys. If the user wants data from a
  source they haven't connected (use get_my_connections to check), or asks to connect one, call
  connect_integration with the provider name. NEVER ask the user to paste an API key in chat — the
  Connect button opens a secure form for that.
- Understand recruiting context: stages flow lead -> applied -> screen -> interview -> offer -> hired;
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

  const connectRequest: { provider?: string } = {};
  const toolCtx: ToolContext = {
    repo: deps.repo,
    user: req.user,
    credentials: deps.credentials,
    connectRequest,
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
      return { text: reply, citations: collectedCitations, connectProvider: connectRequest.provider };
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
