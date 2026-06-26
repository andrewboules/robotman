/**
 * GRANOLA OAUTH (PKCE + Dynamic Client Registration)
 * ---------------------------------------------------
 * Granola MCP uses OAuth 2.0 with PKCE and Dynamic Client Registration (DCR).
 * There is no static client_id / client_secret to configure — the server issues
 * one automatically when we POST to its registration endpoint.
 *
 * Flow per user:
 *   1. Discover endpoints via /.well-known/oauth-authorization-server on the MCP host.
 *   2. Register this app dynamically (once per server boot; client_id is cached in memory).
 *   3. Build an auth URL with PKCE (code_verifier / code_challenge).
 *   4. Redirect the user → they log in to Granola in their browser.
 *   5. Callback receives `code`; exchange for access_token + refresh_token.
 *   6. Store tokens encrypted under provider "granola" via CredentialService.
 *   7. Auto-refresh when access_token is within 60s of expiry.
 *
 * The encrypted `state` param binds the callback to the Slack user who started
 * the flow (CSRF protection, same pattern as Google OAuth).
 */
import { randomBytes, createHash } from "node:crypto";
import { config } from "../config.js";
import { encryptSecret, decryptSecret, type CredentialService } from "../identity/credentials.js";

const MCP_HOST = "https://mcp.granola.ai";
const PROVIDER = "granola";

// ---------------------------------------------------------------------------
// OAuth server metadata (discovered once, cached for the process lifetime)
// ---------------------------------------------------------------------------

interface OAuthServerMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

interface DynamicClient {
  client_id: string;
  client_secret?: string;
}

let _serverMeta: OAuthServerMeta | null = null;
let _dynamicClient: DynamicClient | null = null;

async function discoverMeta(): Promise<OAuthServerMeta> {
  if (_serverMeta) return _serverMeta;

  // Try MCP-specific discovery path first, then fall back to standard.
  const candidates = [
    `${MCP_HOST}/.well-known/oauth-authorization-server`,
    `${MCP_HOST}/.well-known/openid-configuration`,
  ];

  for (const url of candidates) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const meta = (await res.json()) as OAuthServerMeta;
      if (meta.authorization_endpoint && meta.token_endpoint) {
        _serverMeta = meta;
        return meta;
      }
    }
  }

  // Hard-coded fallback in case discovery isn't available.
  _serverMeta = {
    authorization_endpoint: "https://accounts.granola.ai/oauth/authorize",
    token_endpoint: "https://accounts.granola.ai/oauth/token",
    registration_endpoint: "https://accounts.granola.ai/oauth/register",
  };
  return _serverMeta;
}

/** Register this app with Granola dynamically (DCR — RFC 7591). */
async function registerClient(meta: OAuthServerMeta): Promise<DynamicClient> {
  if (_dynamicClient) return _dynamicClient;

  const regEndpoint = meta.registration_endpoint;
  if (!regEndpoint) {
    // If there's no registration endpoint, Granola may allow any redirect_uri
    // with a well-known public client_id. Use a sensible default.
    _dynamicClient = { client_id: "robotman" };
    return _dynamicClient;
  }

  const res = await fetch(regEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Robot Man",
      redirect_uris: [granolaRedirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // PKCE public client
    }),
  });

  if (!res.ok) {
    // Registration failed — fall back to a public client_id.
    console.warn("[granola-oauth] DCR failed, falling back to public client:", await res.text());
    _dynamicClient = { client_id: "robotman" };
    return _dynamicClient;
  }

  const data = (await res.json()) as DynamicClient;
  _dynamicClient = data;
  return _dynamicClient;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(
    Buffer.from(createHash("sha256").update(verifier).digest())
  );
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// State encoding (mirrors Google OAuth pattern)
// ---------------------------------------------------------------------------

export function encodeGranolaState(slackUserId: string, pkceVerifier: string): string {
  // Encode both the user ID and the PKCE verifier in the state so the callback
  // can retrieve the verifier without a server-side session store.
  return encryptSecret(JSON.stringify({ u: slackUserId, v: pkceVerifier }), config.credentialEncKey);
}

export function decodeGranolaState(state: string): { slackUserId: string; pkceVerifier: string } {
  const parsed = JSON.parse(decryptSecret(state, config.credentialEncKey)) as { u: string; v: string };
  return { slackUserId: parsed.u, pkceVerifier: parsed.v };
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

export function granolaRedirectUri(): string {
  return `${config.publicUrl.replace(/\/$/, "")}/oauth/granola/callback`;
}

export async function buildGranolaAuthUrl(slackUserId: string): Promise<{ url: string; state: string }> {
  const meta = await discoverMeta();
  const client = await registerClient(meta);
  const { verifier, challenge } = generatePKCE();
  const state = encodeGranolaState(slackUserId, verifier);

  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: granolaRedirectUri(),
    response_type: "code",
    scope: "mcp",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return { url: `${meta.authorization_endpoint}?${params.toString()}`, state };
}

// ---------------------------------------------------------------------------
// Token exchange & refresh
// ---------------------------------------------------------------------------

export interface GranolaTokenBundle {
  access_token: string;
  refresh_token?: string;
  expiry: number; // epoch ms
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function exchangeGranolaCode(
  code: string,
  pkceVerifier: string
): Promise<GranolaTokenBundle> {
  const meta = await discoverMeta();
  const client = await registerClient(meta);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: granolaRedirectUri(),
    client_id: client.client_id,
    code_verifier: pkceVerifier,
  });
  if (client.client_secret) body.set("client_secret", client.client_secret);

  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(`Granola token exchange failed: ${json.error ?? res.status} ${json.error_description ?? ""}`);
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expiry: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

export async function refreshGranolaTokens(prev: GranolaTokenBundle): Promise<GranolaTokenBundle> {
  if (!prev.refresh_token) throw new Error("No Granola refresh_token — user must reconnect.");
  const meta = await discoverMeta();
  const client = await registerClient(meta);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: prev.refresh_token,
    client_id: client.client_id,
  });
  if (client.client_secret) body.set("client_secret", client.client_secret);

  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(`Granola token refresh failed: ${json.error ?? res.status} ${json.error_description ?? ""}`);
  }
  // Granola uses refresh token rotation — always save the new refresh_token.
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? prev.refresh_token,
    expiry: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

// ---------------------------------------------------------------------------
// GranolaAuth class (mirrors GoogleAuth)
// ---------------------------------------------------------------------------

export class GranolaAuth {
  constructor(private credentials: CredentialService) {}

  async saveTokens(slackUserId: string, bundle: GranolaTokenBundle): Promise<void> {
    await this.credentials.set(slackUserId, PROVIDER, null, JSON.stringify(bundle));
  }

  async getBundle(slackUserId: string): Promise<GranolaTokenBundle | null> {
    const cred = await this.credentials.get(slackUserId, PROVIDER);
    if (!cred) return null;
    return JSON.parse(cred.secret) as GranolaTokenBundle;
  }

  /** Returns a valid access token, refreshing 60s before expiry. */
  async getAccessToken(slackUserId: string): Promise<string | null> {
    const bundle = await this.getBundle(slackUserId);
    if (!bundle) return null;
    if (bundle.expiry > Date.now() + 60_000) return bundle.access_token;
    const refreshed = await refreshGranolaTokens(bundle);
    await this.saveTokens(slackUserId, refreshed);
    return refreshed.access_token;
  }
}
