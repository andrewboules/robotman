/**
 * ENTRYPOINT
 * ----------
 * Boots the orchestration layer: connects + migrates the store, runs an
 * initial sync, starts the scheduler, launches the Slack app (if configured),
 * and serves a /health endpoint for the host's health checks. Degrades
 * gracefully so it runs with any subset of connectors configured.
 */
import { createServer } from "node:http";
import { config } from "./config.js";
import { getRepository, closeStore } from "./store/repository.js";
import { syncAll } from "./sync.js";
import { startScheduler } from "./scheduler/index.js";
import { configuredAdapters } from "./adapters/index.js";
import { OrchestrationApi } from "./interface/api.js";

function startHealthServer(): void {
  const server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(config.port, () => console.log(`[boot] health server on :${config.port}`));
}

async function main(): Promise<void> {
  console.log("[boot] orchestration layer starting");
  await getRepository(); // connect + migrate
  console.log(`[boot] store ready (${config.databaseUrl ? "postgres" : "sqlite"})`);

  startHealthServer();

  const active = configuredAdapters().map((a) => a.source);
  console.log(`[boot] configured connectors: ${active.length ? active.join(", ") : "none"}`);

  if (active.length > 0) {
    console.log("[boot] running initial sync…");
    for (const r of await syncAll()) {
      console.log(`[boot] ${r.source}: ${r.ok ? `${r.upserted} upserted` : `ERROR ${r.error}`}`);
    }
    startScheduler();
  } else {
    console.log("[boot] no connectors configured — set ASHBY_API_KEY / GEM_API_KEY to enable sync.");
  }

  if (config.slack.configured) {
    const { createSlackApp } = await import("./slack/app.js");
    const { CredentialService } = await import("./identity/credentials.js");
    const { getRepository } = await import("./store/repository.js");
    const api = await OrchestrationApi.create();
    const credentials = new CredentialService(await getRepository(), config.credentialEncKey);
    console.log(
      credentials.enabled
        ? "[boot] per-user connections enabled (/connect)"
        : "[boot] CREDENTIAL_ENC_KEY not set — /connect disabled."
    );

    let agent;
    if (config.anthropic.configured) {
      const { Agent } = await import("./agent/index.js");
      agent = await Agent.create(credentials);
      console.log("[boot] agent enabled (conversational DMs + @mentions)");
    } else {
      console.log("[boot] ANTHROPIC_API_KEY not set — slash commands only, no conversational agent.");
    }

    const app = createSlackApp(api, agent, credentials);
    await app.start();
    console.log("[boot] ⚡ Slack app running (Socket Mode). DM the bot or try /metrics");
  } else {
    console.log("[boot] Slack not configured — set SLACK_BOT_TOKEN + SLACK_APP_TOKEN to enable.");
  }

  console.log("[boot] ready");
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal} received, closing store…`);
  await closeStore().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
