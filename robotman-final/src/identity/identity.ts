/**
 * IDENTITY & PERMISSIONS FRAMEWORK
 * --------------------------------
 * Every agent request runs as a specific user (`AppUser`). For v1 the two read
 * sources (Ashby, Gem) authenticate with org-level API keys — those APIs have
 * no per-user OAuth — so we scope results by the requesting user where the data
 * model allows (e.g. owner/recruiter email), rather than by credential.
 *
 * The `TokenStore` is where per-user OAuth tokens (Google, Slack user tokens)
 * will live. It's defined now so Gmail/Drive/Calendar tools added later become a
 * drop-in: resolve the AppUser, pull their token, call the API as them. The v1
 * implementation is in-memory; swap for an encrypted Postgres/secrets-backed
 * store before shipping per-user Google access.
 */

export interface AppUser {
  /** Slack user id (e.g. U12345). The stable handle we key everything on. */
  slackUserId: string;
  email: string | null;
  /** Full display name / real_name from Slack profile. */
  displayName: string | null;
  /** First name from Slack profile (for natural greeting). */
  firstName: string | null;
  /** IANA timezone string from Slack profile (e.g. "America/Los_Angeles"). */
  timezone: string | null;
  /** UTC offset in seconds (e.g. -25200 for PT). */
  tzOffset: number | null;
}

export type OAuthProvider = "google" | "slack_user";

export interface OAuthToken {
  provider: OAuthProvider;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null; // ISO
  scopes: string[];
}

export interface TokenStore {
  get(slackUserId: string, provider: OAuthProvider): Promise<OAuthToken | null>;
  put(slackUserId: string, token: OAuthToken): Promise<void>;
}

/**
 * In-memory token store for v1. Tokens do not persist across restarts.
 * TODO(prod): back this with encrypted Postgres rows or a secrets manager
 * before enabling per-user Google OAuth.
 */
export class InMemoryTokenStore implements TokenStore {
  private map = new Map<string, OAuthToken>();
  private key(u: string, p: OAuthProvider) {
    return `${u}:${p}`;
  }
  async get(slackUserId: string, provider: OAuthProvider): Promise<OAuthToken | null> {
    return this.map.get(this.key(slackUserId, provider)) ?? null;
  }
  async put(slackUserId: string, token: OAuthToken): Promise<void> {
    this.map.set(this.key(slackUserId, token.provider), token);
  }
}

/**
 * Resolves a Slack user into an AppUser. In v1 the Slack handler passes the
 * profile email (from users.info); later this can enrich from a directory.
 */
export class IdentityResolver {
  resolve(
    slackUserId: string,
    email?: string | null,
    displayName?: string | null,
    timezone?: string | null,
    firstName?: string | null,
    tzOffset?: number | null
  ): AppUser {
    return {
      slackUserId,
      email: email ?? null,
      displayName: displayName ?? null,
      firstName: firstName ?? null,
      timezone: timezone ?? null,
      tzOffset: tzOffset ?? null,
    };
  }
}
