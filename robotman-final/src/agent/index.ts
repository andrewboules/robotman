/**
 * AGENT ASSEMBLY
 * --------------
 * Wires the real Anthropic client + store + memory + credentials into the agent
 * loop and exposes a single `Agent` the Slack layer calls. Keeping construction
 * here means the Slack handler stays a thin adapter.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { getRepository } from "../store/repository.js";
import { CredentialService } from "../identity/credentials.js";
import { GoogleAuth } from "../google/oauth.js";
import { GranolaAuth } from "../granola/oauth.js";
import { SlackWorkspaceAuth } from "../slack/workspace-oauth.js";
import { UserContextService } from "../identity/user-context.js";
import { InMemoryMemoryStore, type MemoryStore } from "./memory.js";
import { runAgent, type AgentDeps, type AgentReply, type AgentRequest } from "./loop.js";

export class Agent {
  private constructor(private deps: AgentDeps) {}

  static async create(
    credentials?: CredentialService,
    memory: MemoryStore = new InMemoryMemoryStore(),
    slackClient?: WebClient | null,
    slackWorkspaceAuth?: SlackWorkspaceAuth | null,
    _userContextService?: UserContextService | null  // reserved for future use
  ): Promise<Agent> {
    if (!config.anthropic.configured) {
      throw new Error("ANTHROPIC_API_KEY is required to run the agent.");
    }
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const repo = await getRepository();
    const creds = credentials ?? new CredentialService(repo, config.credentialEncKey);
    const google = config.google.configured ? new GoogleAuth(creds) : null;
    const granolaAuth = creds.enabled ? new GranolaAuth(creds) : null;
    return new Agent({
      createMessage: (body) => client.messages.create(body),
      repo,
      memory,
      credentials: creds,
      google,
      granolaAuth,
      slackClient: slackClient ?? null,
      slackWorkspaceAuth: slackWorkspaceAuth ?? null,
    });
  }

  ask(req: AgentRequest): Promise<AgentReply> {
    return runAgent(req, this.deps);
  }
}

export type { AgentRequest, AgentReply } from "./loop.js";
