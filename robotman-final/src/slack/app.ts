/**
 * SLACK APP (the thin shell)
 * --------------------------
 * One Bolt app. Two ways in:
 *   1. Conversational — DM the bot (or @mention it); messages route to the
 *      agent loop, which answers with citations. This is the Robot Machine UX.
 *   2. Slash commands — /metrics and /stale for quick deterministic reports.
 * No business logic lives here; it resolves the user's identity and delegates.
 * Runs in Socket Mode (no public URL needed).
 *
 * Connect flows supported:
 *   - Google OAuth  (/oauth/google/start → callback)
 *   - Granola OAuth (/oauth/granola/start → callback)
 *   - Any other integration via the /connect modal (API key + base URL)
 *
 * `getAgent` is a getter so the agent can be wired after the app is constructed
 * (avoids the circular: App needs Agent for the client, Agent needs App's client).
 */
import { randomUUID } from "node:crypto";
import bolt from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import type { OrchestrationApi } from "../interface/api.js";
import type { Agent } from "../agent/index.js";
import type { CredentialService } from "../identity/credentials.js";
import type { GoogleAuth } from "../google/oauth.js";
import type { GranolaAuth } from "../granola/oauth.js";
import { encodeState } from "../google/oauth.js";
import { encodeGranolaState, generatePKCE } from "../granola/oauth.js";
import type { SlackWorkspaceAuth } from "../slack/workspace-oauth.js";
import { buildSlackAuthUrl } from "../slack/workspace-oauth.js";
import { sendGmail, gcalCreateEvent, type GmailDraft } from "../google/gmail.js";
import type { CalInviteDraft } from "../agent/tools.js";
import { IdentityResolver } from "../identity/identity.js";
import { UserContextService, parsePersistTags, stripPersistTags } from "../identity/user-context.js";
import { formatMetrics, formatStale } from "./format.js";
import { registerConnectHandlers } from "./connect.js";

