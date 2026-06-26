/**
 * NOTIFICATIONS SERVICE
 * ---------------------
 * Sends proactive Slack DMs when key events are detected:
 *
 *   1. Pipeline stage changes — fired after each Ashby/Gem sync when a
 *      candidate moves from one stage to another. Posts to NOTIFY_STAGE_CHANNEL
 *      if set, otherwise DMs the candidate's assigned recruiter (owner).
 *
 *   2. Email arrival — polls the connected Gmail account of
 *      NOTIFY_EMAIL_SLACK_USER_ID for messages matching NOTIFY_EMAIL_QUERY,
 *      then DMs NOTIFY_EMAIL_TO when something new arrives.
 *
 * Configuration (all optional env vars — notifications are silently disabled
 * when variables are absent):
 *   NOTIFY_STAGE_CHANNEL      Slack channel/user to post stage alerts (DMs owner if unset)
 *   NOTIFY_EMAIL_QUERY        Gmail query, e.g. "from:ceo@example.com is:unread"
 *   NOTIFY_EMAIL_TO           Slack channel/user to DM on new matching email
 *   NOTIFY_EMAIL_SLACK_USER_ID  Slack user ID whose Google account to poll
 *
 * Call `initNotifications(client, googleAuth)` once after Slack starts.
 */
import type { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import type { StageChange } from "../sync.js";
import { googleApiGet } from "../google/gmail.js";
import type { GoogleAuth } from "../google/oauth.js";

let _client: WebClient | null = null;
let _googleAuth: GoogleAuth | null = null;

/** Initialise with the live Slack WebClient (and optionally GoogleAuth for email polling). */
export function initNotifications(client: WebClient, googleAuth: GoogleAuth | null): void {
  _client = client;
  _googleAuth = googleAuth;
}

// ---------------------------------------------------------------------------
// Stage-change notifications
// ---------------------------------------------------------------------------

/** Resolve a Slack user ID from an email address (cached per process). */
const _emailCache = new Map<string, string | null>();
async function emailToSlackId(email: string): Promise<string | null> {
  if (_emailCache.has(email)) return _emailCache.get(email)!;
  try {
    const res = await _client!.users.lookupByEmail({ email });
    const id = res.user?.id ?? null;
    _emailCache.set(email, id);
    return id;
  } catch {
    _emailCache.set(email, null);
    return null;
  }
}

/**
 * Post a DM (or channel message) for every stage change detected in the latest sync.
 * Fires only when Slack is initialised — silently no-ops otherwise.
 */
export async function notifyStageChanges(changes: StageChange[]): Promise<void> {
  if (!_client || changes.length === 0) return;

  for (const { candidate, fromStage, toStage } of changes) {
    const targetOverride = config.notifications.stageChannel;
    const roleStr = candidate.role ? ` _(${candidate.role})_` : "";
    const ownerStr = candidate.ownerEmail ? `\n_Owner: ${candidate.ownerEmail}_` : "";

    const text =
      `📋 *Stage update:* *${candidate.name}* moved from *${fromStage}* → *${toStage}*${roleStr}${ownerStr}`;

    // Determine where to send.
    let channel: string | null = targetOverride || null;
    if (!channel && candidate.ownerEmail) {
      channel = await emailToSlackId(candidate.ownerEmail);
    }
    if (!channel) continue;

    try {
      await _client.chat.postMessage({ channel, text, unfurl_links: false });
    } catch (err) {
      console.error(
        `[notifications] stage DM failed for ${candidate.name}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Email arrival notifications
// ---------------------------------------------------------------------------

/** Track the most-recently seen message ID to avoid re-notifying. */
let _lastEmailId: string | null = null;

/**
 * Poll the connected Gmail account of NOTIFY_EMAIL_SLACK_USER_ID for new
 * messages matching NOTIFY_EMAIL_QUERY. DMs NOTIFY_EMAIL_TO when new mail
 * arrives. Called by the scheduler on each sync cycle.
 */
export async function pollAndNotifyEmail(): Promise<void> {
  const { emailQuery, emailTo, emailSlackUserId } = config.notifications;
  if (!_client || !_googleAuth || !emailQuery || !emailTo || !emailSlackUserId) return;

  try {
    const token = await _googleAuth.getAccessToken(emailSlackUserId);
    if (!token) return; // user hasn't connected Google

    // List messages matching the query.
    const listRes = await googleApiGet(
      token,
      `/gmail/v1/users/me/messages?q=${encodeURIComponent(emailQuery)}&maxResults=5`
    );
    if (listRes.status !== 200) return;

    let listData: { messages?: { id: string }[] };
    try {
      listData = JSON.parse(listRes.body) as { messages?: { id: string }[] };
    } catch {
      return;
    }
    const msgs = listData.messages ?? [];
    if (msgs.length === 0) return;

    const newest = msgs[0].id;
    if (newest === _lastEmailId) return; // already notified
    _lastEmailId = newest;

    // Fetch message detail for a useful preview.
    const msgRes = await googleApiGet(
      token,
      `/gmail/v1/users/me/messages/${newest}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`
    );
    if (msgRes.status !== 200) return;

    let msgData: {
      snippet?: string;
      payload?: { headers?: { name: string; value: string }[] };
    };
    try {
      msgData = JSON.parse(msgRes.body) as typeof msgData;
    } catch {
      return;
    }

    const header = (name: string) =>
      msgData.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

    const subject = header("Subject") || "(no subject)";
    const from = header("From") || "(unknown sender)";
    const snippet = (msgData.snippet ?? "").slice(0, 200);

    const text =
      `📧 *New email alert* (matched: \`${emailQuery}\`)\n` +
      `*From:* ${from}\n` +
      `*Subject:* ${subject}\n` +
      `${snippet}`;

    await _client.chat.postMessage({ channel: emailTo, text, unfurl_links: false });
  } catch (err) {
    console.error("[notifications] email poll failed:", err instanceof Error ? err.message : err);
  }
}
