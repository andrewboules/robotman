/**
 * NORMALIZED DATA MODEL
 * ---------------------
 * Every connector maps its own schema into THESE types. Downstream logic
 * (metrics, alerts, Slack) only ever sees these shapes — never raw Ashby /
 * Gem / Greenhouse payloads. This is the single most important contract in
 * the system: get it right and adding a 2nd/3rd source is cheap.
 *
 * `source` + `sourceId` together identify the upstream record so syncs are
 * idempotent (upsert on that pair). Add new sources to `Source` as you build
 * their adapters.
 */

export type Source = "ashby" | "gem" | "greenhouse" | "gmail" | "gcal" | "granola" | "notion";

/** Canonical pipeline stages. Each adapter maps its native stages into these. */
export type Stage =
  | "lead"
  | "applied"
  | "screen"
  | "interview"
  | "offer"
  | "hired"
  | "rejected"
  | "archived";

export const ACTIVE_STAGES: Stage[] = ["lead", "applied", "screen", "interview", "offer"];

export interface Candidate {
  /** Stable internal id (we generate it): `${source}:${sourceId}`. */
  id: string;
  source: Source;
  sourceId: string;
  name: string;
  email: string | null;
  /** Free-text role/job title the candidate is in pipeline for. */
  role: string | null;
  stage: Stage;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** When the candidate last moved stage / had activity, per the source. */
  lastActivityAt: string;
  /** Owner / recruiter email if known. */
  ownerEmail: string | null;
  /** Anything source-specific we want to keep but not model yet. */
  raw?: unknown;
}

/** A single sync run, for observability + incremental syncing. */
export interface SyncRun {
  id: number;
  source: Source;
  startedAt: string;
  finishedAt: string | null;
  recordsUpserted: number;
  status: "running" | "ok" | "error";
  error: string | null;
}

/** What an adapter returns to the orchestrator. */
export interface FetchResult {
  candidates: Candidate[];
}
