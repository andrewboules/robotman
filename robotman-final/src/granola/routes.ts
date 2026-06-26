/**
 * GRANOLA OAUTH HTTP ROUTES
 * -------------------------
 * Mounted on the health server in index.ts:
 *   GET /oauth/granola/start    → decodes pre-encoded state, builds Granola auth URL, redirects
 *   GET /oauth/granola/callback → exchanges code for tokens, stores them, sends Slack DM
 *
 * The `state` param arriving at /start is the encrypted blob from slack/app.ts, which
 * already contains both the Slack user id and the PKCE verifier. We decode it here to
 * reconstruct the correct code_challenge before redirecting to Granola's auth endpoint.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import {
  decodeGranolaState,
  exchangeGranolaCode,
  buildGranolaAuthUrl,
  GranolaAuth,
} from "./oauth.js";

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <body style="font-family:system-ui;max-width:520px;margin:64px auto;text-align:center">${body}</body>`);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Returns true if it handled the request. */
export async function handleGranolaRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  auth: GranolaAuth,
  onConnected?: (slackUserId: string) => Promise<void>
): Promise<boolean> {
  const url = new URL(req.url ?? "", "http://localhost");

  if (url.pathname === "/oauth/granola/start") {
    const state = url.searchParams.get("state") ?? "";
    if (!state) {
      html(res, 400, "<h2>Missing state.</h2><p>Start the connection from Slack.</p>");
      return true;
    }
    try {
      // Decode the state to get the PKCE verifier so we can compute the challenge.
      const { pkceVerifier } = decodeGranolaState(state);
      const challenge = pkceChallenge(pkceVerifier);

      // Build a base auth URL (which generates its own verifier/challenge internally —
      // we'll overwrite them with ours). We only need the base URL + client_id.
      const { url: baseUrl } = await buildGranolaAuthUrl("__ignored__");
      const authUrl = new URL(baseUrl);

      // Overwrite the auto-generated values with our pre-encoded ones.
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      res.writeHead(302, { Location: authUrl.toString() });
      res.end();
    } catch (e) {
      html(res, 500, `<h2>Failed to start Granola login.</h2><p>${e instanceof Error ? e.message : String(e)}</p>`);
    }
    return true;
  }

  if (url.pathname === "/oauth/granola/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const err = url.searchParams.get("error");

    if (err) {
      html(res, 400, `<h2>Granola declined the connection.</h2><p>${err}</p>`);
      return true;
    }
    if (!code || !state) {
      html(res, 400, "<h2>Missing code or state.</h2>");
      return true;
    }

    try {
      const { slackUserId, pkceVerifier } = decodeGranolaState(state);
      const bundle = await exchangeGranolaCode(code, pkceVerifier);
      await auth.saveTokens(slackUserId, bundle);
      if (onConnected) await onConnected(slackUserId).catch(() => {});
      html(res, 200, "<h2>✅ Granola connected!</h2><p>You can close this tab and return to Slack.</p>");
    } catch (e) {
      html(res, 500, `<h2>Connection failed.</h2><p>${e instanceof Error ? e.message : String(e)}</p>`);
    }
    return true;
  }

  return false;
}
