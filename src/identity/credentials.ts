/**
 * PER-USER CREDENTIALS (encrypted)
 * --------------------------------
 * Lets each recruiter connect their own API keys (Ashby, Gem, Granola, …)
 * instead of sharing one org key. Keys are collected via a Slack modal (not a
 * chat message) and stored ENCRYPTED at rest with AES-256-GCM, keyed by Slack
 * user + provider.
 *
 * The encryption key comes from CREDENTIAL_ENC_KEY (any strong random string;
 * we derive a 32-byte key from it via SHA-256). Rotating that env value makes
 * existing stored secrets undecryptable, so set it once and keep it safe.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import type { Repository } from "../store/repository.js";

function keyBuffer(secret: string): Buffer {
  return createHash("sha256").update(secret).digest(); // 32 bytes
}

/** Returns `iv.tag.ciphertext`, all base64. */
export function encryptSecret(plaintext: string, encKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer(encKey), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(token: string, encKey: string): string {
  const [ivB, tagB, ctB] = token.split(".");
  if (!ivB || !tagB || !ctB) throw new Error("Malformed credential ciphertext.");
  const decipher = createDecipheriv("aes-256-gcm", keyBuffer(encKey), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export interface ConnectionInfo {
  provider: string;
  baseUrl: string | null;
}

export interface ResolvedCredential {
  baseUrl: string | null;
  secret: string; // decrypted API key
}

export class CredentialService {
  constructor(
    private repo: Repository,
    private encKey: string
  ) {}

  /** False when CREDENTIAL_ENC_KEY is unset; connect features are disabled then. */
  get enabled(): boolean {
    return Boolean(this.encKey);
  }

  async set(slackUserId: string, provider: string, baseUrl: string | null, secret: string): Promise<void> {
    if (!this.encKey) throw new Error("CREDENTIAL_ENC_KEY is not set — cannot store credentials.");
    await this.repo.upsertCredential({
      slackUserId,
      provider: provider.toLowerCase().trim(),
      baseUrl: baseUrl?.trim() || null,
      secretCipher: encryptSecret(secret, this.encKey),
    });
  }

  async get(slackUserId: string, provider: string): Promise<ResolvedCredential | null> {
    if (!this.encKey) return null;
    const row = await this.repo.getCredentialRow(slackUserId, provider.toLowerCase().trim());
    if (!row) return null;
    return { baseUrl: row.baseUrl, secret: decryptSecret(row.secretCipher, this.encKey) };
  }

  async list(slackUserId: string): Promise<ConnectionInfo[]> {
    return this.repo.listCredentials(slackUserId);
  }

  async remove(slackUserId: string, provider: string): Promise<void> {
    await this.repo.deleteCredential(slackUserId, provider.toLowerCase().trim());
  }
}
