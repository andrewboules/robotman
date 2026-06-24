/**
 * AGENT TOOLS (read-only, v1)
 * ---------------------------
 * Each tool exposes a capability to Claude with a JSON schema, and a `run`
 * function that executes against the normalized store and returns text + the
 * citations that back it. Adding a capability = add an AgentTool here. When
 * Gmail/Drive/Calendar adapters land, their tools slot in the same way (and
 * will use the requesting user's OAuth token from the TokenStore).
 *
 * v1 tools are read-only by design — no tool can mutate a source system.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Repository } from "../store/repository.js";
import type { AppUser } from "../identity/identity.js";
import type { Candidate, Stage } from "../types.js";
import { ACTIVE_STAGES } from "../types.js";
import { computePipelineMetrics, findStaleCandidates } from "../logic/metrics.js";
import { candidateCitation, candidateUrl, type Citation } from "./citations.js";

export interface ToolContext {
  repo: Repository;
  user: AppUser;
}

export interface ToolResult {
  text: string;
  citations: Citation[];
}

export interface AgentTool {
  def: Anthropic.Tool;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

function describe(c: Candidate): string {
  return [
    `name: ${c.name}`,
    `source: ${c.source}`,
    `role: ${c.role ?? "n/a"}`,
    `stage: ${c.stage}`,
    `owner: ${c.ownerEmail ?? "n/a"}`,
    `last_activity: ${c.lastActivityAt}`,
    `url: ${candidateUrl(c)}`,
  ].join(", ");
}

const searchCandidates: AgentTool = {
  def: {
    name: "search_candidates",
    description:
      "Search candidates and prospects across Ashby and Gem by name, role, stage, or owner. " +
      "Use this to find people before asking for detail. Returns matching records with their " +
      "current stage, owner, last activity, and a source link.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name or role keywords to match (optional)." },
        stage: {
          type: "string",
          description: "Filter to a pipeline stage.",
          enum: ["lead", "applied", "screen", "interview", "offer", "hired", "rejected", "archived"],
        },
        source: { type: "string", description: "Filter to a source.", enum: ["ashby", "gem"] },
        owner_email: { type: "string", description: "Filter to candidates owned by this email." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
    },
  },
  async run(input, ctx) {
    const all = await ctx.repo.allCandidates();
    const q = (input.query as string | undefined)?.toLowerCase().trim();
    const stage = input.stage as Stage | undefined;
    const source = input.source as string | undefined;
    const owner = (input.owner_email as string | undefined)?.toLowerCase();
    const limit = (input.limit as number | undefined) ?? 20;

    let matches = all;
    if (q) matches = matches.filter((c) => `${c.name} ${c.role ?? ""}`.toLowerCase().includes(q));
    if (stage) matches = matches.filter((c) => c.stage === stage);
    if (source) matches = matches.filter((c) => c.source === source);
    if (owner) matches = matches.filter((c) => c.ownerEmail?.toLowerCase() === owner);

    const top = matches.slice(0, limit);
    if (top.length === 0) return { text: "No matching candidates found.", citations: [] };
    return {
      text: `${matches.length} match(es)${matches.length > top.length ? ` (showing ${top.length})` : ""}:\n` +
        top.map(describe).join("\n"),
      citations: top.map(candidateCitation),
    };
  },
};

const getCandidate: AgentTool = {
  def: {
    name: "get_candidate",
    description:
      "Get full detail for one candidate by their id (e.g. 'ashby:123') or exact/near name. " +
      "Use after search_candidates to dig into a specific person.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Candidate id like 'ashby:123' (preferred)." },
        name: { type: "string", description: "Candidate name if id is unknown." },
      },
    },
  },
  async run(input, ctx) {
    const all = await ctx.repo.allCandidates();
    const id = input.id as string | undefined;
    const name = (input.name as string | undefined)?.toLowerCase();
    const found =
      (id && all.find((c) => c.id === id)) ||
      (name && all.find((c) => c.name.toLowerCase().includes(name)));
    if (!found) return { text: "No candidate matched that id or name.", citations: [] };
    const detail = {
      ...found,
      // raw holds the source's full record (timeline, stage history, etc.).
      raw: found.raw ?? "(no raw payload stored)",
    };
    return {
      text: `Candidate detail (JSON):\n${JSON.stringify(detail, null, 2)}`,
      citations: [candidateCitation(found)],
    };
  },
};

const pipelineMetrics: AgentTool = {
  def: {
    name: "pipeline_metrics",
    description:
      "Get counts of candidates by pipeline stage and the active total across Ashby and Gem. " +
      "Use for questions like 'how's the pipeline' or 'how many in interview'.",
    input_schema: { type: "object", properties: {} },
  },
  async run(_input, ctx) {
    const m = computePipelineMetrics(await ctx.repo.allCandidates());
    return { text: `Pipeline metrics (JSON):\n${JSON.stringify(m, null, 2)}`, citations: [] };
  },
};

const findStale: AgentTool = {
  def: {
    name: "find_stale_candidates",
    description:
      "List active-stage candidates with no activity for N+ days (default 7). Use for " +
      "'who is stuck', 'who needs follow up', 'what slipped'. Returns most-stale first.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Inactivity threshold in days (default 7)." },
        owner_email: { type: "string", description: "Limit to a specific owner." },
      },
    },
  },
  async run(input, ctx) {
    const days = (input.days as number | undefined) ?? 7;
    const owner = (input.owner_email as string | undefined)?.toLowerCase();
    let candidates = await ctx.repo.allCandidates();
    if (owner) candidates = candidates.filter((c) => c.ownerEmail?.toLowerCase() === owner);
    const stale = findStaleCandidates(candidates, days);
    if (stale.length === 0) {
      return { text: `No candidates inactive for ${days}+ days in stages: ${ACTIVE_STAGES.join(", ")}.`, citations: [] };
    }
    return {
      text:
        `${stale.length} stale (${days}+ days):\n` +
        stale.map((s) => `${describe(s.candidate)}, days_inactive: ${s.daysInactive}`).join("\n"),
      citations: stale.map((s) => candidateCitation(s.candidate)),
    };
  },
};

export const tools: AgentTool[] = [searchCandidates, getCandidate, pipelineMetrics, findStale];

export const toolDefs: Anthropic.Tool[] = tools.map((t) => t.def);
export const toolByName: Map<string, AgentTool> = new Map(tools.map((t) => [t.def.name, t]));