const { App } = bolt;

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
  /** Getter for the agent — allows wiring after app construction. */
  getAgent: () => Agent | undefined,
  credentials?: CredentialService,
  google?: GoogleAuth | null,
  granolaAuth?: GranolaAuth | null,
  slackWorkspaceAuth?: SlackWorkspaceAuth | null,
  userContextService?: UserContextService | null
) {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  const identity = new IdentityResolver();

  if (credentials?.enabled) registerConnectHandlers(app, credentials);

  // Staged email drafts awaiting Send confirmation.
  const pendingSends = new Map<string, { slackUserId: string; draft: GmailDraft }>();
  const pendingInvites = new Map<string, { slackUserId: string; draft: CalInviteDraft }>();

  /** Build a Google OAuth connect button for a given Slack user. */
  function googleConnectBlocks(slackUserId: string): unknown[] | null {
    if (!google || !config.publicUrl) return null;
    const startUrl = new URL(`${config.publicUrl.replace(/\/$/, "")}/oauth/google/start`);
    startUrl.searchParams.set("state", encodeState(slackUserId));
    return [
      {
        type: "button",
        text: { type: "plain_text", text: "Connect Google" },
        url: startUrl.toString(),
        style: "primary",
      },
    ];
  }

  /** Build a Granola OAuth connect button for a given Slack user. */
  function granolaConnectBlocks(slackUserId: string): unknown[] | null {
    if (!granolaAuth || !config.publicUrl) return null;
    const { verifier } = generatePKCE();
    const state = encodeGranolaState(slackUserId, verifier);
    const startUrl = new URL(`${config.publicUrl.replace(/\/$/, "")}/oauth/granola/start`);
    startUrl.searchParams.set("state", state);
    return [
      {
        type: "button",
        text: { type: "plain_text", text: "Connect Granola" },
        url: startUrl.toString(),
        style: "primary",
      },
    ];
  }

  /** Build a "Connect with Slack" OAuth button for a given Slack user. */
  function slackWorkspaceConnectBlocks(slackUserId: string): unknown[] | null {
    if (!slackWorkspaceAuth || !config.slack.clientId || !config.publicUrl) return null;
    const url = buildSlackAuthUrl(slackUserId);
    return [
      {
        type: "button",
        text: { type: "plain_text", text: "Connect with Slack" },
        url,
        style: "primary",
      },
    ];
  }

  /** One Connect button per provider, routing OAuth providers through their flows. */
  function connectButtonsFor(providers: string[], slackUserId: string): unknown[] {
    const buttons: unknown[] = [];
    for (const provider of providers.slice(0, 5)) {
      if (provider === "google") {
        const b = googleConnectBlocks(slackUserId);
        if (b) buttons.push(...b);
      } else if (provider === "granola") {
        const b = granolaConnectBlocks(slackUserId);
        if (b) buttons.push(...b);
      } else if (provider === "slack-workspace") {
        const b = slackWorkspaceConnectBlocks(slackUserId);
        if (b) buttons.push(...b);
      } else if (credentials?.enabled) {
        buttons.push({
          type: "button",
          action_id: `connect:${provider}`,
          text: { type: "plain_text", text: `Connect ${provider}` },
          style: "primary",
        });
      }
    }
    return buttons;
  }

  function sendConfirmBlocks(text: string, draft: GmailDraft, slackUserId: string): unknown[] {
    const id = randomUUID();
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

  function inviteConfirmBlocks(text: string, draft: CalInviteDraft, slackUserId: string): unknown[] {
    const id = randomUUID();
    if (pendingInvites.size >= 200) {
      const oldest = pendingInvites.keys().next().value;
      if (oldest) pendingInvites.delete(oldest);
    }
    pendingInvites.set(id, { slackUserId, draft });
    const attendeeStr = draft.attendees.length ? draft.attendees.join(", ") : "no attendees";
    const meetNote = draft.addMeetLink ? "✅ Meet link will be generated" : "No Meet link";
    return [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Title:* ${draft.summary}
` +
            `*Start:* ${draft.start}
` +
            `*End:* ${draft.end}
` +
            `*Attendees:* ${attendeeStr}
` +
            (draft.description ? `*Description:* ${draft.description}
` : "") +
            (draft.location ? `*Location:* ${draft.location}
` : "") +
            `*Meet link:* ${meetNote}`,
        },
      },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "gcal_confirm", value: id, style: "primary", text: { type: "plain_text", text: "Create Event" } },
          { type: "button", action_id: "gcal_cancel", value: id, style: "danger", text: { type: "plain_text", text: "Cancel" } },
        ],
      },
    ];
  }

  app.action("gcal_confirm", async ({ ack, body, action, respond }) => {
    await ack();
    const id = (action as { value?: string }).value ?? "";
    const pending = pendingInvites.get(id);
    const clicker = (body as { user?: { id?: string } }).user?.id;
    if (!pending || !google) {
      await respond({ replace_original: true, text: "This invite is no longer available." });
      return;
    }
    if (clicker !== pending.slackUserId) {
      await respond({ replace_original: false, text: "Only the person who staged this invite can create it." });
      return;
    }
    try {
      const token = await google.getAccessToken(pending.slackUserId);
      if (!token) {
        await respond({ replace_original: true, text: "Your Google connection expired — reconnect and try again." });
        return;
      }
      const { event, status, error } = await gcalCreateEvent(token, pending.draft);
      pendingInvites.delete(id);
      if (!event) {
        await respond({ replace_original: true, text: `❌ Failed to create event (HTTP ${status}): ${error ?? "unknown error"}` });
        return;
      }
      const meetStr = event.meetLink ? `
*Meet link:* ${event.meetLink}` : "";
      const invitedStr = event.attendees.length ? `
*Invites sent to:* ${event.attendees.join(", ")}` : "";
      await respond({
        replace_original: true,
        text:
          `✅ *Calendar invite created!*
` +
          `*Title:* ${event.summary}
` +
          `*Start:* ${event.start}
` +
          `*End:* ${event.end}` +
          meetStr + invitedStr +
          `
*Event link:* ${event.htmlLink}`,
      });
    } catch (err) {
      await respond({ replace_original: true, text: `❌ Calendar error: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.action("gcal_cancel", async ({ ack, action, respond }) => {
    await ack();
    pendingInvites.delete((action as { value?: string }).value ?? "");
    await respond({ replace_original: true, text: "🚫 Calendar invite cancelled." });
  });

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
    say: (args: { text: string; thread_ts?: string; blocks?: unknown[] }) => Promise<unknown>
  ): Promise<void> {
    if (!m.text || !m.user) return;
    const agent = getAgent();
    if (!agent) {
      await say({ text: "The assistant isn't configured yet (missing ANTHROPIC_API_KEY).", thread_ts: m.thread_ts });
      return;
    }
    try {
      let info: Awaited<ReturnType<typeof client.users.info>> | null = null;
      try { info = await client.users.info({ user: m.user }); } catch { /* fall through */ }
      const profile = info?.user?.profile as Record<string, unknown> | undefined;
      const user = identity.resolve(
        m.user,
        (profile?.["email"] as string | undefined) ?? null,
        (profile?.["real_name"] as string | undefined) ?? (info?.user?.real_name as string | undefined) ?? null,
        (info?.user as Record<string, unknown> | undefined)?.["tz"] as string | undefined ?? null,
        (profile?.["first_name"] as string | undefined) ?? null,
        typeof (info?.user as Record<string, unknown> | undefined)?.["tz_offset"] === "number"
          ? ((info?.user as Record<string, unknown>)["tz_offset"] as number)
          : null
      );
      // Prefix message with sender identity for multi-user thread awareness
      const tz = user.timezone ?? "UTC";
      const fromTag = `[FROM: ${user.displayName ?? user.slackUserId} | ${user.email ?? "no-email"} | ${tz}]`;
      const taggedText = `${fromTag} ${m.text}`;

      // Load persistent context for this user
      const persistentCtx = userContextService
        ? await userContextService.get(user.slackUserId).catch(() => ({} as Record<string, string>))
        : {};

      const reply = await agent.ask({
        user,
        channel: m.channel,
        threadTs: m.thread_ts ?? null,
        text: taggedText,
        persistentContext: persistentCtx,
      });

      // Parse and save any [PERSIST: key=value] tags from the reply
      const persistPairs = parsePersistTags(reply.text);
      if (persistPairs.length && userContextService) {
        await userContextService.setMany(user.slackUserId, persistPairs).catch(() => {});
      }
      const displayText = stripPersistTags(reply.text);

      let blocks: unknown[] | undefined;
      if (reply.pendingSend) {
        blocks = sendConfirmBlocks(reply.text, reply.pendingSend, user.slackUserId);
      } else if (reply.pendingInvite) {
        blocks = inviteConfirmBlocks(reply.text, reply.pendingInvite, user.slackUserId);
      } else if (reply.connectProviders?.length) {
        const buttons = connectButtonsFor(reply.connectProviders, user.slackUserId);
        if (buttons.length) {
          blocks = [
            { type: "section", text: { type: "mrkdwn", text: displayText } },
            { type: "actions", elements: buttons },
          ];
        }
      }
      await say({ text: displayText, thread_ts: m.thread_ts, blocks });
    } catch (err) {
      await say({
        text: `Sorry — something went wrong: ${err instanceof Error ? err.message : String(err)}`,
        thread_ts: m.thread_ts,
      });
    }
  }

  app.message(async ({ message, client, say }) => {
    const m = message as IncomingMessage;
    if (m.subtype || m.bot_id) return;
    if (m.channel_type !== "im") return;
    await handleConversational(m, client, (args) => say(args as bolt.SayArguments));
  });

  app.event("app_mention", async ({ event, client, say }) => {
    const m: IncomingMessage = {
      text: (event as { text?: string }).text,
      user: (event as { user?: string }).user,
      channel: (event as { channel: string }).channel,
      thread_ts: (event as { thread_ts?: string }).thread_ts,
    };
    await handleConversational(m, client, (args) => say(args as bolt.SayArguments));
  });

  app.command("/metrics", async ({ ack, respond }) => {
    await ack();
    const metrics = await api.getPipelineMetrics();
    const last = (await api.lastSyncInfo())?.finishedAt ?? null;
    await respond({ response_type: "ephemeral", text: formatMetrics(metrics, last) });
  });

  app.command("/stale", async ({ ack, respond }) => {
    await ack();
    const stale = await api.getStaleCandidates();
    await respond({ response_type: "ephemeral", text: formatStale(stale, config.staleAfterDays) });
  });

  return app;
}
