# Deploy to Render

Goal: push the repo, click deploy, paste your secrets. The blueprint
(`render.yaml`) provisions the web service **and** a Postgres database together,
runs migrations on boot, and keeps the Slack bot + sync scheduler always-on.

## What you need first (gather these, don't share them with anyone)

| Secret | Where to get it |
|--------|-----------------|
| `ASHBY_API_KEY` | Ashby → Admin → Integrations → API. Create a **read-only** key. |
| `GEM_API_KEY` | Email support@gem.com to enable API access, then Team Settings → Integrations → API keys → Create. |
| `SLACK_BOT_TOKEN` (`xoxb-…`) | api.slack.com/apps → your app → OAuth & Permissions. |
| `SLACK_APP_TOKEN` (`xapp-…`) | Same app → Basic Information → App-Level Tokens (scope `connections:write`). |
| `SLACK_SIGNING_SECRET` | Same app → Basic Information → App Credentials. |

### Slack app setup (one-time)

1. Create an app at https://api.slack.com/apps (from scratch).
2. **Socket Mode**: turn ON. Generate an app-level token → that's `SLACK_APP_TOKEN`.
3. **Slash Commands**: add `/metrics` and `/stale` (request URL can be anything — Socket Mode ignores it).
4. **OAuth & Permissions**: add bot scopes `commands` and `chat:write`. Install to workspace → copy the bot token.

## Deploy

1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint** → select the repo. Render reads `render.yaml`.
3. Render shows the secrets marked `sync: false` and prompts you to paste each
   value. Enter the five above. (`DATABASE_URL` is wired automatically — leave it.)
4. Click **Apply**. Render builds the Docker image, creates Postgres, runs
   migrations on boot, and starts the service.
5. Watch the logs: you should see `store ready (postgres)`, the initial sync
   results per connector, and `⚡ Slack app running`.
6. In Slack, DM the bot or run `/metrics` in a channel it's in.

## After deploy

- **Verify the connectors.** Confirm the Ashby stage mapping (`src/adapters/ashby.ts`)
  and Gem endpoint/fields (`src/adapters/gem.ts`) against your real accounts.
- **Sync cadence**: change `SYNC_CRON` in the Render dashboard (default every 15 min).
- **Scaling caveat**: keep this at **one instance**. The scheduler runs in-process,
  so multiple replicas would multiply the sync. To scale the Slack side, split the
  cron into a separate single-instance worker.

## Local production-style run (optional)

```bash
docker build -t orchestration .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="postgres://user:pass@host:5432/db" \
  -e ASHBY_API_KEY=... -e SLACK_BOT_TOKEN=... -e SLACK_APP_TOKEN=... \
  orchestration
```

Without `DATABASE_URL` and credentials, `npm run demo` still runs the whole
logic path on SQLite with mock data — no setup required.
