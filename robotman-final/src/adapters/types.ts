/**
 * ADAPTER CONTRACT
 * ----------------
 * Every source implements this. The orchestrator only knows about `Adapter`;
 * it never imports a specific vendor client. To add Gem/Greenhouse/etc., drop
 * a new file implementing this interface and register it in `index.ts`.
 */
import type { FetchResult, Source } from "../types.js";

export interface Adapter {
  readonly source: Source;
  /** True when credentials are present. Unconfigured adapters are skipped. */
  isConfigured(): boolean;
  /**
   * Pull records and map them into the normalized model.
   * `since` is the last successful sync time (ISO) for future incremental
   * pulls; adapters may ignore it and do a full sync.
   */
  fetch(since: string | null): Promise<FetchResult>;
}
