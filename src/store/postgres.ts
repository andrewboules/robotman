/**
 * POSTGRES REPOSITORY (production)
 * --------------------------------
 * Used whenever DATABASE_URL is set (Render injects it automatically from the
 * provisioned database). Concurrency-safe and backed up by the host. Timestamps
 * are stored as TEXT (ISO strings) to keep results byte-identical to the SQLite
 * implementation, so nothing downstream can tell which store is in use.
 */
import pg from "pg";
import type { Repository } from "./repository.js";
import type { Candidate, Source, Stage, SyncRun } from "../types.js";

const { Pool } = pg;

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

export class PostgresRepository implements Repository {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      // Most managed Postgres (Render, Neon, RDS) require TLS. Allow self-signed
      // chains used by these providers.
      ssl: { rejectUnauthorized: false },
      max: 10,
    });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
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
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_candidates_stage ON candidates (stage);`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_candidates_activity ON candidates (last_activity_at);`
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sync_runs (
        id               SERIAL PRIMARY KEY,
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
    if (candidates.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sql = `
        INSERT INTO candidates
          (id, source, source_id, name, email, role, stage,
           created_at, updated_at, last_activity_at, owner_email, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (source, source_id) DO UPDATE SET
          name             = EXCLUDED.name,
          email            = EXCLUDED.email,
          role             = EXCLUDED.role,
          stage            = EXCLUDED.stage,
          updated_at       = EXCLUDED.updated_at,
          last_activity_at = EXCLUDED.last_activity_at,
          owner_email      = EXCLUDED.owner_email,
          raw              = EXCLUDED.raw
      `;
      for (const c of candidates) {
        await client.query(sql, [
          c.id,
          c.source,
          c.sourceId,
          c.name,
          c.email,
          c.role,
          c.stage,
          c.createdAt,
          c.updatedAt,
          c.lastActivityAt,
          c.ownerEmail,
          c.raw === undefined ? null : JSON.stringify(c.raw),
        ]);
      }
      await client.query("COMMIT");
      return candidates.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async allCandidates(): Promise<Candidate[]> {
    const { rows } = await this.pool.query<CandidateRow>(`SELECT * FROM candidates`);
    return rows.map(rowToCandidate);
  }

  async candidatesByStage(stage: Stage): Promise<Candidate[]> {
    const { rows } = await this.pool.query<CandidateRow>(
      `SELECT * FROM candidates WHERE stage = $1`,
      [stage]
    );
    return rows.map(rowToCandidate);
  }

  async staleActiveCandidates(activeStages: Stage[], cutoffIso: string): Promise<Candidate[]> {
    const { rows } = await this.pool.query<CandidateRow>(
      `SELECT * FROM candidates
       WHERE stage = ANY($1) AND last_activity_at < $2
       ORDER BY last_activity_at ASC`,
      [activeStages, cutoffIso]
    );
    return rows.map(rowToCandidate);
  }

  async startSyncRun(source: Source): Promise<number> {
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO sync_runs (source, started_at, status) VALUES ($1, $2, 'running') RETURNING id`,
      [source, new Date().toISOString()]
    );
    return rows[0].id;
  }

  async finishSyncRun(id: number, recordsUpserted: number, error: string | null = null): Promise<void> {
    await this.pool.query(
      `UPDATE sync_runs
       SET finished_at = $1, records_upserted = $2, status = $3, error = $4
       WHERE id = $5`,
      [new Date().toISOString(), recordsUpserted, error ? "error" : "ok", error, id]
    );
  }

  async lastSuccessfulSync(source: Source): Promise<SyncRun | null> {
    const { rows } = await this.pool.query<{
      id: number;
      source: string;
      started_at: string;
      finished_at: string | null;
      records_upserted: number;
      status: string;
      error: string | null;
    }>(
      `SELECT * FROM sync_runs WHERE source = $1 AND status = 'ok'
       ORDER BY finished_at DESC LIMIT 1`,
      [source]
    );
    const row = rows[0];
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
    await this.pool.end();
  }
}
