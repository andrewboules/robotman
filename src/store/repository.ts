/**
 * REPOSITORY CONTRACT + FACTORY
 * -----------------------------
 * `Repository` is the async interface every layer above the store talks to.
 * Two implementations exist — SQLite (local/dev) and Postgres (production) —
 * and `getRepository()` picks one based on whether DATABASE_URL is set. The
 * implementation modules are imported dynamically so production images don't
 * need the SQLite native build, and dev doesn't need a Postgres driver running.
 */
import { config } from "../config.js";
import type { Candidate, Source, Stage, SyncRun } from "../types.js";
import type { ConnectionInfo } from "../identity/credentials.js";

/** A stored, encrypted per-user credential row (secret stays ciphertext here). */
export interface CredentialRow {
  slackUserId: string;
  provider: string;
  baseUrl: string | null;
  secretCipher: string;
}

export interface Repository {
  /** Idempotent setup; safe to call on every boot. */
  migrate(): Promise<void>;

  /** Idempotent bulk upsert keyed on (source, source_id). Returns rows written. */
  upsertCandidates(candidates: Candidate[]): Promise<number>;

  allCandidates(): Promise<Candidate[]>;
  candidatesByStage(stage: Stage): Promise<Candidate[]>;
  staleActiveCandidates(activeStages: Stage[], cutoffIso: string): Promise<Candidate[]>;

  startSyncRun(source: Source): Promise<number>;
  finishSyncRun(id: number, recordsUpserted: number, error?: string | null): Promise<void>;
  lastSuccessfulSync(source: Source): Promise<SyncRun | null>;

  // --- per-user encrypted credentials ---
  upsertCredential(row: CredentialRow): Promise<void>;
  getCredentialRow(slackUserId: string, provider: string): Promise<{ baseUrl: string | null; secretCipher: string } | null>;
  listCredentials(slackUserId: string): Promise<ConnectionInfo[]>;
  deleteCredential(slackUserId: string, provider: string): Promise<void>;

  close(): Promise<void>;
}

let _repo: Repository | null = null;

/** Returns the shared repository, creating + migrating it on first call. */
export async function getRepository(): Promise<Repository> {
  if (_repo) return _repo;
  if (config.databaseUrl) {
    const { PostgresRepository } = await import("./postgres.js");
    _repo = new PostgresRepository(config.databaseUrl);
  } else {
    const { SqliteRepository } = await import("./sqlite.js");
    _repo = new SqliteRepository(config.databaseFile);
  }
  await _repo.migrate();
  return _repo;
}

export async function closeStore(): Promise<void> {
  if (_repo) {
    await _repo.close();
    _repo = null;
  }
}
