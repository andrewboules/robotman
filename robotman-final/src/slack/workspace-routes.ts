/**
 * SLACK WORKSPACE OAUTH ROUTES
 * ----------------------------
 * Mounted on the health server in index.ts:
 *
 *   GET /oauth/slack/start
 *     Builds the Slack OAuth V2 authorization URL and redirects the user's
 *     browser there. Expects `?state=<encrypted_slack_user_id>`.
 *
 *   GET /oauth/slack/callback
 *     Receives the authorization code from Slack, exchanges it for a bot
 *     access token, stores it encrypted, then sends a confirmation DM.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildSlackAuthUrl,
  decodeSlackState,
  exchangeSlackCode,
  SlackWorkspaceAuth,
} from "./workspace-oauth.js";

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:system-ui;max-width:520px;margin:64px auto;text-align:center">${body}</body>`
  );
}

/** Returns true if it handled the request. */
export async function handleSlackWorkspaceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  auth: SlackWorkspaceAuth,
  onConnected?: (slackUserId: string, teamName: string) => Promise<void>
): Promise<boolean> {
  const url = new URL(req.url ?? "", "http://localhost");

  // ── /oauth/slack/start ────────────────────────────────────────────────────
  if (url.pathname === "/oauth/slack/start") {
    const state = url.searchParams.get("state") ?? "";
    if (!state) {
      html(res, 400, "<h2>Missing state.</h2><p>Start the connection from Slack.</p>");
      return true;
    }
    try {
      // Decode to verify the state is valid before redirecting.
      const slackUserId = decodeSlackState(state);
      if (!slackUserId) throw new Error("Empty user ID in state.");

      // Build the auth URL with the pre-encoded state so the callback can
      // identify the user without a server-side session store.
      const authUrl = buildSlackAuthUrl(slackUserId);
      // Replace the auto-generated state with our pre-encoded one.
      const authUrlObj = new URL(authUrl);
      authUrlObj.searchParams.set("state", state);

      res.writeHead(302, { Location: authUrlObj.toString() });
      res.end();
    } catch (e) {
      html(
        res,
        500,
        `<h2>Failed to start Slack login.</h2><p>${e instanceof Error ? e.message : String(e)}</p>`
      );
    }
    return true;
  }

  // ── /oauth/slack/callback ─────────────────────────────────────────────────
  if (url.pathname === "/oauth/slack/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const err = url.searchParams.get("error");

    if (err) {
      html(res, 400, `<h2>Slack declined the connection.</h2><p>${err}</p>`);
      return true;
    }
    if (!code || !state) {
      html(res, 400, "<h2>Missing code or state.</h2><p>Try reconnecting from Slack.</p>");
      return true;
    }

    try {
      const slackUserId = decodeSlackState(state);
      const bundle = await exchangeSlackCode(code);
      await auth.saveBundle(slackUserId, bundle);
      if (onConnected) await onConnected(slackUserId, bundle.teamName).catch(() => {});

      html(
        res,
        200,
        `<h2>✅ Slack workspace connected!</h2>` +
          `<p>Workspace: <strong>${bundle.teamName}</strong></p>` +
          `<p>You can close this tab and return to Slack.</p>`
      );
    } catch (e) {
      html(
        res,
        500,
        `<h2>Connection failed.</h2><p>${e instanceof Error ? e.message : String(e)}</p>`
      );
    }
    return true;
  }

  return false;
}
