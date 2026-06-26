/**
 * GOOGLE OAUTH HTTP ROUTES
 * ------------------------
 * Mounted on the existing health server in index.ts:
 *   GET /oauth/google/start    → redirects the user to Google's consent screen
 *   GET /oauth/google/callback → exchanges the code, stores tokens, confirms
 *
 * `start` carries the Slack user id in an encrypted `state` param (built when
 * we render the Connect button), so the callback knows who to store tokens for.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildAuthUrlFromState, decodeState, exchangeCode, GoogleAuth } from "./oauth.js";

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <body style="font-family:system-ui;max-width:520px;margin:64px auto;text-align:center">${body}</body>`);
}

/** Returns true if it handled the request. */
export async function handleGoogleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  auth: GoogleAuth,
  onConnected?: (slackUserId: string) => Promise<void>
): Promise<boolean> {
  const url = new URL(req.url ?? "", "http://localhost");

  if (url.pathname === "/oauth/google/start") {
    const state = url.searchParams.get("state") ?? "";
    if (!state) {
      html(res, 400, "<h2>Missing state.</h2><p>Start the connection from Slack.</p>");
      return true;
    }
    res.writeHead(302, { Location: buildAuthUrlFromState(state) });
    res.end();
    return true;
  }

  if (url.pathname === "/oauth/google/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const err = url.searchParams.get("error");
    if (err) {
      html(res, 400, `<h2>Google declined the connection.</h2><p>${err}</p>`);
      return true;
    }
    if (!code || !state) {
      html(res, 400, "<h2>Missing code/state.</h2>");
      return true;
    }
    try {
      const slackUserId = decodeState(state);
      const bundle = await exchangeCode(code);
      await auth.saveTokens(slackUserId, bundle);
      if (onConnected) await onConnected(slackUserId).catch(() => {});
      html(res, 200, "<h2>✅ Google connected!</h2><p>You can close this tab and return to Slack.</p>");
    } catch (e) {
      html(res, 500, `<h2>Connection failed.</h2><p>${e instanceof Error ? e.message : String(e)}</p>`);
    }
    return true;
  }

  return false;
}
