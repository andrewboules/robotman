/**
 * SYNC ORCHESTRATOR
 * -----------------
 * Runs each configured adapter, writes the normalized results into the store,
 * and records a sync run for observability. This is the "pull" half of the
 * orchestration layer; the logic engine + interface read from the store.
 */
import { configuredAdapters } from "./adapters/index.js";
import type { Adapter } from "./adapters/types.js";
import { getRepository, type Repository } from "./store/repository.js";

export interface SyncSummary {
  source: string;
  upserted: number;
  ok: boolean;
  error?: string;
}

export async function syncOne(adapter: Adapter, repo: Repository): Promise<SyncSummary> {
  const runId = await repo.startSyncRun(adapter.source);
  try {
    const since = (await repo.lastSuccessfulSync(adapter.source))?.finishedAt ?? null;
    const { candidates } = await adapter.fetch(since);
    const upserted = await repo.upsertCandidates(candidates);
    await repo.finishSyncRun(runId, upserted);
    return { source: adapter.source, upserted, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.finishSyncRun(runId, 0, message);
    return { source: adapter.source, upserted: 0, ok: false, error: message };
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
