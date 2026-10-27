import type { Transport } from "./transport.js";
import type { FilesService } from "./files.js";

// App handoff: one app hands files to another (canvas → video editor),
// the other may send a result back. Apps run on separate origins with
// COOP, so the two pages cannot talk: the files travel as signed links
// (files.url — readable by anyone holding them, for a while) in the URL
// fragment of the app being opened, and a result comes back through
// `<sender>/__runapps/handoff.html`, a platform page on the sender's own
// origin that stores it in the sender's localStorage. Which apps take
// what comes from their bundle.json (`receives`), via GET
// /v1/apps/receivers.

/** What an app can be handed, as its bundle.json declares it. */
export type HandoffAction = "open" | "edit";

/** An app that takes a file type (`client.apps.receivers`). */
export interface ReceiverApp {
  slug: string;
  name: string;
  icon_url: string;
  /** Where the app runs (https://<slug>.runapps.dev). */
  url: string;
  /** The actions it offers for the type: "edit", "open". */
  actions: HandoffAction[];
  /** An edit sends its result back to the sender. */
  reply: boolean;
}

/** A file in a handoff: a signed (or public) link and what it is. */
export interface HandoffFile {
  url: string;
  name: string;
  type: string;
  size?: number;
}

/** A file to hand over: a path in this app's storage, a Blob, or a URL
 *  on the files host this app already holds (a signed or public link). */
export type HandoffSource =
  | { path: string; name?: string; type?: string }
  | { blob: Blob; name: string; type?: string }
  | { url: string; name: string; type?: string; size?: number };

export interface SendOptions {
  files: HandoffSource[];
  /** "edit" (default) asks for the result back; "open" just hands over. */
  action?: HandoffAction;
  /** Anything JSON the sender wants back with the result (e.g. which
   *  canvas node the file came from). Stays in this app; not sent. */
  context?: unknown;
}

/** A result sent back to this app (`client.apps.onResult`). */
export interface HandoffResult {
  id: string;
  /** The app that sent it (slug). */
  from: string;
  files: HandoffFile[];
  /** The context given to `send`. */
  context: unknown;
  /** The app the files were sent to and the action asked. */
  to: string;
  action: HandoffAction;
}

/** The handoff this app was opened with (`client.apps.incoming`). */
export interface IncomingHandoff {
  id: string;
  /** The sending app (slug). */
  from: string;
  action: HandoffAction;
  files: HandoffFile[];
  /** The sender wants the result back (`reply`). */
  canReply: boolean;
  /** The app has already taken the files in (see `markImported`). */
  imported: boolean;
  /** Copy file `index` into this app's storage at `path`, server side
   *  (the bytes do not pass through the browser). */
  importTo(path: string, index?: number): Promise<import("./files.js").FileObject>;
  /** Download file `index`. */
  blob(index?: number): Promise<Blob>;
  /** Record that the files were taken in, so a reload of the page does
   *  not take them in again. The reply stays possible. */
  markImported(): void;
  /** The sending app's name and icon, for "Send back to …". */
  fromApp(): Promise<{ name: string; icon_url: string }>;
  /**
   * Send the result back to the sender. Call it straight from the click
   * that asks for it: it opens a small window on the sender's origin,
   * which needs the user gesture. Blobs are stored in this app first
   * (`handoff/<id>/<name>`) and handed back as signed links.
   */
  reply(files: HandoffSource[]): Promise<void>;
  /** Forget the handoff (the user declined it, or it is done). */
  dismiss(): void;
}

// ── Pure helpers (exported for tests) ───────────────────────────────────

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_FILES = 20;
const HASH_PARAM = "runapps_handoff";
const PENDING_PREFIX = "runapps_handoff:";
const RESULT_PREFIX = "runapps_handoff_result:";
const INCOMING_KEY = "runapps_handoff_incoming";
const KEEP_MS = 7 * 24 * 3600 * 1000;
/** How long handed-over links stay readable. */
const SEND_LINK_SECONDS = 3600;
const REPLY_LINK_SECONDS = 24 * 3600;

