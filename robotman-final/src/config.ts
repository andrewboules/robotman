/**
 * AUTH & SECRETS / CONFIG
 * -----------------------
 * Single place that reads environment variables. In production this is where
 * you'd plug a real secrets manager (Vault, AWS Secrets Manager, Doppler) and
 * per-source OAuth token refresh. For the slice we read from process.env / .env.
 */
import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  /** If set (production), use Postgres. If empty, fall back to SQLite. */
  databaseUrl: optional("DATABASE_URL"),
  /** SQLite file used only when DATABASE_URL is not set. */
  databaseFile: optional("DATABASE_FILE", "data/orchestration.db"),

  ashby: {
    /** Ashby uses HTTP Basic auth: API key as username, blank password. */
    apiKey: optional("ASHBY_API_KEY"),
    baseUrl: optional("ASHBY_BASE_URL", "https://api.ashbyhq.com"),
    get configured(): boolean {
      return Boolean(process.env.ASHBY_API_KEY);
    },
  },

  gem: {
    /** Gem is fronted by AWS API Gateway; auth via `x-api-key` header. */
    apiKey: optional("GEM_API_KEY"),
    baseUrl: optional("GEM_BASE_URL", "https://api.gem.com"),
    get configured(): boolean {
      return Boolean(process.env.GEM_API_KEY);
    },
  },

  slack: {
    botToken: optional("SLACK_BOT_TOKEN"),
    signingSecret: optional("SLACK_SIGNING_SECRET"),
    appToken: optional("SLACK_APP_TOKEN"), // for Socket Mode
    /** OAuth 2.0 credentials — required for the "Connect with Slack" workspace flow. */
    clientId: optional("SLACK_CLIENT_ID"),
    clientSecret: optional("SLACK_CLIENT_SECRET"),
    get configured(): boolean {
      return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
    },
    get oauthConfigured(): boolean {
      return Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
    },
  },

  anthropic: {
    apiKey: optional("ANTHROPIC_API_KEY"),
    /** Model used for the agent loop. */
    model: optional("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
    maxTokens: Number(optional("ANTHROPIC_MAX_TOKENS", "2048")),
    /** Safety cap on tool-call rounds per user message (room to explore APIs). */
    maxToolRounds: Number(optional("AGENT_MAX_TOOL_ROUNDS", "10")),
    get configured(): boolean {
      return Boolean(process.env.ANTHROPIC_API_KEY);
    },
  },

  /** Public base URLs used to build citation links back to each source. */
  links: {
    ashbyApp: optional("ASHBY_APP_URL", "https://app.ashbyhq.com"),
    gemApp: optional("GEM_APP_URL", "https://www.gem.com"),
  },

  /** Key used to encrypt per-user credentials at rest. Required for /connect. */
  credentialEncKey: optional("CREDENTIAL_ENC_KEY"),

  /** Public base URL of this service (Render injects RENDER_EXTERNAL_URL). */
  publicUrl: optional("PUBLIC_URL", optional("RENDER_EXTERNAL_URL")),

  google: {
    clientId: optional("GOOGLE_CLIENT_ID"),
    clientSecret: optional("GOOGLE_CLIENT_SECRET"),
    /** Space-separated OAuth scopes. Default = full Gmail + Calendar + Drive. */
    scopes: optional(
      "GOOGLE_SCOPES",
      [
        "openid",
        "email",
        "profile",
        "https://mail.google.com/", // full Gmail: read, send, modify
        "https://www.googleapis.com/auth/calendar", // read + write
        "https://www.googleapis.com/auth/drive", // read + write
      ].join(" ")
    ),
    get configured(): boolean {
      return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    },
  },

  /**
   * Granola meeting-notes integration.
   * Optional org-wide API key: if set, all users share it.
   * If not set, each user connects via OAuth SSO (/oauth/granola/start).
   */
  granola: {
    apiKey: optional("GRANOLA_API_KEY"),
  },

  /**
   * Proactive notification settings (all optional).
   *   NOTIFY_STAGE_CHANNEL   — Slack channel ID or user ID to post stage-change
   *                            alerts. When empty, DMs the candidate's owner instead.
   *   NOTIFY_EMAIL_QUERY     — Gmail search query to watch (e.g. "from:vip@co.com is:unread").
   *   NOTIFY_EMAIL_TO        — Slack channel or user ID to DM when matching mail arrives.
   *   NOTIFY_EMAIL_SLACK_USER_ID — Slack user ID whose connected Gmail account to poll.
   */
  notifications: {
    stageChannel: optional("NOTIFY_STAGE_CHANNEL"),
    emailQuery: optional("NOTIFY_EMAIL_QUERY"),
    emailTo: optional("NOTIFY_EMAIL_TO"),
    emailSlackUserId: optional("NOTIFY_EMAIL_SLACK_USER_ID"),
  },

  /** Cron schedule for the background sync. Default: every 15 minutes. */
  syncCron: optional("SYNC_CRON", "*/15 * * * *"),

  /** A candidate in an active stage with no activity for this many days is "stale". */
  staleAfterDays: Number(optional("STALE_AFTER_DAYS", "7")),

  port: Number(optional("PORT", "3000")),
};

export { required };
