/**
 * INTERFACE API
 * -------------
 * The boundary every front-end calls — Slack today, a dashboard or email
 * digest tomorrow. It composes the store + logic engine and returns clean,
 * serializable results. Keeping this separate from Slack is what makes the
 * Slack app a thin shell.
 */
import { getRepository, type Repository } from "../store/repository.js";
import { config } from "../config.js";
import {
  computePipelineMetrics,
  findStaleCandidates,
  type PipelineMetrics,
  type StaleCandidate,
} from "../logic/metrics.js";

export class OrchestrationApi {
  private repo: Repository;

  constructor(repo: Repository) {
    this.repo = repo;
  }

  /** Convenience constructor that resolves the shared repository. */
  static async create(): Promise<OrchestrationApi> {
    return new OrchestrationApi(await getRepository());
  }

  async getPipelineMetrics(): Promise<PipelineMetrics> {
    return computePipelineMetrics(await this.repo.allCandidates());
  }

  async getStaleCandidates(staleAfterDays = config.staleAfterDays): Promise<StaleCandidate[]> {
    return findStaleCandidates(await this.repo.allCandidates(), staleAfterDays);
  }

  async lastSyncInfo(): Promise<{ source: string; finishedAt: string | null; records: number } | null> {
    const run = await this.repo.lastSuccessfulSync("ashby");
    if (!run) return null;
    return { source: run.source, finishedAt: run.finishedAt, records: run.recordsUpserted };
  }
}
