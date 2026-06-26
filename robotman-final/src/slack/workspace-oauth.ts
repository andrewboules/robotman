/**
 * SLACK WORKSPACE OAUTH 2.0
 * -------------------------
 * Implements the Slack OAuth V2 install flow so users can connect a Slack
 * workspace by clicking "Connect with Slack" instead of pasting a bot token.
 *
 * Flow:
 *   1. /oauth/slack/start  → redirects to https://slack.com/oauth/v2/authorize
 *   2. Slack redirects to /oauth/slack/callback with a code
 *   3. We exchange the code for a bot access token via oauth.v2.access
 *   4. The bot token is stored encrypted in CredentialService under "slack-workspace"
 *   5. A DM confirms the connection to the user
 *
 * The stored token can then be used to:
 *   - Look up users (users.info / users.list) in the connected workspace
 *   - Send DMs (chat.postMessage + conversations.open) in that workspace
 *
 * User ID resolution is cached in memory per token so lookups are fast after
 * the first call.
 *
 * Required env vars:
 *   SLACK_CLIENT_ID      — from api.slack.com/apps → Basic Information
 *   SLACK_CLIENT_SECRET  — from api.slack.com/apps → Basic Information
 *
 * Redirect URI to register in your Slack app:
 *   <PUBLIC_URL>/oauth/slack/callback
 */
import { config } from "../config.js";
import { encryptSecret, decryptSecret, type CredentialService } from "../identity/credentials.js";

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_USERS_LIST_URL = "https://slack.com/api/users.list";
const SLACK_USERS_INFO_URL = "https://slack.com/api/users.info";
const SLACK_IM_OPEN_URL = "https://slack.com/api/conversations.open";
const SLACK_CHAT_POST_URL = "https://slack.com/api/chat.postMessage";

export const SLACK_PROVIDER = "slack-workspace";

/** Scopes requested when installing the bot into a workspace. */
export const SLACK_SCOPES = [
  "users:read",
  "users:read.email",
  "chat:write",
  "im:write",
].join(",");

// ---------------------------------------------------------------------------
// State helpers (CSRF protection — same pattern as Google/Granola)
// ---------------------------------------------------------------------------

export function encodeSlackState(slackUserId: string): string {
  return encryptSecret(slackUserId, config.credentialEncKey);
}

export function decodeSlackState(state: string): string {
  return decryptSecret(state, config.credentialEncKey);
}

export function slackRedirectUri(): string {
  return `${config.publicUrl.replace(/\/$/, "")}/oauth/slack/callback`;
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export function buildSlackAuthUrl(slackUserId: string): string {
  const state = encodeSlackState(slackUserId);
  const params = new URLSearchParams({
    client_id: config.slack.clientId,
    scope: SLACK_SCOPES,
    redirect_uri: slackRedirectUri(),
    state,
  });
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export interface SlackTokenBundle {
  /** Bot token (xoxb-...) for the connected workspace. */
  botToken: string;
  /** Team name for display. */
  teamName: string;
  /** Team ID. */
  teamId: string;
  /** Bot's own user ID in the workspace. */
  botUserId: string;
}

interface OAuthV2Response {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  team?: { id: string; name: string };
}

export async function exchangeSlackCode(code: string): Promise<SlackTokenBundle> {
  const body = new URLSearchParams({
    code,
    client_id: config.slack.clientId,
    client_secret: config.slack.clientSecret,
    redirect_uri: slackRedirectUri(),
  });

  const res = await fetch(SLACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });

  const json = (await res.json()) as OAuthV2Response;
  if (!json.ok || !json.access_token) {
    throw new Error(`Slack OAuth failed: ${json.error ?? "unknown error"}`);
  }

  return {
    botToken: json.access_token,
    teamName: json.team?.name ?? "Unknown workspace",
    teamId: json.team?.id ?? "",
    botUserId: json.bot_user_id ?? "",
  };
}

// ---------------------------------------------------------------------------
// User ID resolution cache
// ---------------------------------------------------------------------------

/** Cached user record resolved from a connected workspace. */
export interface SlackWorkspaceUser {
  id: string;
  name: string;
  realName: string;
  email: string | null;
  displayName: string;
}

/**
 * Per-token user cache.
 * Key: botToken, Value: Map<userId, SlackWorkspaceUser>
 */
const _userCache = new Map<string, Map<string, SlackWorkspaceUser>>();

function getCacheForToken(token: string): Map<string, SlackWorkspaceUser> {
  if (!_userCache.has(token)) _userCache.set(token, new Map());
  return _userCache.get(token)!;
}

interface SlackUserProfile {
  real_name?: string;
  display_name?: string;
  email?: string;
}

interface SlackUserObject {
  id: string;
  name: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: SlackUserProfile;
}

function userFromSlackObject(u: SlackUserObject): SlackWorkspaceUser {
  return {
    id: u.id,
    name: u.name,
    realName: u.profile?.real_name ?? u.name,
    email: u.profile?.email ?? null,
    displayName: u.profile?.display_name ?? u.name,
  };
}

/**
 * Resolve a user ID to a full user record, using the cache.
 * Falls back to users.info if the user isn't in cache yet.
 */
export async function resolveUserId(
  botToken: string,
  userId: string
): Promise<SlackWorkspaceUser | null> {
  const cache = getCacheForToken(botToken);
  if (cache.has(userId)) return cache.get(userId)!;

  const res = await fetch(`${SLACK_USERS_INFO_URL}?user=${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${botToken}`, Accept: "application/json" },
  });
  const json = (await res.json()) as { ok: boolean; user?: SlackUserObject };
  if (!json.ok || !json.user) return null;

  const user = userFromSlackObject(json.user);
  cache.set(userId, user);
  return user;
}