/** The wire form of a handoff, in the receiving app's URL fragment. */
export interface HandoffPayload {
  v: 1;
  id: string;
  from: string;
  /** Where to send a result: the sender's origin. */
  reply_to?: string;
  action: HandoffAction;
  files: HandoffFile[];
}

/** The wire form of a result, in the callback page's URL fragment. */
export interface ResultPayload {
  v: 1;
  id: string;
  from: string;
  files: HandoffFile[];
}

export function encodeHandoff(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeHandoff(s: string): unknown {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** The slug of an app page's own host, or "" off the platform's hosts
 *  (`<slug>.runapps.dev`, or `<slug>.localhost` in local development). */
export function appSlugOf(hostname: string): string {
  const m = /^([a-z0-9-]+)\.(runapps\.dev|localhost)$/i.exec(hostname);
  return m && SLUG.test(m[1]!.toLowerCase()) ? m[1]!.toLowerCase() : "";
}

/** Where another app runs, seen from this page: the same scheme, domain
 *  and port, with that app's slug as the subdomain. */
export function appOriginFrom(pageOrigin: string, slug: string): string {
  const u = new URL(pageOrigin);
  if (/\.localhost$/i.test(u.hostname) || u.hostname === "localhost") {
    return `http://${slug}.localhost${u.port ? ":" + u.port : ":8080"}`;
  }
  return `https://${slug}.runapps.dev`;
}

/** Whether an origin is an app host (the only places a result may go). */
export function isAppOrigin(origin: string): boolean {
  return /^https:\/\/[a-z0-9-]+\.runapps\.dev$/.test(origin) || /^http:\/\/[a-z0-9-]+\.localhost(:\d+)?$/.test(origin);
}

/** Whether a handed-over link points at the platform's files host (or,
 *  from a local app page, the local backend). */
export function isFilesURL(url: string, local: boolean): boolean {
  if (/^https:\/\/files\.runapps\.ai\/(f|s)\/[^\s]+$/.test(url)) return true;
  return local && /^http:\/\/localhost(:\d+)?\/(f|s)\/[^\s]+$/.test(url);
}

function cleanFiles(files: unknown, local: boolean): HandoffFile[] | null {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return null;
  const out: HandoffFile[] = [];
  for (const f of files) {
    if (!f || typeof f !== "object") return null;
    const { url, name, type, size } = f as Record<string, unknown>;
    if (typeof url !== "string" || !isFilesURL(url, local)) return null;
    const safeName = typeof name === "string" ? name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) : "";
    out.push({
      url,
      name: safeName || "file",
      type: typeof type === "string" ? type.slice(0, 120) : "",
      ...(typeof size === "number" && size >= 0 ? { size } : {}),
    });
  }
  return out;
}

/** Validates a handoff as it arrives; null when anything is off. */
export function parseHandoffPayload(raw: unknown, local: boolean): HandoffPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1 || typeof p.id !== "string" || !ID.test(p.id)) return null;
  if (typeof p.from !== "string" || !SLUG.test(p.from)) return null;
  const action = p.action === "open" ? "open" : p.action === "edit" ? "edit" : null;
  if (!action) return null;
  const files = cleanFiles(p.files, local);
  if (!files) return null;
  let replyTo: string | undefined;
  if (typeof p.reply_to === "string" && isAppOrigin(p.reply_to) && appSlugOf(new URL(p.reply_to).hostname) === p.from) {
    replyTo = p.reply_to;
  }
  return { v: 1, id: p.id, from: p.from, action, files, ...(replyTo ? { reply_to: replyTo } : {}) };
}

/** Validates a result read back from localStorage. */
export function parseResultPayload(raw: unknown, local: boolean): ResultPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1 || typeof p.id !== "string" || !ID.test(p.id)) return null;
  if (typeof p.from !== "string" || !SLUG.test(p.from)) return null;
  const files = cleanFiles(p.files, local);
  if (!files) return null;
  return { v: 1, id: p.id, from: p.from, files };
}

