# Recruiting Orchestration Layer / Robot Machine

A TypeScript orchestration layer that connects recruiting tools and exposes them
through Slack — both as quick slash commands and as **Robot Machine**, a
conversational AI agent you DM like a coworker.

Two interaction modes:

- **Conversational agent** — DM the bot or @mention it. A Claude tool-calling
  loop plans which tools to call, reads from Ashby + Gem, and replies with cited
  answers. "What happened with Tanner?", "Who's stuck?", "How's the pipeline?"
- **Slash commands** — `/metrics`, `/stale` for fast deterministic reports.

Data flows: connectors → adapters → normalized store → (logic engine | agent
tools) → interface/Slack. Every connector (Gmail, GCal, Notion, Granola, …)
plugs into the same adapter pattern; every agent capability is one more tool.

## Agent layer (`src/agent/`)

| File           | Role |
|----------------|------|
| `loop.ts`      | Planner→retriever→synthesizer tool-calling loop. LLM injected for testability. |
| `tools.ts`     | Read-only tools over the store (search/get candidate, metrics, stale). |
| `citations.ts` | Source-link builder + Sources rendering. No fact without a link. |
| `memory.ts`    | Per-conversation history (in-memory v1; Redis/Postgres swap point). |
| `index.ts`     | Wires the real Anthropic client + store + memory into an `Agent`. |

Identity lives in `src/identity/` — per-user resolution + an OAuth `TokenStore`
ready for Google (Gmail/Drive/Calendar) when those tools are added.

> v1 agent is **read-only** and uses org-level Ashby/Gem keys; per-user Google
> OAuth and write actions (with confirmation) are the next milestones.

## Architecture

```
connectors ──▶ adapters ──▶ normalized store ──▶ logic engine ──▶ interface API ──▶ Slack
   Ashby        ashby.ts      SQLite + repo        metrics.ts        api.ts          app.ts
```

| Layer            | Files                          | Responsibility |
|------------------|--------------------------------|----------------|
| Adapters         | `src/adapters/*`               | One per source. Fetch + map raw payloads into the normalized model. Vendor-specific code is isolated here. |
| Normalized store | `src/store/*`, `src/types.ts`  | One canonical `Candidate` shape. Repository is the only code that touches SQL — swap SQLite for Postgres by reimplementing `repository.ts`. |
| Logic engine     | `src/logic/*`                  | Pure functions: pipeline metrics, stale-candidate detection. No I/O. |
| Interface API    | `src/interface/api.ts`         | Composes store + logic. The boundary every front-end calls. |
| Slack (shell)    | `src/slack/*`                  | One Bolt app, slash commands only. No business logic. |
| Auth / config    | `src/config.ts`                | Single place secrets are read. Plug a real secrets manager here. |
| Scheduler        | `src/scheduler/*`              | Cron sync + home for proactive alerts. |

## Quick start

```bash
npm install
cp .env.example .env        # optional — demo needs no credentials

npm run demo                # seeds mock data, prints /metrics + /stale output
```

To run for real:

```bash
# 1. Add ASHBY_API_KEY to .env, then pull data:
npm run sync

# 2. Add SLACK_BOT_TOKEN + SLACK_APP_TOKEN, then boot everything:
npm start                   # initial sync + scheduler + Slack app
```

The app degrades gracefully: with only Ashby it syncs but won't start Slack;
with neither it just runs migrations.

## Adding the next connector

1. Create `src/adapters/<source>.ts` implementing the `Adapter` interface.
2. Map that source's records into the normalized `Candidate` type — that's the
   only real work.
3. Register it in `src/adapters/index.ts`.
4. Add its credentials to `config.ts` + `.env.example`.

No changes needed to the store, logic, interface, or Slack layers. New Slack
commands are likewise just a logic rule + a formatter + a handler.

## Notes / things to verify for your org

- **Ashby stage mapping** (`mapStage` in `src/adapters/ashby.ts`) uses keyword
  matching on stage titles. Ashby pipelines are customizable — check the keywords
  against your instance.
- **Incremental sync**: adapters receive the last successful sync time but the
  Ashby adapter currently does a full pull. Add `updatedAt` filtering when volume
  grows.
- **Storage**: SQLite for now. The repository layer is the seam for Postgres.
```
