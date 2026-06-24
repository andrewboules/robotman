/**
 * LOGIC ENGINE
 * ------------
 * Pure functions over normalized data. No I/O, no SQL, no Slack — just rules.
 * This is where product value lives and it stays simple precisely because the
 * store already normalized every source into one shape.
 */
import { ACTIVE_STAGES, type Candidate, type Stage } from "../types.js";

export interface PipelineMetrics {
  total: number;
  active: number;
  byStage: Record<Stage, number>;
  generatedAt: string;
}

const ALL_STAGES: Stage[] = [
  "lead",
  "applied",
  "screen",
  "interview",
  "offer",
  "hired",
  "rejected",
  "archived",
];

export function computePipelineMetrics(candidates: Candidate[]): PipelineMetrics {
  const byStage = Object.fromEntries(ALL_STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const c of candidates) byStage[c.stage]++;
  const active = ACTIVE_STAGES.reduce((sum, s) => sum + byStage[s], 0);
  return {
    total: candidates.length,
    active,
    byStage,
    generatedAt: new Date().toISOString(),
  };
}

export interface StaleCandidate {
  candidate: Candidate;
  daysInactive: number;
}

/** Active-stage candidates with no activity for >= `staleAfterDays`. */
export function findStaleCandidates(
  candidates: Candidate[],
  staleAfterDays: number,
  now: Date = new Date()
): StaleCandidate[] {
  const active = new Set<Stage>(ACTIVE_STAGES);
  const cutoffMs = staleAfterDays * 24 * 60 * 60 * 1000;
  return candidates
    .filter((c) => active.has(c.stage))
    .map((c) => ({
      candidate: c,
      daysInactive: Math.floor(
        (now.getTime() - new Date(c.lastActivityAt).getTime()) / (24 * 60 * 60 * 1000)
      ),
    }))
    .filter((x) => now.getTime() - new Date(x.candidate.lastActivityAt).getTime() >= cutoffMs)
    .sort((a, b) => b.daysInactive - a.daysInactive);
}