function newId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ── Browser storage helpers ─────────────────────────────────────────────

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* full or blocked */ }
}
function lsDel(key: string): void {
  try { localStorage.removeItem(key); } catch { /* blocked */ }
}
function lsKeys(prefix: string): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
  } catch { /* blocked */ }
  return out;
}

/**
 * Reads a handoff from this page's URL fragment, before anything else
 * touches the fragment, and removes it from the address bar (other
 * fragment parameters stay). It is kept in sessionStorage so a reload, or
 * a sign-in that redirects the whole page, does not lose it. Called by
 * the client constructor; null when the page was not opened with one.
 */
export function takeIncomingHandoff(): HandoffPayload | null {
  if (typeof window === "undefined" || typeof location === "undefined" || typeof location.hash !== "string") return null;
  const local = /\.localhost$/i.test(location.hostname);
  const hash = location.hash.replace(/^#/, "");
  if (hash) {
    const parts = hash.split("&");
    const i = parts.findIndex((p) => p.startsWith(HASH_PARAM + "="));
    if (i >= 0) {
      const raw = parts[i]!.slice(HASH_PARAM.length + 1);
      parts.splice(i, 1);
      try {
        history.replaceState(history.state, "", location.pathname + location.search + (parts.length ? "#" + parts.join("&") : ""));
      } catch { /* sandboxed */ }
      let payload: HandoffPayload | null = null;
      try { payload = parseHandoffPayload(decodeHandoff(decodeURIComponent(raw)), local); } catch { payload = null; }
      if (payload) {
        try { sessionStorage.setItem(INCOMING_KEY, JSON.stringify({ payload, imported: false })); } catch { /* blocked */ }
        return payload;
      }
    }
  }
  try {
    const kept = sessionStorage.getItem(INCOMING_KEY);
    if (kept) return parseHandoffPayload(JSON.parse(kept).payload, local);
  } catch { /* blocked or broken */ }
  return null;
}

// ── The service ─────────────────────────────────────────────────────────

/**
 * App handoff: hand files to another app on the platform, take what
 * another app handed this one, and send results back.
 *
 * ```ts
 * // Sender: which apps edit a video, then hand one over.
 * const apps = await client.apps.receivers({ type: "video/mp4", action: "edit" });
 * button.onclick = () => client.apps.send(apps[0].slug, {
 *   files: [{ path: "clips/a.mp4" }], context: { nodeId },
 * });
 * client.apps.onResult(async (r) => {
 *   await client.files.putFromURL("clips/a-edited.mp4", r.files[0].url);
 * });
 *
 * // Receiver: the app was opened with files.
 * const inc = client.apps.incoming;
 * if (inc && !inc.imported) { await inc.importTo("in/" + inc.files[0].name); inc.markImported(); }
 * sendBack.onclick = () => inc.reply([{ blob: edited, name: "edited.mp4" }]);
 * ```
 *
 * An app declares what it takes in its bundle.json:
 * `{"receives": [{"types": ["video/*"], "action": "edit", "reply": true}]}`.
 */
export class AppsService {
  /** The handoff this page was opened with, or null. */
  readonly incoming: IncomingHandoff | null;
  private readonly local: boolean;
  private resultHandlers: ((r: HandoffResult) => unknown)[] = [];
  private delivering = new Set<string>();

  constructor(
    private transport: Transport,
    private files: FilesService,
    private readonly project: string | undefined,
    private readonly signedIn: () => boolean,
    payload: HandoffPayload | null,
  ) {
    this.local = typeof location !== "undefined" && /\.localhost$/i.test(location.hostname);
    this.incoming = payload ? this.makeIncoming(payload) : null;
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      this.prune();
      window.addEventListener("storage", (e) => {
        if (e.key && e.key.startsWith(RESULT_PREFIX) && e.newValue) this.deliver(e.key.slice(RESULT_PREFIX.length));
      });
    }
  }

  /** This app's slug: its host's subdomain, else the `project` option. */
  get self(): string {
    const fromHost = typeof location !== "undefined" ? appSlugOf(location.hostname) : "";
    return fromHost || this.project || "";
  }

  /**
   * The apps that take a file type, as their bundles declare, in library
   * order and the page's language; this app is left out. Signed in, the
   * list also has the unlisted apps the user has.
   */
  async receivers(opts: { type: string; action?: HandoffAction; signal?: AbortSignal }): Promise<ReceiverApp[]> {
    const q = new URLSearchParams({ type: opts.type });
    if (opts.action) q.set("action", opts.action);
    const lang = typeof document !== "undefined" ? (document.documentElement.lang || navigator.language || "") : "";
    if (/^zh/i.test(lang)) q.set("lang", "zh");
    const path = "/v1/apps/receivers?" + q.toString();
    const init = opts.signal ? { signal: opts.signal } : undefined;
    const r = this.signedIn()
      ? await this.transport.getJSON<{ data: ReceiverApp[] }>(path, init)
      : await this.transport.getPublicJSON<{ data: ReceiverApp[] }>(path, init);
    const self = this.self;
    return (r.data || []).filter((a) => a.slug !== self);
  }

  /**
   * Hand files to another app: it opens in a new tab with them. Call it
   * straight from the click that asks for it (a new tab needs the user
   * gesture); the window is opened first and pointed at the app once the
   * links are signed. With action "edit" the app can send a result back,
   * which arrives through `onResult` with `context`.
   */
  async send(to: string, opts: SendOptions): Promise<{ id: string }> {
    if (!SLUG.test(to)) throw new Error("RunApps: send: not an app slug: " + to);
    if (!opts.files?.length || opts.files.length > MAX_FILES) throw new Error(`RunApps: send: 1–${MAX_FILES} files`);
    const action: HandoffAction = opts.action ?? "edit";
    const id = newId();
    const win = openBlank("_blank");
    try {
      const files = await this.prepare(id, opts.files, SEND_LINK_SECONDS);
      const self = this.self;
      const pageOrigin = location.origin;
      const payload: HandoffPayload = {
        v: 1, id, from: self || "app", action, files,
        ...(self && isAppOrigin(pageOrigin) ? { reply_to: pageOrigin } : {}),
      };
      lsSet(PENDING_PREFIX + id, JSON.stringify({ to, action, context: opts.context ?? null, at: Date.now() }));
      const q = new URLSearchParams();
      const lang = document.documentElement.lang || "";
      if (/^(zh|en)/i.test(lang)) q.set("lang", lang.slice(0, 2).toLowerCase());
      const target = appOriginFrom(pageOrigin, to) + "/" + (q.toString() ? "?" + q : "") + "#" + HASH_PARAM + "=" + encodeHandoff(payload);
      await navigateOrOpen(win, target, "_blank");
      return { id };
    } catch (e) {
      try { win?.close(); } catch { /* gone */ }
      lsDel(PENDING_PREFIX + id);
      throw e;
    }
  }

  /**
   * Receive results other apps send back. Results that arrived while
   * this app was closed are delivered as soon as a handler is set. A
   * result is forgotten once a handler returns (or its promise
   * resolves); a handler that throws gets it again next time.
   */
  onResult(handler: (r: HandoffResult) => unknown): () => void {
    this.resultHandlers.push(handler);
    if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
      queueMicrotask(() => { for (const k of lsKeys(RESULT_PREFIX)) this.deliver(k.slice(RESULT_PREFIX.length)); });
    }
    return () => { this.resultHandlers = this.resultHandlers.filter((h) => h !== handler); };
  }

  /** Handoffs this app sent that have not come back yet. */
  pending(): { id: string; to: string; action: HandoffAction; context: unknown; at: number }[] {
    const out = [];
    for (const k of lsKeys(PENDING_PREFIX)) {
      try { out.push({ id: k.slice(PENDING_PREFIX.length), ...JSON.parse(lsGet(k) || "{}") }); } catch { /* broken */ }
    }
    return out;
  }

  /**
   * Hands a stored result to the handlers. Every open tab of the app hears
   * the same `storage` event, so tabs take turns under a lock named after
   * the handoff (Web Locks, shared by the origin's tabs): the one holding
   * it reads the result again — another tab may have taken it meanwhile —
   * and only a tab whose handlers all succeed removes it. A tab whose
   * handler throws (e.g. the canvas project the result belongs to is not
   * the one open there) releases the lock and the next tab tries.
   */
  /** Whether a handoff this app sent is still waiting for its result
   *  (false once any tab of the app has taken the result). */
  isPending(id: string): boolean {
    return lsGet(PENDING_PREFIX + id) !== null;
  }

  private async deliver(id: string): Promise<void> {
    if (!this.resultHandlers.length || this.delivering.has(id)) return;
    if (!lsGet(RESULT_PREFIX + id) || !lsGet(PENDING_PREFIX + id)) return;
    this.delivering.add(id);
    try {
      await withLock(PENDING_PREFIX + id, () => this.deliverLocked(id));
    } finally {
      this.delivering.delete(id);
    }
  }

  private async deliverLocked(id: string): Promise<void> {
    const rawResult = lsGet(RESULT_PREFIX + id);
    const rawPending = lsGet(PENDING_PREFIX + id);
    if (!rawResult || !rawPending) return; // another tab took it
    let result: ResultPayload | null = null;
    let pending: { to?: string; action?: HandoffAction; context?: unknown } = {};
    try {
      result = parseResultPayload(JSON.parse(rawResult), this.local);
      pending = JSON.parse(rawPending);
    } catch { result = null; }
    if (!result || result.id !== id) {
      lsDel(RESULT_PREFIX + id);
      return;
    }
    const r: HandoffResult = {
      id, from: result.from, files: result.files, context: pending.context ?? null,
      to: pending.to ?? result.from, action: pending.action ?? "edit",
    };
    try {
      for (const h of this.resultHandlers) await h(r);
      lsDel(RESULT_PREFIX + id);
      lsDel(PENDING_PREFIX + id);
    } catch (e) {
      console.warn("RunApps: handoff result handler failed; kept for next time", e);
    }
  }

  /** Drops handoffs (sent or received) older than a week. */
  private prune(): void {
    const cutoff = Date.now() - KEEP_MS;
    for (const k of lsKeys(PENDING_PREFIX)) {
      try { if ((JSON.parse(lsGet(k) || "{}").at ?? 0) < cutoff) { lsDel(k); lsDel(RESULT_PREFIX + k.slice(PENDING_PREFIX.length)); } } catch { lsDel(k); }
    }
    for (const k of lsKeys(RESULT_PREFIX)) {
      try {
        const id = k.slice(RESULT_PREFIX.length);
        if (!lsGet(PENDING_PREFIX + id) || (JSON.parse(lsGet(k) || "{}").received_at ?? 0) < cutoff) lsDel(k);
      } catch { lsDel(k); }
    }
  }

  /** Signed links for the files to hand over; blobs are stored first. */
  private async prepare(id: string, sources: HandoffSource[], seconds: number): Promise<HandoffFile[]> {
    const out: HandoffFile[] = [];
    const toSign: { path: string; i: number }[] = [];
    for (const [i, s] of sources.entries()) {
      if ("url" in s) {
        if (!isFilesURL(s.url, this.local)) throw new Error("RunApps: hand over files-host links only: " + s.url);
        out[i] = { url: s.url, name: s.name, type: s.type ?? "", ...(s.size !== undefined ? { size: s.size } : {}) };
      } else if ("blob" in s) {
        const name = s.name.replace(/[\\/]/g, "_") || "file";
        const obj = await this.files.put(`handoff/${id}/${name}`, s.blob);
        out[i] = { url: "", name, type: s.type ?? s.blob.type ?? "", size: obj.size };
        toSign.push({ path: obj.path, i });
      } else {
        const st = await this.files.stat(s.path);
        out[i] = { url: "", name: s.name ?? s.path.split("/").pop() ?? "file", type: s.type ?? st.content_type ?? "", size: st.size };
        toSign.push({ path: s.path, i });
      }
    }
    if (toSign.length) {
      const urls = await this.files.urls(toSign.map((t) => t.path), { expiresIn: seconds });
      for (const t of toSign) {
        const u = urls[t.path];
        if (!u) throw new Error("RunApps: could not sign " + t.path);
        out[t.i]!.url = u;
      }
    }
    return out;
  }

  private makeIncoming(p: HandoffPayload): IncomingHandoff {
    const svc = this;
    const readKept = () => { try { return JSON.parse(sessionStorage.getItem(INCOMING_KEY) || "null"); } catch { return null; } };
    const file = (i: number) => {
      const f = p.files[i];
      if (!f) throw new Error("RunApps: no handed-over file " + i);
      return f;
    };
    return {
      id: p.id,
      from: p.from,
      action: p.action,
      files: p.files,
      canReply: p.action === "edit" && !!p.reply_to,
      get imported() { return !!readKept()?.imported; },
      importTo(path, index = 0) { return svc.files.putFromURL(path, file(index).url); },
      async blob(index = 0) {
        const r = await fetch(file(index).url);
        if (!r.ok) throw new Error(`RunApps: handed-over file ${index}: HTTP ${r.status}`);
        return r.blob();
      },
      markImported() {
        try { sessionStorage.setItem(INCOMING_KEY, JSON.stringify({ payload: p, imported: true })); } catch { /* blocked */ }
      },
      async fromApp() {
        try {
          const r = await svc.transport.getPublicJSON<{ data?: { name?: string; icon_url?: string } }>("/api/projects/" + p.from);
          return { name: r.data?.name || p.from, icon_url: r.data?.icon_url || "" };
        } catch {
          return { name: p.from, icon_url: "" };
        }
      },
      async reply(sources) {
        if (!p.reply_to || p.action !== "edit") throw new Error("RunApps: this handoff takes no reply");
        const win = openBlank("runapps-handoff", "popup=yes,width=460,height=320");
        try {
          const files = await svc.prepare(p.id, sources, REPLY_LINK_SECONDS);
          const result: ResultPayload = { v: 1, id: p.id, from: svc.self || "app", files };
          const url = p.reply_to + "/__runapps/handoff.html?id=" + encodeURIComponent(p.id) + "#runapps_result=" + encodeHandoff(result);
          await navigateOrOpen(win, url, "runapps-handoff", "popup=yes,width=460,height=320");
        } catch (e) {
          try { win?.close(); } catch { /* gone */ }
          throw e;
        }
      },
      dismiss() {
        try { sessionStorage.removeItem(INCOMING_KEY); } catch { /* blocked */ }
        (svc as { incoming: IncomingHandoff | null }).incoming = null;
      },
    };
  }
}

