/**
 * DEMO / SMOKE TEST
 * -----------------
 * Seeds mock candidates straight into the store (bypassing the network) and
 * runs the full logic + formatting path. Proves the slice end-to-end without
 * any Ashby/Gem/Slack credentials: `npm run demo`. Uses SQLite unless
 * DATABASE_URL is set.
 */
import { getRepository, closeStore } from "../store/repository.js";
import { OrchestrationApi } from "../interface/api.js";
import { formatMetrics, formatStale } from "../slack/format.js";
import { config } from "../config.js";
import type { Candidate, Stage } from "../types.js";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function mk(id: string, name: string, stage: Stage, idleDays: number, role: string): Candidate {
  return {
    id: `ashby:${id}`,
    source: "ashby",
    sourceId: id,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
    role,
    stage,
    createdAt: daysAgo(idleDays + 20),
    updatedAt: daysAgo(idleDays),
    lastActivityAt: daysAgo(idleDays),
    ownerEmail: "recruiter@example.com",
  };
}

const mock: Candidate[] = [
  mk("1", "Ada Lovelace", "interview", 12, "Staff Engineer"),
  mk("2", "Alan Turing", "screen", 2, "Staff Engineer"),
  mk("3", "Grace Hopper", "offer", 9, "Eng Manager"),
  mk("4", "Katherine Johnson", "applied", 1, "Data Scientist"),
  mk("5", "Linus Torvalds", "interview", 21, "Platform Lead"),
  mk("6", "Margaret Hamilton", "hired", 30, "Staff Engineer"),
  mk("7", "Dennis Ritchie", "lead", 40, "Compiler Eng"),
];

const repo = await getRepository();
const written = await repo.upsertCandidates(mock);
console.log(`Seeded ${written} mock candidates.\n`);

const api = new OrchestrationApi(repo);
console.log("=== /metrics ===");
console.log(formatMetrics(await api.getPipelineMetrics(), new Date().toISOString()));
console.log("\n=== /stale ===");
console.log(formatStale(await api.getStaleCandidates(), config.staleAfterDays));

await closeStore();
