/**
 * SCHEDULER
 * ---------
 * Cron-driven background sync. After each sync run, fires proactive
 * notifications for:
 *   - Ashby/Gem candidate stage changes (DMs the owner or a configured channel)
 *   - New emails matching a watched Gmail query (DMs a configured target)
 */
import cron from "node-cron";
import { config } from "../config.js";
import { syncAll } from "../sync.js";
import { notifyStageChanges, pollAndNotifyEmail } from "../slack/notifications.js";

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
      // Fire stage-change DMs for any candidates that moved stages.
      const allChanges = results.flatMap((r) => r.stageChanges ?? []);
      if (allChanges.length > 0) {
        console.log(`[scheduler] ${allChanges.length} stage change(s) detected — notifying…`);
        await notifyStageChanges(allChanges).catch((e) =>
          console.error("[scheduler] stage notifications failed:", e instanceof Error ? e.message : e)
        );
      }
      // Poll Gmail for new emails matching the watched query.
      if (config.notifications.emailQuery && config.notifications.emailSlackUserId) {
        await pollAndNotifyEmail().catch((e) =>
          console.error("[scheduler] email poll failed:", e instanceof Error ? e.message : e)
        );
      }
    } catch (err) {
      // Never let a scheduler failure crash the process.
      console.error("[scheduler] sync run failed:", err instanceof Error ? err.message : err);
    }
  });
}
