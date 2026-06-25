/**
 * ENTRYPOINT
 * ----------
 * Boots the orchestration layer: connects + migrates the store, runs an initial
 * sync, starts the scheduler, serves /health + OAuth routes (Google + Granola),
 * and launches the Slack app. Degrades gracefully with any subset of connectors
 * configured, and shuts down cleanly on SIGTERM/SIGINT.
 *
 * Circular-dep resolution: the Slack app is created first (so we can capture
 * app.client for the agent's slack_send_dm tool), then the agent is created
 * with that client and wired back in via the `agentRef` getter closure.
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
import { GranolaAuth } from "./granola/oauth.js";
import { handleGoogleRoutes } from "./google/routes.js";
import { handleGranolaRoutes } from "./granola/routes.js";
import { initNotifications } from "./slack/notifications.js";

// Held for graceful shutdown.
let slackApp: { stop: () => Promise<unknown> } | null = null;

function startServer(
  googleAuth: GoogleAuth | null,
  granolaAuth: GranolaAuth | null,
  onGoogleConnected?: (slackUserId: string) => Promise<void>,
  onGranolaConnected?: (slackUserId: string) => Promise<void>
): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
      return;
    }
    if (googleAuth && req.url?.startsWith("/oauth/google/")) {
      const handled = await handleGoogleRoutes(req, res, googleAuth, onGoogleConnected);
      if (handled) return;
    }
    if (granolaAuth && req.url?.startsWith("/oauth/granola/")) {
      const handled = await handleGranolaRoutes(req, res, granolaAuth, onGranolaConnected);
      if (handled) return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(config.port, () => console.log(`[boot] http server on :${config.port}`));
}

async function main(): Promise<void> {
  console.log("[boot] orchestration layer starting");
  const repo = await getRepository();
  console.log(`[boot] store ready (${config.databaseUrl ? "postgres" : "sqlite"})`);

  const credentials = new CredentialService(repo, config.credentialEncKey);
  const googleAuth = config.google.configured && credentials.enabled ? new GoogleAuth(credentials) : null;
  const granolaAuth = credentials.enabled ? new GranolaAuth(credentials) : null;

  console.log(
    `[boot] connections: ${credentials.enabled ? "enabled (/connect)" : "disabled (set CREDENTIAL_ENC_KEY)"}` +
      `; google oauth: ${googleAuth ? "enabled" : "disabled"}` +
      `; granola oauth: ${granolaAuth ? "enabled" : "disabled"}`
  );
  if ((googleAuth || granolaAuth) && !config.publicUrl) {
    console.warn(
      "[boot] WARNING: OAuth is configured but PUBLIC_URL/RENDER_EXTERNAL_URL is unset — " +
        "OAuth callbacks will fail. Set PUBLIC_URL."
    );
  }

  const active = configuredAdapters().map((a) => a.source);
  console.log(`[boot] org-key connectors: ${active.length ? active.join(", ") : "none"}`);
  if (active.length > 0) {
    console.log("[boot] running initial sync…");
    for (const r of await syncAll()) {
      console.log(`[boot] ${r.source}: ${r.ok ? `${r.upserted} upserted` : `ERROR ${r.error}`}`);
    }
  }

  let onGoogleConnected: ((slackUserId: string) => Promise<void>) | undefined;
  let onGranolaConnected: ((slackUserId: string) => Promise<void>) | undefined;

  if (config.slack.configured) {
    const { createSlackApp } = await import("./slack/app.js");
    const api = await OrchestrationApi.create();

    // Circular-dep pattern: the Slack message handler closes over `getAgent` so
    // it can read the agent lazily after it's been created with app.client below.
    // We use `import type` here; the dynamic import inside the if-block creates the value.
    type AgentType = import("./agent/index.js").Agent;
    let resolvedAgent: AgentType | undefined;
    const getAgent = () => resolvedAgent;

    const app = createSlackApp(api, getAgent, credentials, googleAuth, granolaAuth);

    if (config.anthropic.configured) {
      const { Agent } = await import("./agent/index.js");
      resolvedAgent = await Agent.create(credentials, undefined, app.client);
      console.log("[boot] agent enabled (conversational DMs + @mentions + Granola + Slack DMs)");
    } else {
      console.log("[boot] ANTHROPIC_API_KEY not set — slash commands only.");
    }

    slackApp = app;

    // Initialise proactive notification service with the live Slack client + Google auth.
    initNotifications(app.client, googleAuth);

    // DM users when their OAuth connections complete.
    onGoogleConnected = async (slackUserId) => {
      await app.client.chat.postMessage({
        channel: slackUserId,
        text: "✅ Google connected! You can now ask me to find emails, check your calendar, or draft an email.",
      });
    };
    onGranolaConnected = async (slackUserId) => {
      await app.client.chat.postMessage({
        channel: slackUserId,
        text: "✅ Granola connected! You can now ask me things like \"what did we discuss about a candidate\" or \"summarize my meeting notes this week\".",
      });
    };

    await app.start();
    console.log("[boot] ⚡ Slack app running (Socket Mode). DM the bot or try /metrics");
  } else {
    console.log("[boot] Slack not configured — set SLACK_BOT_TOKEN + SLACK_APP_TOKEN.");
  }

  // Start scheduler after Slack is ready so stage-change notifications have a live client.
  // Still runs even when Slack is absent (keeps the data store fresh).
  if (active.length > 0) {
    startScheduler();
  }

  startServer(googleAuth, granolaAuth, onGoogleConnected, onGranolaConnected);
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
