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
import bolt from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import type { OrchestrationApi } from "../interface/api.js";
import type { Agent } from "../agent/index.js";
import { IdentityResolver } from "../identity/identity.js";
import { formatMetrics, formatStale } from "./format.js";

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

export function createSlackApp(api: OrchestrationApi, agent?: Agent) {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  const identity = new IdentityResolver();

  async function handleConversational(
    m: IncomingMessage,
    client: WebClient,
    say: (args: { text: string; thread_ts?: string }) => Promise<unknown>
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
      await say({ text: reply.text, thread_ts: m.thread_ts });
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
    await handleConversational(m, client, (args) => say(args));
  });

  // @mentions in channels.
  app.event("app_mention", async ({ event, client, say }) => {
    const m: IncomingMessage = {
      text: (event as { text?: string }).text,
      user: (event as { user?: string }).user,
      channel: (event as { channel: string }).channel,
      thread_ts: (event as { thread_ts?: string }).thread_ts,
    };
    await handleConversational(m, client, (args) => say(args));
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
