/**
 * USER CONTEXT SERVICE
 * --------------------
 * Per-user persistent key-value store for preferences, active client,
 * and session carry-forward. Keyed by Slack user ID.
 *
 * Agents append [PERSIST: key=value] tags to their responses to signal
 * that a value should be saved. The Slack layer strips these tags,
 * saves them here, and they appear in the system prompt on the next
 * session as {PERSISTENT_USER_CONTEXT}.
 */
import type { Repository } from "../store/repository.js";

export class UserContextService {
  constructor(private repo: Repository) {}

  async get(slackUserId: string): Promise<Record<string, string>> {
    return this.repo.getUserContext(slackUserId);
  }

  async set(slackUserId: string, key: string, value: string): Promise<void> {
    return this.repo.setUserContext(slackUserId, key, value);
  }

  async setMany(slackUserId: string, pairs: { key: string; value: string }[]): Promise<void> {
    await Promise.all(pairs.map((p) => this.set(slackUserId, p.key, p.value)));
  }

  /** Format context for injection into the system prompt. */
  format(ctx: Record<string, string>): string {
    const entries = Object.entries(ctx);
    if (entries.length === 0) return "(no persistent context stored yet)";
    return entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
  }
}

/**
 * Parse [PERSIST: key=value] tags from an LLM response.
 * Tags are case-insensitive and whitespace-tolerant.
 * Example: "[PERSIST: active_client=BullMoose]"
 */
export function parsePersistTags(text: string): { key: string; value: string }[] {
  const pattern = /\[PERSIST:\s*([^=\]]+?)\s*=\s*([^\]]*?)\s*\]/gi;
  const results: { key: string; value: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    results.push({ key: match[1].trim(), value: match[2].trim() });
  }
  return results;
}

/** Remove [PERSIST: ...] tags from text before displaying to the user. */
export function stripPersistTags(text: string): string {
  return text.replace(/\s*\[PERSIST:\s*[^\]]+\]/gi, "").trim();
}
