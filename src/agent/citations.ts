/**
 * CITATION ENGINE
 * ---------------
 * Robot Machine must never assert a fact without a link back to the source.
 * Tools attach `Citation`s to their results; the agent loop collects them and
 * renders a Sources section. Each citation maps a normalized record back to a
 * clickable URL in the originating system.
 *
 * NOTE: the deep-link URL patterns are best-effort. Ashby candidate links follow
 * `app.ashbyhq.com/candidates/{id}`; Gem's app URL scheme isn't publicly
 * documented, so we link to the prospect by id and fall back to the app root.
 * Verify both against your tenant and adjust here — it's the only place URLs
 * are built.
 */
import { config } from "../config.js";
import type { Candidate, Source } from "../types.js";

export interface Citation {
  /** Short label shown to the user, e.g. "Ashby · Ada Lovelace". */
  label: string;
  url: string;
  source: Source;
}

export function candidateUrl(c: Candidate): string {
  switch (c.source) {
    case "ashby":
      return `${config.links.ashbyApp}/candidates/${c.sourceId}`;
    case "gem":
      return `${config.links.gemApp}/prospects/${c.sourceId}`;
    default:
      return config.links.ashbyApp;
  }
}

export function candidateCitation(c: Candidate): Citation {
  const system = c.source.charAt(0).toUpperCase() + c.source.slice(1);
  return { label: `${system} · ${c.name}`, url: candidateUrl(c), source: c.source };
}

/** De-duplicate by URL, preserving first-seen order. */
export function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

/** Render citations as a Slack-friendly Sources block. */
export function renderSources(citations: Citation[]): string {
  const unique = dedupeCitations(citations);
  if (unique.length === 0) return "";
  const lines = unique.map((c) => `• <${c.url}|${c.label}>`);
  return `\n\n*Sources:*\n${lines.join("\n")}`;
}
