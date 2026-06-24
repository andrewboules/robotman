/**
 * CONVERSATION MEMORY
 * -------------------
 * Keeps recent turns per conversation so the agent remembers context within a
 * DM/thread ("what about the second one?"). Keyed by Slack channel + thread.
 *
 * v1 is in-memory (per process) with a turn cap. It's defined behind an
 * interface so production can swap in Redis (per the spec) or Postgres without
 * touching the agent loop. Memory is lost on restart in v1 — acceptable for a
 * single always-on instance; revisit before horizontal scaling.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type ConversationKey = string; // `${channel}:${threadTs ?? "dm"}`

export function conversationKey(channel: string, threadTs?: string | null): ConversationKey {
  return `${channel}:${threadTs ?? "dm"}`;
}

export interface MemoryStore {
  history(key: ConversationKey): Promise<Anthropic.MessageParam[]>;
  append(key: ConversationKey, messages: Anthropic.MessageParam[]): Promise<void>;
  clear(key: ConversationKey): Promise<void>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private map = new Map<ConversationKey, Anthropic.MessageParam[]>();
  /** Max stored messages per conversation (user+assistant turns). */
  constructor(private maxMessages = 20) {}

  async history(key: ConversationKey): Promise<Anthropic.MessageParam[]> {
    return this.map.get(key) ?? [];
  }

  async append(key: ConversationKey, messages: Anthropic.MessageParam[]): Promise<void> {
    const existing = this.map.get(key) ?? [];
    const next = [...existing, ...messages];
    // Keep only the most recent turns to bound token usage.
    this.map.set(key, next.slice(-this.maxMessages));
  }

  async clear(key: ConversationKey): Promise<void> {
    this.map.delete(key);
  }
}
