/**
 * GOOGLE API HELPERS (Gmail / Calendar / Drive)
 * ---------------------------------------------
 * Thin wrappers used by the agent's Google tools. All take a valid access token
 * (the GoogleAuth class handles refresh upstream). Reads are generic GETs across
 * *.googleapis.com; the one write we expose is Gmail send, gated by Slack
 * confirmation in the action layer.
 */

export interface GmailDraft {
  to: string;
  subject: string;
  body: string;
  cc?: string;
}

const GOOGLE_HOST_SUFFIX = ".googleapis.com";

/** Restrict reads to Google's API hosts; HTTPS only. */
export function resolveGoogleUrl(path: string): URL {
  const url = /^https?:\/\//i.test(path)
    ? new URL(path)
    : new URL(path.replace(/^\//, ""), "https://www.googleapis.com/");
  if (url.protocol !== "https:") throw new Error("Only https requests are allowed.");
  if (!(url.host === "www.googleapis.com" || url.host.endsWith(GOOGLE_HOST_SUFFIX))) {
    throw new Error(`Refusing to call ${url.host}; only *.googleapis.com is allowed.`);
  }
  return url;
}

export async function googleApiGet(accessToken: string, path: string): Promise<{ status: number; body: string; url: string }> {
  const url = resolveGoogleUrl(path);
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const raw = await res.text();
  const body = raw.length > 6000 ? raw.slice(0, 6000) + "\n…[truncated]" : raw;
  return { status: res.status, body, url: `${url.origin}${url.pathname}` };
}

/** Build a base64url-encoded RFC 5322 message for the Gmail send endpoint. */
export function buildRawMessage(draft: GmailDraft): string {
  const headers = [
    `To: ${draft.to}`,
    draft.cc ? `Cc: ${draft.cc}` : null,
    `Subject: ${draft.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean);
  const mime = `${headers.join("\r\n")}\r\n\r\n${draft.body}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}

export async function sendGmail(accessToken: string, draft: GmailDraft): Promise<{ ok: boolean; status: number; detail: string }> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: buildRawMessage(draft) }),
  });
  const detail = await res.text();
  return { ok: res.ok, status: res.status, detail };
}
