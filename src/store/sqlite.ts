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
import type { Repository } from "./repository.js";
import type { Candidate, Source, Stage, SyncRun } from "../types.js";

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
    `);
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
