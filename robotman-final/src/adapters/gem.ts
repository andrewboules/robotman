/**
 * GEM ADAPTER
 * -----------
 * Maps Gem's ATS API into the normalized Candidate model. Same shape as the
 * Ashby adapter — proof that adding a connector is "implement Adapter + map
 * to Candidate," nothing more.
 *
 * Auth: Gem's API is fronted by AWS API Gateway and authenticated with an
 * `x-api-key` header. Keys are provisioned by a Gem Admin under Team Settings >
 * Integrations > API keys (access must be enabled by your Gem account team
 * first — email support@gem.com).
 *
 * Endpoints: Gem exposes three API surfaces — CRM (/v0), ATS (/ats/v0), and
 * Job Board (/job_board/v0). Pipeline/candidate data lives in the ATS API, so
 * that's what we use here.
 *
 * ⚠️ Gem's reference is access-gated and the per-field response shape isn't
 * publicly documented. The endpoint path, pagination scheme, and field names
 * below are best-effort and should be verified against your account's
 * reference at https://api.gem.com/ats/v0/reference. They're isolated to this
 * file, so tuning them touches nothing downstream.
 */
import { config } from "../config.js";
import type { Adapter } from "./types.js";
import type { Candidate, FetchResult, Stage } from "../types.js";

/** Subset of a Gem ATS candidate/application record we rely on. */
interface GemCandidate {
  id: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  emails?: string[];
  title?: string; // role / job title
  job_title?: string;
  stage?: string; // native Gem stage name
  status?: string;
  created_at?: string;
  updated_at?: string;
  last_activity_at?: string;
  owner_email?: string;
  recruiter_email?: string;
}

interface GemListResponse {
  data?: GemCandidate[];
  results?: GemCandidate[];
  next_cursor?: string | null;
  next?: string | null;
  has_more?: boolean;
}

export class GemAdapter implements Adapter {
  readonly source = "gem" as const;

  isConfigured(): boolean {
    return config.gem.configured;
  }

  async fetch(_since: string | null): Promise<FetchResult> {
    const records = await this.listAllCandidates();
    const candidates = records.filter((r) => r.id).map((r) => this.toCandidate(r));
    return { candidates };
  }

  /** Paginates the ATS candidates endpoint via cursor. */
  private async listAllCandidates(): Promise<GemCandidate[]> {
    const out: GemCandidate[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: "100" });
      if (cursor) qs.set("cursor", cursor);
      const page = await this.get(`/ats/v0/candidates?${qs.toString()}`);
      const batch = page.data ?? page.results ?? [];
      out.push(...batch);
      const nextCursor = page.next_cursor ?? page.next ?? null;
      cursor = page.has_more && nextCursor ? nextCursor : undefined;
    } while (cursor);
    return out;
  }

  private async get(path: string): Promise<GemListResponse> {
    const res = await fetch(`${config.gem.baseUrl}${path}`, {
      method: "GET",
      headers: {
        "x-api-key": config.gem.apiKey,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`Gem GET ${path} HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as GemListResponse;
  }

  private toCandidate(r: GemCandidate): Candidate {
    const now = new Date().toISOString();
    const name =
      r.name ?? ([r.first_name, r.last_name].filter(Boolean).join(" ").trim() || "(unknown)");
    const email = r.email ?? r.emails?.[0] ?? null;
    const lastActivity = r.last_activity_at ?? r.updated_at ?? r.created_at ?? now;
    return {
      id: `gem:${r.id}`,
      source: "gem",
      sourceId: r.id,
      name,
      email,
      role: r.job_title ?? r.title ?? null,
      stage: mapStage(r),
      createdAt: r.created_at ?? now,
      updatedAt: r.updated_at ?? r.created_at ?? now,
      lastActivityAt: lastActivity,
      ownerEmail: r.owner_email ?? r.recruiter_email ?? null,
      raw: r,
    };
  }
}

/** Map a Gem stage/status into our canonical Stage. Tune for your pipeline. */
export function mapStage(r: GemCandidate): Stage {
  const status = (r.status ?? "").toLowerCase();
  if (status === "hired") return "hired";
  if (/(reject|declin)/.test(status)) return "rejected";
  if (/(archiv|withdraw)/.test(status)) return "archived";

  const stage = (r.stage ?? "").toLowerCase();
  if (/offer/.test(stage)) return "offer";
  if (/(interview|onsite|technical|panel)/.test(stage)) return "interview";
  if (/(screen|recruiter|phone)/.test(stage)) return "screen";
  if (/(application|applied|new|review)/.test(stage)) return "applied";
  if (/(lead|sourc|prospect|outreach|contacted)/.test(stage)) return "lead";

  // Gem is sourcing-heavy; default unknowns to lead rather than applied.
  return "lead";
}