/** Runs fn holding the origin-wide Web Lock `name` (one tab at a time);
 *  without Web Locks (old browsers, Node) it just runs fn. */
function withLock(name: string, fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== "undefined"
    ? (navigator as { locks?: { request(name: string, cb: () => Promise<void>): Promise<void> } }).locks
    : undefined;
  return locks && typeof locks.request === "function" ? locks.request(name, fn) : fn();
}

/** Opens an empty window now, while the click's user activation lasts;
 *  null when blocked. */
function openBlank(name: string, features?: string): Window | null {
  if (typeof window === "undefined") return null;
  const w = window.open("about:blank", name, features);
  if (w) {
    try {
      w.document.title = "RunApps";
      w.document.body.style.cssText = "margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;font:15px -apple-system,BlinkMacSystemFont,sans-serif;color:#888";
      w.document.body.textContent = "…";
    } catch { /* not same-origin any more */ }
  }
  return w;
}

/** Points a window opened by openBlank at url; when it could not be
 *  opened, opens url on the user's next click or key press instead. */
function navigateOrOpen(win: Window | null, url: string, name: string, features?: string): Promise<void> {
  if (win) {
    win.location.href = url;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const types = ["pointerdown", "keydown", "touchend"];
    const handler = () => {
      for (const t of types) window.removeEventListener(t, handler, true);
      const w = window.open(url, name, features);
      if (w) resolve();
      else reject(new Error("RunApps: the browser blocked the new window"));
    };
    for (const t of types) window.addEventListener(t, handler, true);
  });
}
