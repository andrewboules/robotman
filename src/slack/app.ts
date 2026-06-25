/**
 * SLACK APP (the thin shell)
 * --------------------------
 * One Bolt app. Two ways in:
 *   1. Conversational — DM the bot (or @mention it); messages route to the
 *      agent loop, which answers with citations. This is the Robot Machine UX.
 *   2. Slash commands — /metrics and /stale for quick deterministic reports.
 * No business logic lives here; it resolves the user's identity and delegates.
 * Runs in Socket Mode (no public URL needed).
 */
import { randomUUID } from "node:crypto";
import bolt from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import type { OrchestrationApi } from "../interface/api.js";
import type { Agent } from "../agent/index.js";
import type { CredentialService } from "../identity/credentials.js";
import type { GoogleAuth } from "../google/oauth.js";
import { encodeState } from "../google/oauth.js";
import { sendGmail, type GmailDraft } from "../google/gmail.js";
import { IdentityResolver } from "../identity/identity.js";
import { formatMetrics, formatStale } from "./format.js";
import { connectButtonBlocks, registerConnectHandlers } from "./connect.js";

const { App } = bolt;

/** Fields we read off a Slack message event (narrowed from Bolt's union type). */
interface IncomingMessage {
  subtype?: string;
  bot_id?: string;
  text?: string;
  user?: string;
  channel: string;
  channel_type?: string;
  thread_ts?: string;
}

export function createSlackApp(
  api: OrchestrationApi,
  agent?: Agent,
  credentials?: CredentialService,
  google?: GoogleAuth | null
) {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  const identity = new IdentityResolver();

  if (credentials?.enabled) registerConnectHandlers(app, credentials);

  // Staged email drafts awaiting Send confirmation, keyed by a short id.
  const pendingSends = new Map<string, { slackUserId: string; draft: GmailDraft }>();

  function googleConnectBlocks(slackUserId: string): unknown[] | null {
    if (!google || !config.publicUrl) return null;
    const startUrl = new URL(`${config.publicUrl.replace(/\/$/, "")}/oauth/google/start`);
    startUrl.searchParams.set("state", encodeState(slackUserId));
    const url = startUrl.toString();
    return [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Connect Google" },
            url,
            style: "primary",
          },
        ],
      },
    ];
  }

  function sendConfirmBlocks(text: string, draft: GmailDraft, slackUserId: string): unknown[] {
    const id = randomUUID();
    // Bound memory: drop the oldest staged draft if the map grows large.
    if (pendingSends.size >= 200) {
      const oldest = pendingSends.keys().next().value;
      if (oldest) pendingSends.delete(oldest);
    }
    pendingSends.set(id, { slackUserId, draft });
    return [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*To:* ${draft.to}${draft.cc ? `\n*Cc:* ${draft.cc}` : ""}\n*Subject:* ${draft.subject}\n\n${draft.body}`,
        },
      },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "gmail_confirm", value: id, style: "primary", text: { type: "plain_text", text: "Send" } },
          { type: "button", action_id: "gmail_cancel", value: id, style: "danger", text: { type: "plain_text", text: "Cancel" } },
        ],
      },
    ];
  }

  // Send confirmation — only the drafter can send.
  app.action("gmail_confirm", async ({ ack, body, action, respond }) => {
    await ack();
    const id = (action as { value?: string }).value ?? "";
    const pending = pendingSends.get(id);
    const clicker = (body as { user?: { id?: string } }).user?.id;
    if (!pending || !google) {
      await respond({ replace_original: true, text: "This draft is no longer available." });
      return;
    }
    if (clicker !== pending.slackUserId) {
      await respond({ replace_original: false, text: "Only the person who drafted this can send it." });
      return;
    }
    try {
      const token = await google.getAccessToken(pending.slackUserId);
      if (!token) {
        await respond({ replace_original: true, text: "Your Google connection expired — reconnect and try again." });
        return;
      }
      const result = await sendGmail(token, pending.draft);
      pendingSends.delete(id);
      await respond({
        replace_original: true,
        text: result.ok ? `✅ Sent to ${pending.draft.to}.` : `❌ Send failed (HTTP ${result.status}). ${result.detail.slice(0, 300)}`,
      });
    } catch (err) {
      await respond({ replace_original: true, text: `❌ Send error: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.action("gmail_cancel", async ({ ack, action, respond }) => {
    await ack();
    pendingSends.delete((action as { value?: string }).value ?? "");
    await respond({ replace_original: true, text: "🚫 Draft discarded — nothing was sent." });
  });

  async function handleConversational(
    m: IncomingMessage,
    client: WebClient,
    say: (args: {
      text: string;
      thread_ts?: string;
      blocks?: unknown[];
    }) => Promise<unknown>
  ): Promise<void> {
    if (!m.text || !m.user) return;
    if (!agent) {
      await say({ text: "The assistant isn't configured yet (missing ANTHROPIC_API_KEY).", thread_ts: m.thread_ts });
      return;
    }
    try {
      const info = await client.users.info({ user: m.user });
      const user = identity.resolve(
        m.user,
        info.user?.profile?.email ?? null,
        info.user?.real_name ?? null
      );
      const reply = await agent.ask({
        user,
        channel: m.channel,
        threadTs: m.thread_ts ?? null,
        text: m.text,
      });
      // Attach interactive blocks when the agent staged a send or wants a connect.
      let blocks: unknown[] | undefined;
      if (reply.pendingSend) {
        blocks = sendConfirmBlocks(reply.text, reply.pendingSend, user.slackUserId);
      } else if (reply.connectProvider === "google") {
        const g = googleConnectBlocks(user.slackUserId);
        blocks = g ? [{ type: "section", text: { type: "mrkdwn", text: reply.text } }, ...g] : undefined;
      } else if (reply.connectProvider && credentials?.enabled) {
        blocks = [
          { type: "section", text: { type: "mrkdwn", text: reply.text } },
          ...connectButtonBlocks(reply.connectProvider),
        ];
      }
      await say({ text: reply.text, thread_ts: m.thread_ts, blocks });
    } catch (err) {
      await say({
        text: `Sorry — something went wrong: ${err instanceof Error ? err.message : String(err)}`,
        thread_ts: m.thread_ts,
      });
    }
  }

  // DMs to the bot.
  app.message(async ({ message, client, say }) => {
    const m = message as IncomingMessage;
    if (m.subtype || m.bot_id) return; // ignore edits, bot echoes, joins, etc.
    if (m.channel_type !== "im") return; // DMs only for now
    await handleConversational(m, client, (args) => say(args as bolt.SayArguments));
  });

  // @mentions in channels.
  app.event("app_mention", async ({ event, client, say }) => {
    const m: IncomingMessage = {
      text: (event as { text?: string }).text,
      user: (event as { user?: string }).user,
      channel: (event as { channel: string }).channel,
      thread_ts: (event as { thread_ts?: string }).thread_ts,
    };
    await handleConversational(m, client, (args) => say(args as bolt.SayArguments));
  });

  // /metrics — quick deterministic pipeline report.
  app.command("/metrics", async ({ ack, respond }) => {
    await ack();
    const metrics = await api.getPipelineMetrics();
    const last = (await api.lastSyncInfo())?.finishedAt ?? null;
    await respond({ response_type: "ephemeral", text: formatMetrics(metrics, last) });
  });

  // /stale — stuck-candidate report.
  app.command("/stale", async ({ ack, respond }) => {
    await ack();
    const stale = await api.getStaleCandidates();
    await respond({ response_type: "ephemeral", text: formatStale(stale, config.staleAfterDays) });
  });

  return app;
}
