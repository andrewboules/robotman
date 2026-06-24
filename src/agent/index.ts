/**
 * AGENT ASSEMBLY
 * --------------
 * Wires the real Anthropic client + store + memory into the agent loop and
 * exposes a single `Agent` the Slack layer calls. Keeping construction here
 * means the Slack handler stays a thin adapter.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { getRepository } from "../store/repository.js";
import { InMemoryMemoryStore, type MemoryStore } from "./memory.js";
import { runAgent, type AgentDeps, type AgentReply, type AgentRequest } from "./loop.js";

export class Agent {
  private constructor(private deps: AgentDeps) {}

  static async create(memory: MemoryStore = new InMemoryMemoryStore()): Promise<Agent> {
    if (!config.anthropic.configured) {
      throw new Error("ANTHROPIC_API_KEY is required to run the agent.");
    }
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const repo = await getRepository();
    return new Agent({
      createMessage: (body) => client.messages.create(body),
      repo,
      memory,
    });
  }

  ask(req: AgentRequest): Promise<AgentReply> {
    return runAgent(req, this.deps);
  }
}

export type { AgentRequest, AgentReply } from "./loop.js";
