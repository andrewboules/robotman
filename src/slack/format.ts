/**
 * Slack message formatting. Pure string-building so it's easy to unit test and
 * reuse from the scheduled digest. No Slack SDK imports here.
 */
import type { PipelineMetrics, StaleCandidate } from "../logic/metrics.js";

export function formatMetrics(m: PipelineMetrics, lastSync: string | null): string {
  const line = (label: string, n: number) => `• ${label}: *${n}*`;
  const lastSyncLine = lastSync
    ? `_Data as of ${new Date(lastSync).toLocaleString()}_`
    : "_No successful sync yet — run a sync first._";
  return [
    `*📊 Pipeline metrics*`,
    line("Active candidates", m.active),
    line("Lead", m.byStage.lead),
    line("Applied", m.byStage.applied),
    line("Screen", m.byStage.screen),
    line("Interview", m.byStage.interview),
    line("Offer", m.byStage.offer),
    line("Hired", m.byStage.hired),
    `Total tracked: *${m.total}*`,
    lastSyncLine,
  ].join("\n");
}

export function formatStale(stale: StaleCandidate[], staleAfterDays: number): string {
  if (stale.length === 0) {
    return `✅ No candidates have been inactive for ${staleAfterDays}+ days. Pipeline is fresh.`;
  }
  const rows = stale
    .slice(0, 15)
    .map(
      (s) =>
        `• *${s.candidate.name}* — ${s.candidate.role ?? "role n/a"} ` +
        `(${s.candidate.stage}, ${s.daysInactive}d idle)`
    );
  const more = stale.length > 15 ? `\n…and ${stale.length - 15} more` : "";
  return [`⚠️ *${stale.length} stale candidate(s)* (${staleAfterDays}+ days idle):`, ...rows].join(
    "\n"
  ) + more;
}
