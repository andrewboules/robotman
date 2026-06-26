/**
 * GOOGLE API HELPERS (Gmail / Calendar / Drive)
 * ---------------------------------------------
 * Thin wrappers used by the agent's Google tools. All take a valid access token
 * (the GoogleAuth class handles refresh upstream). Reads are generic GETs across
 * *.googleapis.com; the one write we expose is Gmail send, gated by Slack
 * confirmation in the action layer.
 *
 * GCal helpers:
 *   gcalListEvents   — list events in a time window, optional free-text search
 *   gcalFindSlots    — find free/busy gaps across a window for scheduling
 *
 * Drive helpers:
 *   driveSearch      — search files by name/full-text, returns metadata list
 *   driveReadFile    — export/download a file as text, CSV, or base64 (PDF)
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

// ---------------------------------------------------------------------------
// Google Calendar helpers
// ---------------------------------------------------------------------------

export interface CalEvent {
  id: string;
  summary: string;
  start: string;   // ISO datetime or date
  end: string;
  attendees: string[];
  location: string | null;
  description: string | null;
  htmlLink: string;
  /** Google Meet or video call link extracted from conferenceData / hangoutLink. */
  meetLink: string | null;
}

export interface FreeBusySlot {
  start: string;
  end: string;
  durationMinutes: number;
}

function parseCalEvents(raw: unknown): CalEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const items = (raw as { items?: unknown[] }).items ?? [];
  return items
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map((it) => ({
      id: String(it["id"] ?? ""),
      summary: String(it["summary"] ?? "(no title)"),
      start: String(
        (it["start"] as Record<string, string> | undefined)?.dateTime ??
        (it["start"] as Record<string, string> | undefined)?.date ?? ""
      ),
      end: String(
        (it["end"] as Record<string, string> | undefined)?.dateTime ??
        (it["end"] as Record<string, string> | undefined)?.date ?? ""
      ),
      attendees: ((it["attendees"] as { email?: string }[] | undefined) ?? [])
        .map((a) => a.email ?? "")
        .filter(Boolean),
      location: it["location"] ? String(it["location"]) : null,
      description: it["description"] ? String(it["description"]) : null,
      htmlLink: String(it["htmlLink"] ?? ""),
      meetLink: (() => {
        // Try conferenceData.entryPoints first, then legacy hangoutLink.
        const cd = it["conferenceData"] as Record<string, unknown> | undefined;
        if (cd) {
          const eps = (cd["entryPoints"] as { entryPointType?: string; uri?: string }[] | undefined) ?? [];
          const video = eps.find((ep) => ep.entryPointType === "video");
          if (video?.uri) return video.uri;
        }
        if (it["hangoutLink"]) return String(it["hangoutLink"]);
        return null;
      })(),
    }));
}

/**
 * List calendar events in [timeMin, timeMax]. Optional `q` does a full-text
 * search across summary, description, location, and attendees.
 */
export async function gcalListEvents(
  accessToken: string,
  opts: {
    calendarId?: string;
    timeMin: string;   // ISO
    timeMax: string;   // ISO
    q?: string;
    maxResults?: number;
  }
): Promise<{ events: CalEvent[]; status: number }> {
  const calId = encodeURIComponent(opts.calendarId ?? "primary");
  const params = new URLSearchParams({
    timeMin: opts.timeMin,
    timeMax: opts.timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(opts.maxResults ?? 50),
  });
  if (opts.q) params.set("q", opts.q);

  const url = resolveGoogleUrl(
    `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?${params}`
  );
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    return { events: [], status: res.status };
  }
  const json = await res.json();
  return { events: parseCalEvents(json), status: res.status };
}

/**
 * Find free slots in the user's primary calendar within a window. Returns gaps
 * of at least `minMinutes` duration between busy periods.
 */
