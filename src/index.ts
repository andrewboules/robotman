/**
 * ENTRYPOINT
 * ----------
 * Boots the orchestration layer: connects + migrates the store, runs an initial
 * sync, starts the scheduler, serves /health + Google OAuth routes, and launches
 * the Slack app. Degrades gracefully with any subset of connectors configured,
 * and shuts down cleanly (disconnecting Slack) so redeploys don't drop requests.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { getRepository, closeStore } from "./store/repository.js";
import { syncAll } from "./sync.js";
import { startScheduler } from "./scheduler/index.js";
import { configuredAdapters } from "./adapters/index.js";
import { OrchestrationApi } from "./interface/api.js";
import { CredentialService } from "./identity/credentials.js";
import { GoogleAuth } from "./google/oauth.js";
import { handleGoogleRoutes } from "./google/routes.js";

// Held for graceful shutdown.
let slackApp: { stop: () => Promise<unknown> } | null = null;

function startServer(
  googleAuth: GoogleAuth | null,
  onConnected?: (slackUserId: string) => Promise<void>
): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
      return;
    }
    if (googleAuth && req.url?.startsWith("/oauth/google/")) {
      const handled = await handleGoogleRoutes(req, res, googleAuth, onConnected);
      if (handled) return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(config.port, () => console.log(`[boot] http server on :${config.port}`));
}

async function main(): Promise<void> {
  console.log("[boot] orchestration layer starting");
  const repo = await getRepository(); // connect + migrate
  console.log(`[boot] store ready (${config.databaseUrl ? "postgres" : "sqlite"})`);

  const credentials = new CredentialService(repo, config.credentialEncKey);
  const googleAuth = config.google.configured && credentials.enabled ? new GoogleAuth(credentials) : null;
  console.log(
    `[boot] connections: ${credentials.enabled ? "enabled (/connect)" : "disabled (set CREDENTIAL_ENC_KEY)"}` +
      `; google oauth: ${googleAuth ? "enabled" : "disabled"}`
  );
  if (googleAuth && !config.publicUrl) {
    console.warn("[boot] WARNING: Google is configured but PUBLIC_URL/RENDER_EXTERNAL_URL is unset — the OAuth callback will fail. Set PUBLIC_URL.");
  }

  const active = configuredAdapters().map((a) => a.source);
  console.log(`[boot] org-key connectors: ${active.length ? active.join(", ") : "none"}`);
  if (active.length > 0) {
    console.log("[boot] running initial sync…");
    for (const r of await syncAll()) {
      console.log(`[boot] ${r.source}: ${r.ok ? `${r.upserted} upserted` : `ERROR ${r.error}`}`);
    }
    startScheduler();
  }

  let onConnected: ((slackUserId: string) => Promise<void>) | undefined;

  if (config.slack.configured) {
    const { createSlackApp } = await import("./slack/app.js");
    const api = await OrchestrationApi.create();

    let agent;
    if (config.anthropic.configured) {
      const { Agent } = await import("./agent/index.js");
      agent = await Agent.create(credentials);
      console.log("[boot] agent enabled (conversational DMs + @mentions)");
    } else {
      console.log("[boot] ANTHROPIC_API_KEY not set — slash commands only.");
    }

    const app = createSlackApp(api, agent, credentials, googleAuth);
    slackApp = app;
    // DM the user when their Google connection completes.
    onConnected = async (slackUserId) => {
      await app.client.chat.postMessage({
        channel: slackUserId,
        text: "✅ Google connected! You can now ask me to find emails, check your calendar, or draft an email.",
      });
    };
    await app.start();
    console.log("[boot] ⚡ Slack app running (Socket Mode). DM the bot or try /metrics");
  } else {
    console.log("[boot] Slack not configured — set SLACK_BOT_TOKEN + SLACK_APP_TOKEN.");
  }

  startServer(googleAuth, onConnected);
  console.log("[boot] ready");
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal} received — disconnecting Slack + closing store…`);
  if (slackApp) await slackApp.stop().catch(() => {});
  await closeStore().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
