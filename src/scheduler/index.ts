/**
 * SCHEDULER
 * ---------
 * Cron-driven background sync. This is also where proactive alerts (e.g. a
 * daily stale-candidate post to a Slack channel) would be scheduled.
 */
import cron from "node-cron";
import { config } from "../config.js";
import { syncAll } from "../sync.js";

export function startScheduler(): void {
  if (!cron.validate(config.syncCron)) {
    throw new Error(`Invalid SYNC_CRON expression: ${config.syncCron}`);
  }
  console.log(`[scheduler] sync scheduled: ${config.syncCron}`);
  cron.schedule(config.syncCron, async () => {
    try {
      console.log("[scheduler] running sync…");
      const results = await syncAll();
      for (const r of results) {
        console.log(
          `[scheduler] ${r.source}: ${r.ok ? `${r.upserted} upserted` : `ERROR ${r.error}`}`
        );
      }
    } catch (err) {
      // Never let a scheduler failure crash the process.
      console.error("[scheduler] sync run failed:", err instanceof Error ? err.message : err);
    }
  });
}