export async function gcalFindSlots(
  accessToken: string,
  opts: {
    timeMin: string;      // ISO
    timeMax: string;      // ISO
    minMinutes?: number;  // default 30
  }
): Promise<{ slots: FreeBusySlot[]; status: number }> {
  const minMs = (opts.minMinutes ?? 30) * 60_000;
  const url = resolveGoogleUrl("https://www.googleapis.com/calendar/v3/freeBusy");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      items: [{ id: "primary" }],
    }),
  });
  if (!res.ok) return { slots: [], status: res.status };

  const json = (await res.json()) as {
    calendars?: { primary?: { busy?: { start: string; end: string }[] } };
  };
  const busy = json.calendars?.primary?.busy ?? [];

  // Build free windows between busy blocks.
  const windowStart = new Date(opts.timeMin).getTime();
  const windowEnd = new Date(opts.timeMax).getTime();
  const slots: FreeBusySlot[] = [];

  let cursor = windowStart;
  for (const block of busy) {
    const blockStart = new Date(block.start).getTime();
    const gap = blockStart - cursor;
    if (gap >= minMs) {
      slots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(blockStart).toISOString(),
        durationMinutes: Math.floor(gap / 60_000),
      });
    }
    cursor = Math.max(cursor, new Date(block.end).getTime());
  }
  // Trailing free time after last busy block.
  if (windowEnd - cursor >= minMs) {
    slots.push({
      start: new Date(cursor).toISOString(),
      end: new Date(windowEnd).toISOString(),
      durationMinutes: Math.floor((windowEnd - cursor) / 60_000),
    });
  }

  return { slots, status: res.status };
}

// ---------------------------------------------------------------------------
// Calendar — create event
// ---------------------------------------------------------------------------

export interface CalEventInput {
  summary: string;
  start: string;          // ISO datetime
  end: string;            // ISO datetime
  attendees?: string[];   // email addresses
  description?: string;
  location?: string;
  addMeetLink?: boolean;  // if true, request a Google Meet conference
  calendarId?: string;
}

export interface CreatedCalEvent {
  id: string;
  htmlLink: string;
  meetLink: string | null;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
}

/**
 * Create a Google Calendar event on the user's primary (or specified) calendar.
 * Optionally attaches a Google Meet conference link.
 */
