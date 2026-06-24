/**
 * ADAPTER REGISTRY
 * ----------------
 * Add a connector by importing its adapter and pushing it here. The sync
 * orchestrator iterates this list and skips any that aren't configured, so
 * you can ship adapters incrementally.
 */
import type { Adapter } from "./types.js";
import { AshbyAdapter } from "./ashby.js";
import { GemAdapter } from "./gem.js";

// Future: GreenhouseAdapter, GmailAdapter, GCalAdapter, GranolaAdapter,
// NotionAdapter — each implements Adapter.
export const adapters: Adapter[] = [new AshbyAdapter(), new GemAdapter()];

export function configuredAdapters(): Adapter[] {
  return adapters.filter((a) => a.isConfigured());
}
