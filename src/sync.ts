/**
 * SYNC ORCHESTRATOR
 * -----------------
 * Runs each configured adapter, writes the normalized results into the store,
 * and records a sync run for observability. This is the "pull" half of the
 * orchestration layer; the logic engine + interface read from the store.
 *
 * Stage-change detection: before each source sync we snapshot every candidate's
 * current stage. After the upsert we diff the incoming records against the
 * snapshot — any candidate whose stage changed is reported in `stageChanges`
 * so the scheduler can fire Slack DM notifications.
 */
import { configuredAdapters } from "./adapters/index.js";
import type { Adapter } from "./adapters/types.js";
import { getRepository, type Repository } from "./store/repository.js";
import type { Candidate } from "./types.js";

export interface StageChange {
  candidate: Candidate;
  fromStage: string;
  toStage: string;
}

export interface SyncSummary {
  source: string;
  upserted: number;
  ok: boolean;
  error?: string;
  stageChanges: StageChange[];
}

export async function syncOne(adapter: Adapter, repo: Repository): Promise<SyncSummary> {
  const runId = await repo.startSyncRun(adapter.source);
  try {
    // Snapshot current stages for this source before syncing.
    const before = new Map<string, string>();
    for (const c of await repo.allCandidates()) {
      if (c.source === adapter.source) before.set(c.id, c.stage);
    }

    const since = (await repo.lastSuccessfulSync(adapter.source))?.finishedAt ?? null;
    const { candidates } = await adapter.fetch(since);
    const upserted = await repo.upsertCandidates(candidates);
    await repo.finishSyncRun(runId, upserted);

    // Detect stage changes (only for candidates that already existed).
    const stageChanges: StageChange[] = [];
    for (const c of candidates) {
      const prev = before.get(c.id);
      if (prev && prev !== c.stage) {
        stageChanges.push({ candidate: c, fromStage: prev, toStage: c.stage });
      }
    }

    return { source: adapter.source, upserted, ok: true, stageChanges };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.finishSyncRun(runId, 0, message);
    return { source: adapter.source, upserted: 0, ok: false, error: message, stageChanges: [] };
  }
}

export async function syncAll(repo?: Repository): Promise<SyncSummary[]> {
  const store = repo ?? (await getRepository());
  const active = configuredAdapters();
  const results: SyncSummary[] = [];
  for (const adapter of active) {
    results.push(await syncOne(adapter, store));
  }
  return results;
}
