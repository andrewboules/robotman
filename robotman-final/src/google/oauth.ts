/**
 * GOOGLE OAUTH 2.0
 * ----------------
 * Per-user Google sign-in for Gmail / Calendar / Drive. Each recruiter clicks
 * "Connect Google", approves on Google's consent screen, and we store their
 * access + refresh tokens ENCRYPTED (reusing CredentialService, provider
 * "google"). Tokens auto-refresh when expired.
 *
 * The OAuth `state` is the recruiter's Slack user id, encrypted with
 * CREDENTIAL_ENC_KEY — so it's tamper-proof and binds the callback to the
 * person who started the flow (CSRF protection).
 *
 * NOTE on scopes: full Gmail/Calendar/Drive are Google "restricted" scopes.
 * They work immediately for accounts added as Test Users on the OAuth consent
 * screen; using them in production for everyone requires Google's verification.
 */
import { config } from "../config.js";
import { encryptSecret, decryptSecret, type CredentialService } from "../identity/credentials.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PROVIDER = "google";

export interface GoogleTokenBundle {
  access_token: string;
  refresh_token?: string;
  /** epoch ms when access_token expires */
  expiry: number;
  scope?: string;
}

export function redirectUri(): string {
  return `${config.publicUrl.replace(/\/$/, "")}/oauth/google/callback`;
}

/**
 * Encrypt the Slack user id into an opaque, tamper-proof state string. We do NOT
 * URL-encode here — callers always pass it through URLSearchParams (outbound) or
 * receive it via searchParams.get (inbound), both of which handle encoding. That
 * keeps encode/decode exact inverses.
 */
export function encodeState(slackUserId: string): string {
  return encryptSecret(slackUserId, config.credentialEncKey);
}

export function decodeState(state: string): string {
  return decryptSecret(state, config.credentialEncKey);
}

/** Build the consent URL. `state` is the raw (decrypted-form) state value. */
export function buildAuthUrlFromState(state: string): string {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: config.google.scopes,
    access_type: "offline", // get a refresh_token
    prompt: "consent", // ensure refresh_token is returned
    include_granted_scopes: "true",
    state, // URLSearchParams encodes it for the outbound URL
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export function buildAuthUrl(slackUserId: string): string {
  return buildAuthUrlFromState(encodeState(slackUserId));
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || json.error) {
    throw new Error(`Google token error: ${json.error ?? res.status} ${json.error_description ?? ""}`);
  }
  return json;
}

export function bundleFromResponse(r: GoogleTokenResponse, prev?: GoogleTokenBundle): GoogleTokenBundle {
  return {
    access_token: r.access_token,
    // Google omits refresh_token on refresh; keep the previous one.
    refresh_token: r.refresh_token ?? prev?.refresh_token,
    expiry: Date.now() + r.expires_in * 1000,
    scope: r.scope ?? prev?.scope,
  };
}

export async function exchangeCode(code: string): Promise<GoogleTokenBundle> {
  const r = await tokenRequest({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  return bundleFromResponse(r);
}

export async function refreshTokens(prev: GoogleTokenBundle): Promise<GoogleTokenBundle> {
  if (!prev.refresh_token) throw new Error("No refresh_token stored; user must reconnect Google.");
  const r = await tokenRequest({
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    refresh_token: prev.refresh_token,
    grant_type: "refresh_token",
  });
  return bundleFromResponse(r, prev);
}

/**
 * Resolves a valid Google access token for a user, refreshing + persisting if
 * the stored one is expired. Tokens live in the encrypted credential store as
 * JSON under provider "google".
 */
export class GoogleAuth {
  constructor(private credentials: CredentialService) {}

  async saveTokens(slackUserId: string, bundle: GoogleTokenBundle): Promise<void> {
    await this.credentials.set(slackUserId, PROVIDER, null, JSON.stringify(bundle));
  }

  async getBundle(slackUserId: string): Promise<GoogleTokenBundle | null> {
    const cred = await this.credentials.get(slackUserId, PROVIDER);
    if (!cred) return null;
    return JSON.parse(cred.secret) as GoogleTokenBundle;
  }

  /** Returns a valid access token, refreshing 60s before expiry. */
  async getAccessToken(slackUserId: string): Promise<string | null> {
    const bundle = await this.getBundle(slackUserId);
    if (!bundle) return null;
    if (bundle.expiry > Date.now() + 60_000) return bundle.access_token;
    const refreshed = await refreshTokens(bundle);
    await this.saveTokens(slackUserId, refreshed);
    return refreshed.access_token;
  }
}
