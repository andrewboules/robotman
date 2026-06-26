/**
 * SQLITE REPOSITORY (local / dev)
 * -------------------------------
 * Zero-setup, single file. better-sqlite3 is synchronous, so the async methods
 * just wrap immediate results. Used whenever DATABASE_URL is NOT set.
 *
 * better-sqlite3 lives in devDependencies and this module is imported
 * dynamically, so production (Postgres) images never load or build it.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CredentialRow, Repository } from "./repository.js";
import type { Candidate, Source, Stage, SyncRun } from "../types.js";
import type { ConnectionInfo } from "../identity/credentials.js";

interface CandidateRow {
  id: string;
  source: string;
  source_id: string;
  name: string;
  email: string | null;
  role: string | null;
  stage: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  owner_email: string | null;
  raw: string | null;
}

function rowToCandidate(r: CandidateRow): Candidate {
  return {
    id: r.id,
    source: r.source as Source,
    sourceId: r.source_id,
    name: r.name,
    email: r.email,
    role: r.role,
    stage: r.stage as Stage,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at,
    ownerEmail: r.owner_email,
    raw: r.raw ? JSON.parse(r.raw) : undefined,
  };
}

export class SqliteRepository implements Repository {
  private db: Database.Database;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  async migrate(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidates (
        id               TEXT PRIMARY KEY,
        source           TEXT NOT NULL,
        source_id        TEXT NOT NULL,
        name             TEXT NOT NULL,
        email            TEXT,
        role             TEXT,
        stage            TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        owner_email      TEXT,
        raw              TEXT,
        UNIQUE (source, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_stage ON candidates (stage);
      CREATE INDEX IF NOT EXISTS idx_candidates_activity ON candidates (last_activity_at);

      CREATE TABLE IF NOT EXISTS sync_runs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        source           TEXT NOT NULL,
        started_at       TEXT NOT NULL,
        finished_at      TEXT,
        records_upserted INTEGER NOT NULL DEFAULT 0,
        status           TEXT NOT NULL,
        error            TEXT
      );

      CREATE TABLE IF NOT EXISTS user_credentials (
        slack_user_id TEXT NOT NULL,
        provider      TEXT NOT NULL,
        base_url      TEXT,
        secret_cipher TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (slack_user_id, provider)
      );

      CREATE TABLE IF NOT EXISTS user_context (
        slack_user_id TEXT NOT NULL,
        key           TEXT NOT NULL,
        value         TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (slack_user_id, key)
      );
    `);
  }

  async upsertCredential(row: CredentialRow): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO user_credentials (slack_user_id, provider, base_url, secret_cipher, created_at, updated_at)
         VALUES (@slackUserId, @provider, @baseUrl, @secretCipher, @now, @now)
         ON CONFLICT (slack_user_id, provider) DO UPDATE SET
           base_url = excluded.base_url,
           secret_cipher = excluded.secret_cipher,
           updated_at = excluded.updated_at`
      )
      .run({ ...row, now });
  }

  async getCredentialRow(slackUserId: string, provider: string) {
    const row = this.db
      .prepare(`SELECT base_url, secret_cipher FROM user_credentials WHERE slack_user_id = ? AND provider = ?`)
      .get(slackUserId, provider) as { base_url: string | null; secret_cipher: string } | undefined;
    if (!row) return null;
    return { baseUrl: row.base_url, secretCipher: row.secret_cipher };
  }

  async listCredentials(slackUserId: string): Promise<ConnectionInfo[]> {
    const rows = this.db
      .prepare(`SELECT provider, base_url FROM user_credentials WHERE slack_user_id = ? ORDER BY provider`)
      .all(slackUserId) as { provider: string; base_url: string | null }[];
    return rows.map((r) => ({ provider: r.provider, baseUrl: r.base_url }));
  }

  async deleteCredential(slackUserId: string, provider: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM user_credentials WHERE slack_user_id = ? AND provider = ?`)
      .run(slackUserId, provider);
  }

  async getUserContext(slackUserId: string): Promise<Record<string, string>> {
    const rows = this.db
      .prepare(`SELECT key, value FROM user_context WHERE slack_user_id = ? ORDER BY key`)
      .all(slackUserId) as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setUserContext(slackUserId: string, key: string, value: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO user_context (slack_user_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (slack_user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(slackUserId, key, value, now);
  }

  async upsertCandidates(candidates: Candidate[]): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO candidates
        (id, source, source_id, name, email, role, stage,
         created_at, updated_at, last_activity_at, owner_email, raw)
      VALUES
        (@id, @source, @sourceId, @name, @email, @role, @stage,
         @createdAt, @updatedAt, @lastActivityAt, @ownerEmail, @raw)
      ON CONFLICT (source, source_id) DO UPDATE SET
        name             = excluded.name,
        email            = excluded.email,
        role             = excluded.role,
        stage            = excluded.stage,
        updated_at       = excluded.updated_at,
        last_activity_at = excluded.last_activity_at,
        owner_email      = excluded.owner_email,
        raw              = excluded.raw
    `);
    const tx = this.db.transaction((rows: Candidate[]) => {
      for (const c of rows) {
        stmt.run({ ...c, raw: c.raw === undefined ? null : JSON.stringify(c.raw) });
      }
      return rows.length;
    });
    return tx(candidates);
  }

  async allCandidates(): Promise<Candidate[]> {
    const rows = this.db.prepare(`SELECT * FROM candidates`).all() as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  async candidatesByStage(stage: Stage): Promise<Candidate[]> {
    const rows = this.db
      .prepare(`SELECT * FROM candidates WHERE stage = ?`)
      .all(stage) as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  async staleActiveCandidates(activeStages: Stage[], cutoffIso: string): Promise<Candidate[]> {
    const placeholders = activeStages.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM candidates
         WHERE stage IN (${placeholders}) AND last_activity_at < ?
         ORDER BY last_activity_at ASC`
      )
      .all(...activeStages, cutoffIso) as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  async startSyncRun(source: Source): Promise<number> {
    const info = this.db
      .prepare(`INSERT INTO sync_runs (source, started_at, status) VALUES (?, ?, 'running')`)
      .run(source, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  async finishSyncRun(id: number, recordsUpserted: number, error: string | null = null): Promise<void> {
    this.db
      .prepare(
        `UPDATE sync_runs SET finished_at = ?, records_upserted = ?, status = ?, error = ? WHERE id = ?`
      )
      .run(new Date().toISOString(), recordsUpserted, error ? "error" : "ok", error, id);
  }

  async lastSuccessfulSync(source: Source): Promise<SyncRun | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM sync_runs WHERE source = ? AND status = 'ok' ORDER BY finished_at DESC LIMIT 1`
      )
      .get(source) as
      | {
          id: number;
          source: string;
          started_at: string;
          finished_at: string | null;
          records_upserted: number;
          status: string;
          error: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      source: row.source as Source,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      recordsUpserted: row.records_upserted,
      status: row.status as SyncRun["status"],
      error: row.error,
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