/**
 * Search the workspace user list by email address or display name/real name.
 * Fetches + caches the full user list on first call per token.
 */
export async function findWorkspaceUser(
  botToken: string,
  query: string
): Promise<SlackWorkspaceUser | null> {
  const cache = getCacheForToken(botToken);

  // Populate cache from full list if it's empty (first call for this token).
  if (cache.size === 0) {
    await _populateUserCache(botToken, cache);
  }

  const q = query.toLowerCase().trim();
  for (const u of cache.values()) {
    if (
      u.email?.toLowerCase() === q ||
      u.realName.toLowerCase() === q ||
      u.displayName.toLowerCase() === q ||
      u.name.toLowerCase() === q
    ) {
      return u;
    }
  }

  // Fuzzy second pass — partial name match.
  for (const u of cache.values()) {
    if (
      u.realName.toLowerCase().includes(q) ||
      u.displayName.toLowerCase().includes(q)
    ) {
      return u;
    }
  }

  return null;
}

async function _populateUserCache(
  botToken: string,
  cache: Map<string, SlackWorkspaceUser>
): Promise<void> {
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ limit: "200" });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`${SLACK_USERS_LIST_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${botToken}`, Accept: "application/json" },
    });
    const json = (await res.json()) as {
      ok: boolean;
      members?: SlackUserObject[];
      response_metadata?: { next_cursor?: string };
    };
    if (!json.ok) break;

    for (const member of json.members ?? []) {
      if (!member.deleted && !member.is_bot) {
        cache.set(member.id, userFromSlackObject(member));
      }
    }
    cursor = json.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

// ---------------------------------------------------------------------------
// DM sending via connected workspace token
// ---------------------------------------------------------------------------

/**
 * Send a direct message in the connected workspace.
 * Opens a DM channel if needed, then posts the message.
 */
export async function sendWorkspaceDm(
  botToken: string,
  toUserId: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  // Open (or retrieve) the DM channel.
  const openRes = await fetch(SLACK_IM_OPEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
    },
    body: JSON.stringify({ users: toUserId }),
  });
  const openJson = (await openRes.json()) as { ok: boolean; channel?: { id: string }; error?: string };
  if (!openJson.ok || !openJson.channel?.id) {
    return { ok: false, error: `conversations.open failed: ${openJson.error ?? "unknown"}` };
  }

  // Post the message.
  const postRes = await fetch(SLACK_CHAT_POST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
    },
    body: JSON.stringify({ channel: openJson.channel.id, text, unfurl_links: false }),
  });
  const postJson = (await postRes.json()) as { ok: boolean; error?: string };
  return { ok: postJson.ok, error: postJson.error };
}

// ---------------------------------------------------------------------------
// SlackWorkspaceAuth class (mirrors GoogleAuth / GranolaAuth)
// ---------------------------------------------------------------------------

export class SlackWorkspaceAuth {
  constructor(private credentials: CredentialService) {}

  async saveBundle(slackUserId: string, bundle: SlackTokenBundle): Promise<void> {
    // Store the whole bundle as JSON; baseUrl holds the team name for display.
    await this.credentials.set(slackUserId, SLACK_PROVIDER, bundle.teamName, JSON.stringify(bundle));
  }

  async getBundle(slackUserId: string): Promise<SlackTokenBundle | null> {
    const cred = await this.credentials.get(slackUserId, SLACK_PROVIDER);
    if (!cred) return null;
    return JSON.parse(cred.secret) as SlackTokenBundle;
  }

  async getBotToken(slackUserId: string): Promise<string | null> {
    const bundle = await this.getBundle(slackUserId);
    return bundle?.botToken ?? null;
  }

  /** Returns the connected workspace name for the user, or null. */
  async getWorkspaceName(slackUserId: string): Promise<string | null> {
    const bundle = await this.getBundle(slackUserId);
    return bundle?.teamName ?? null;
  }
}
