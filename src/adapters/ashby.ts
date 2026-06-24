/**
 * ASHBY ADAPTER
 * -------------
 * Maps Ashby's RPC-style API into the normalized Candidate model.
 *
 * Auth: HTTP Basic — API key as the username, blank password (per Ashby docs).
 * Endpoint style: POST {baseUrl}/{resource.action} with a JSON body; responses
 * look like { success, results, moreDataAvailable, nextCursor }.
 *
 * NOTE: Ashby stages are fully customizable per org. The `mapStage` function
 * below is a sensible default — verify the title keywords against your own
 * Ashby pipeline and adjust. That mapping is the one place this adapter needs
 * tuning for your instance.
 */
import { config } from "../config.js";
import type { Adapter } from "./types.js";
import type { Candidate, FetchResult, Stage } from "../types.js";

interface AshbyListResponse<T> {
  success: boolean;
  results?: T[];
  moreDataAvailable?: boolean;
  nextCursor?: string;
  errors?: string[];
}

/** Subset of Ashby's application object we rely on. */
interface AshbyApplication {
  id: string;
  createdAt: string;
  updatedAt?: string;
  status?: string; // "Active" | "Hired" | "Archived" | ...
  candidate?: {
    id: string;
    name?: string;
    primaryEmailAddress?: { value?: string } | null;
  };
  currentInterviewStage?: { title?: string; type?: string } | null;
  job?: { title?: string } | null;
  // Ashby exposes various activity timestamps; we fall back across them.
  lastActivityAt?: string;
}

export class AshbyAdapter implements Adapter {
  readonly source = "ashby" as const;

  isConfigured(): boolean {
    return config.ashby.configured;
  }

  async fetch(_since: string | null): Promise<FetchResult> {
    const apps = await this.listAllApplications();
    const candidates = apps
      .filter((a) => a.candidate?.id)
      .map((a) => this.toCandidate(a));
    return { candidates };
  }

  /** Paginates through application.list using Ashby's cursor scheme. */
  private async listAllApplications(): Promise<AshbyApplication[]> {
    const out: AshbyApplication[] = [];
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = { limit: 100 };
      if (cursor) body.cursor = cursor;
      const page = await this.post<AshbyApplication>("application.list", body);
      if (!page.success) {
        throw new Error(`Ashby application.list failed: ${(page.errors ?? []).join(", ")}`);
      }
      out.push(...(page.results ?? []));
      cursor = page.moreDataAvailable ? page.nextCursor : undefined;
    } while (cursor);
    return out;
  }

  private async post<T>(action: string, body: unknown): Promise<AshbyListResponse<T>> {
    const auth = Buffer.from(`${config.ashby.apiKey}:`).toString("base64");
    const res = await fetch(`${config.ashby.baseUrl}/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Ashby ${action} HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as AshbyListResponse<T>;
  }

  private toCandidate(a: AshbyApplication): Candidate {
    const c = a.candidate!;
    const now = new Date().toISOString();
    const lastActivity = a.lastActivityAt ?? a.updatedAt ?? a.createdAt ?? now;
    return {
      id: `ashby:${c.id}`,
      source: "ashby",
      sourceId: c.id,
      name: c.name ?? "(unknown)",
      email: c.primaryEmailAddress?.value ?? null,
      role: a.job?.title ?? null,
      stage: mapStage(a),
      createdAt: a.createdAt ?? now,
      updatedAt: a.updatedAt ?? a.createdAt ?? now,
      lastActivityAt: lastActivity,
      ownerEmail: null,
      raw: a,
    };
  }
}

/** Map Ashby status + stage title into our canonical Stage. Tune for your org. */
export function mapStage(a: AshbyApplication): Stage {
  const status = (a.status ?? "").toLowerCase();
  if (status === "hired") return "hired";
  if (status === "archived") return "archived";

  const title = (a.currentInterviewStage?.title ?? "").toLowerCase();
  if (/offer/.test(title)) return "offer";
  if (/(interview|onsite|technical|panel)/.test(title)) return "interview";
  if (/(screen|recruiter|phone)/.test(title)) return "screen";
  if (/(application|applied|new|review)/.test(title)) return "applied";
  if (/(lead|sourc|prospect)/.test(title)) return "lead";

  // Default: an active application with an unrecognized stage title.
  return "applied";
}