export async function gcalCreateEvent(
  accessToken: string,
  input: CalEventInput
): Promise<{ event: CreatedCalEvent | null; status: number; error?: string }> {
  const calId = encodeURIComponent(input.calendarId ?? "primary");
  const url = resolveGoogleUrl(
    `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?sendUpdates=all`
  );

  const body: Record<string, unknown> = {
    summary: input.summary,
    start: { dateTime: input.start, timeZone: "UTC" },
    end: { dateTime: input.end, timeZone: "UTC" },
  };

  if (input.attendees?.length) {
    body["attendees"] = input.attendees.map((email) => ({ email }));
  }
  if (input.description) body["description"] = input.description;
  if (input.location) body["location"] = input.location;
  if (input.addMeetLink) {
    body["conferenceData"] = {
      createRequest: {
        requestId: `robotman-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const res = await fetch(
    input.addMeetLink
      ? `${url.toString()}&conferenceDataVersion=1`
      : url.toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { event: null, status: res.status, error: detail.slice(0, 400) };
  }

  const json = (await res.json()) as Record<string, unknown>;

  // Extract Meet link from conferenceData if present.
  let meetLink: string | null = null;
  const cd = json["conferenceData"] as Record<string, unknown> | undefined;
  if (cd) {
    const eps = (cd["entryPoints"] as { entryPointType?: string; uri?: string }[] | undefined) ?? [];
    const video = eps.find((ep) => ep.entryPointType === "video");
    meetLink = video?.uri ?? null;
  }

  const startRaw = json["start"] as Record<string, string> | undefined;
  const endRaw = json["end"] as Record<string, string> | undefined;

  return {
    event: {
      id: String(json["id"] ?? ""),
      htmlLink: String(json["htmlLink"] ?? ""),
      meetLink,
      summary: String(json["summary"] ?? input.summary),
      start: startRaw?.dateTime ?? startRaw?.date ?? input.start,
      end: endRaw?.dateTime ?? endRaw?.date ?? input.end,
      attendees: ((json["attendees"] as { email?: string }[] | undefined) ?? [])
        .map((a) => a.email ?? "")
        .filter(Boolean),
    },
    status: res.status,
  };
}

// ---------------------------------------------------------------------------
// Google Drive helpers
// ---------------------------------------------------------------------------

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  webViewLink: string | null;
  size: number | null;
}

/** MIME types Google exports native Workspace files as. */
const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document":     "text/plain",
  "application/vnd.google-apps.spreadsheet":  "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

/** Max bytes we'll read from Drive before truncating (keeps tool output sane). */
const DRIVE_READ_LIMIT = 8_000;

export async function driveSearch(
  accessToken: string,
  opts: { q: string; maxResults?: number }
): Promise<{ files: DriveFileMeta[]; status: number }> {
  // Drive query: name contains 'X' OR fullText contains 'X', not trashed.
  const qParts = [
    `(name contains '${opts.q.replace(/'/g, "\\'")}' OR fullText contains '${opts.q.replace(/'/g, "\\'")}')`,
    "trashed = false",
  ];
  const params = new URLSearchParams({
    q: qParts.join(" and "),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
    pageSize: String(opts.maxResults ?? 20),
    orderBy: "modifiedTime desc",
  });

  const url = resolveGoogleUrl(`https://www.googleapis.com/drive/v3/files?${params}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) return { files: [], status: res.status };

  const json = (await res.json()) as { files?: Record<string, unknown>[] };
  const files: DriveFileMeta[] = (json.files ?? []).map((f) => ({
    id: String(f["id"] ?? ""),
    name: String(f["name"] ?? ""),
    mimeType: String(f["mimeType"] ?? ""),
    modifiedTime: f["modifiedTime"] ? String(f["modifiedTime"]) : null,
    webViewLink: f["webViewLink"] ? String(f["webViewLink"]) : null,
    size: f["size"] != null ? Number(f["size"]) : null,
  }));
  return { files, status: res.status };
}

export interface DriveFileContent {
  id: string;
  name: string;
  mimeType: string;
  content: string;       // text for Docs/Sheets/text files, base64 for PDFs
  encoding: "text" | "base64";
  truncated: boolean;
  webViewLink: string | null;
}

/**
 * Read a Drive file. Google Workspace types (Docs, Sheets, Slides) are exported
 * as plain text / CSV. PDFs and other binaries are returned base64-encoded up to
 * DRIVE_READ_LIMIT bytes so the agent can describe them without choking.
 */
export async function driveReadFile(
  accessToken: string,
  fileId: string
): Promise<{ file: DriveFileContent | null; status: number; error?: string }> {
  // First fetch file metadata to know the MIME type and name.
  const metaUrl = resolveGoogleUrl(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink`
  );
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!metaRes.ok) {
    return { file: null, status: metaRes.status, error: await metaRes.text() };
  }
  const meta = (await metaRes.json()) as { id: string; name: string; mimeType: string; webViewLink?: string };

  const exportMime = EXPORT_MIME[meta.mimeType];

  let contentUrl: URL;
  if (exportMime) {
    // Google Workspace file — use the export endpoint.
    contentUrl = resolveGoogleUrl(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`
    );
  } else {
    // Binary or plain file — use the download endpoint.
    contentUrl = resolveGoogleUrl(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`
    );
  }

  const contentRes = await fetch(contentUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!contentRes.ok) {
    return { file: null, status: contentRes.status, error: await contentRes.text() };
  }

  const isPdf = meta.mimeType === "application/pdf" || (!exportMime && meta.mimeType.startsWith("application/"));
  const buffer = Buffer.from(await contentRes.arrayBuffer());

  let content: string;
  let encoding: "text" | "base64";
  let truncated = false;

  if (isPdf || (!exportMime && !meta.mimeType.startsWith("text/"))) {
    // Binary: return base64, capped at limit.
    const slice = buffer.slice(0, DRIVE_READ_LIMIT);
    content = slice.toString("base64");
    truncated = buffer.length > DRIVE_READ_LIMIT;
    encoding = "base64";
  } else {
    // Text-like: return UTF-8, capped at limit.
    const text = buffer.toString("utf8");
    content = text.length > DRIVE_READ_LIMIT ? text.slice(0, DRIVE_READ_LIMIT) : text;
    truncated = text.length > DRIVE_READ_LIMIT;
    encoding = "text";
  }

  return {
    file: {
      id: meta.id,
      name: meta.name,
      mimeType: meta.mimeType,
      content,
      encoding,
      truncated,
      webViewLink: meta.webViewLink ?? null,
    },
    status: contentRes.status,
  };
}
