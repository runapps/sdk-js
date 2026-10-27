// ── Pure helpers (exported for tests) ───────────────────────────────────
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_FILES = 20;
const HASH_PARAM = "runapps_handoff";
const INBOX_PREFIX = "runapps_inbox:";
const INBOX_CHANNEL = "runapps_inbox";
const INBOX_PATH = "/__runapps/handoff.html";
const KEEP_MS = 7 * 24 * 3600 * 1000;
/** How long sent links stay readable: long enough for a handoff that
 *  waits in the inbox until the app is next opened. */
const SEND_LINK_SECONDS = 7 * 24 * 3600;
export function encodeHandoff(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = "";
    for (const b of bytes)
        bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeHandoff(s) {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}
/** The slug of an app page's own host, or "" off the platform's hosts
 *  (`<slug>.runapps.dev`, or `<slug>.localhost` in local development). */
export function appSlugOf(hostname) {
    const m = /^([a-z0-9-]+)\.(runapps\.dev|localhost)$/i.exec(hostname);
    return m && SLUG.test(m[1].toLowerCase()) ? m[1].toLowerCase() : "";
}
/** Where another app runs, seen from this page: the same scheme, domain
 *  and port, with that app's slug as the subdomain. */
export function appOriginFrom(pageOrigin, slug) {
    const u = new URL(pageOrigin);
    if (/\.localhost$/i.test(u.hostname) || u.hostname === "localhost") {
        return `http://${slug}.localhost${u.port ? ":" + u.port : ":8080"}`;
    }
    return `https://${slug}.runapps.dev`;
}
/** Whether an origin is an app host. */
export function isAppOrigin(origin) {
    return /^https:\/\/[a-z0-9-]+\.runapps\.dev$/.test(origin) || /^http:\/\/[a-z0-9-]+\.localhost(:\d+)?$/.test(origin);
}
/** Whether a sent link points at the platform's files host (or, from a
 *  local app page, the local backend). */
export function isFilesURL(url, local) {
    if (/^https:\/\/files\.runapps\.ai\/(f|s)\/[^\s]+$/.test(url))
        return true;
    return local && /^http:\/\/localhost(:\d+)?\/(f|s)\/[^\s]+$/.test(url);
}
function cleanFiles(files, local) {
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES)
        return null;
    const out = [];
    for (const f of files) {
        if (!f || typeof f !== "object")
            return null;
        const { url, name, type, size } = f;
        if (typeof url !== "string" || !isFilesURL(url, local))
            return null;
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
export function parseHandoffPayload(raw, local) {
    if (!raw || typeof raw !== "object")
        return null;
    const p = raw;
    if (p.v !== 2 || typeof p.id !== "string" || !ID.test(p.id))
        return null;
    if (typeof p.from !== "string" || !SLUG.test(p.from))
        return null;
    const action = p.action === "open" ? "open" : p.action === "edit" ? "edit" : null;
    if (!action)
        return null;
    const files = cleanFiles(p.files, local);
    if (!files)
        return null;
    return { v: 2, id: p.id, from: p.from, action, files };
}
function newId() {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
// ── Browser storage helpers ─────────────────────────────────────────────
function lsGet(key) {
    try {
        return localStorage.getItem(key);
    }
    catch {
        return null;
    }
}
function lsDel(key) {
    try {
        localStorage.removeItem(key);
    }
    catch { /* blocked */ }
}
function lsKeys(prefix) {
    const out = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix))
                out.push(k);
        }
    }
    catch { /* blocked */ }
    return out;
}
// ── The service ─────────────────────────────────────────────────────────
/**
 * App handoff: send files to another app on the platform, and receive what
 * other apps send this one.
 *
 * ```ts
 * // Send: which apps edit a video, then send one from a click.
 * const apps = await client.apps.receivers({ type: "video/mp4" });
 * button.onclick = () => client.apps.send(apps[0].slug, { files: [{ path: "clips/a.mp4" }] });
 *
 * // Receive: whatever another app sends, now or while this app was closed.
 * client.apps.onReceive(async (h) => {
 *   const obj = await h.importTo("received/" + h.files[0].name);
 *   addToDocument(obj);
 * });
 * ```
 *
 * An app declares what it takes in its bundle.json:
 * `{"receives": [{"types": ["video/*"], "action": "edit"}]}`.
 */
export class AppsService {
    transport;
    files;
    project;
    signedIn;
    local;
    handlers = [];
    delivering = new Set();
    listening = false;
    constructor(transport, files, project, signedIn) {
        this.transport = transport;
        this.files = files;
        this.project = project;
        this.signedIn = signedIn;
        this.local = typeof location !== "undefined" && /\.localhost$/i.test(location.hostname);
        if (typeof localStorage !== "undefined")
            this.prune();
    }
    /** This app's slug: its host's subdomain, else the `project` option. */
    get self() {
        const fromHost = typeof location !== "undefined" ? appSlugOf(location.hostname) : "";
        return fromHost || this.project || "";
    }
    /**
     * The apps that take a file type, as their bundles declare, in library
     * order and the page's language; this app is left out. Signed in, the
     * list also has the unlisted apps the user has.
     */
    async receivers(opts) {
        const q = new URLSearchParams({ type: opts.type });
        if (opts.action)
            q.set("action", opts.action);
        const lang = typeof document !== "undefined" ? (document.documentElement.lang || navigator.language || "") : "";
        if (/^zh/i.test(lang))
            q.set("lang", "zh");
        const path = "/v1/apps/receivers?" + q.toString();
        const init = opts.signal ? { signal: opts.signal } : undefined;
        const r = this.signedIn()
            ? await this.transport.getJSON(path, init)
            : await this.transport.getPublicJSON(path, init);
        const self = this.self;
        return (r.data || []).filter((a) => a.slug !== self);
    }
    /**
     * Send files to another app. Call it straight from the click that asks
     * for it: the app's inbox opens in a new tab (that needs the user
     * gesture), so the window is opened first and pointed at the inbox once
     * the links are signed. If the app is already open in a tab, that tab
     * takes the files and the new tab says so; otherwise the new tab becomes
     * the app.
     */
    async send(to, opts) {
        if (!SLUG.test(to))
            throw new Error("RunApps: send: not an app slug: " + to);
        if (!opts.files?.length || opts.files.length > MAX_FILES)
            throw new Error(`RunApps: send: 1–${MAX_FILES} files`);
        const id = newId();
        const win = openBlank("_blank");
        try {
            const files = await this.prepare(id, opts.files);
            const payload = { v: 2, id, from: this.self || "app", action: opts.action ?? "edit", files };
            const q = new URLSearchParams();
            const lang = document.documentElement.lang || "";
            if (/^(zh|en)/i.test(lang))
                q.set("lang", lang.slice(0, 2).toLowerCase());
            const target = appOriginFrom(location.origin, to) + INBOX_PATH + (q.toString() ? "?" + q : "") + "#" + HASH_PARAM + "=" + encodeHandoff(payload);
            await navigateOrOpen(win, target, "_blank");
            return { id };
        }
        catch (e) {
            try {
                win?.close();
            }
            catch { /* gone */ }
            throw e;
        }
    }
    /**
     * Receive what other apps send this one: each handoff once, whether it
     * arrives now (in this tab or, with the app open in several tabs, in one
     * of them) or arrived while the app was closed. A handoff is forgotten
     * once a handler returns (or its promise resolves); a handler that throws
     * leaves it for later (another tab, the next start, or a new handler).
     */
    onReceive(handler) {
        this.handlers.push(handler);
        this.listen();
        if (typeof localStorage !== "undefined") {
            queueMicrotask(() => { for (const k of lsKeys(INBOX_PREFIX))
                void this.deliver(k.slice(INBOX_PREFIX.length)); });
        }
        return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
    }
    /** Handoffs waiting for this app (sent while it was closed, or not yet
     *  taken), without taking them. An app checks it at start, to skip its
     *  start screen or last document when it was opened to receive files. */
    waiting() {
        const out = [];
        for (const k of lsKeys(INBOX_PREFIX)) {
            try {
                const p = parseHandoffPayload(JSON.parse(lsGet(k) || "null")?.payload, this.local);
                if (p)
                    out.push({ id: p.id, from: p.from, action: p.action, files: p.files });
            }
            catch { /* broken */ }
        }
        return out;
    }
    /** Hears the inbox page (BroadcastChannel) and other tabs (storage). */
    listen() {
        if (this.listening || typeof window === "undefined" || typeof window.addEventListener !== "function")
            return;
        this.listening = true;
        window.addEventListener("storage", (e) => {
            if (e.key && e.key.startsWith(INBOX_PREFIX) && e.newValue)
                void this.deliver(e.key.slice(INBOX_PREFIX.length));
        });
        if (typeof BroadcastChannel === "function") {
            const ch = new BroadcastChannel(INBOX_CHANNEL);
            ch.onmessage = (e) => {
                const d = e.data;
                if (d?.type !== "new" || typeof d.id !== "string" || !this.handlers.length)
                    return;
                ch.postMessage({ type: "here", id: d.id });
                void this.deliver(d.id);
            };
        }
    }
    /**
     * Hands one inbox entry to the handlers. Every open tab hears of it, so
     * tabs take turns under a lock named after the handoff (Web Locks,
     * shared by the origin's tabs): the one holding it reads the entry again
     * — another tab may have taken it — and only a tab whose handlers all
     * succeed removes it.
     */
    async deliver(id) {
        if (!this.handlers.length || this.delivering.has(id) || !lsGet(INBOX_PREFIX + id))
            return;
        this.delivering.add(id);
        try {
            await withLock(INBOX_PREFIX + id, () => this.deliverLocked(id));
        }
        finally {
            this.delivering.delete(id);
        }
    }
    async deliverLocked(id) {
        const raw = lsGet(INBOX_PREFIX + id);
        if (!raw)
            return; // another tab took it
        let p = null;
        try {
            p = parseHandoffPayload(JSON.parse(raw)?.payload, this.local);
        }
        catch {
            p = null;
        }
        if (!p || p.id !== id) {
            lsDel(INBOX_PREFIX + id);
            return;
        }
        const h = this.received(p);
        try {
            for (const fn of this.handlers)
                await fn(h);
            lsDel(INBOX_PREFIX + id);
        }
        catch (e) {
            console.warn("RunApps: a handler could not take the files another app sent; kept for later", e);
        }
    }
    received(p) {
        const svc = this;
        const file = (i) => {
            const f = p.files[i];
            if (!f)
                throw new Error("RunApps: no sent file " + i);
            return f;
        };
        return {
            id: p.id,
            from: p.from,
            action: p.action,
            files: p.files,
            importTo(path, index = 0) { return svc.files.putFromURL(path, file(index).url); },
            async blob(index = 0) {
                const r = await fetch(file(index).url);
                if (!r.ok)
                    throw new Error(`RunApps: sent file ${index}: HTTP ${r.status}`);
                return r.blob();
            },
            async fromApp() {
                try {
                    const r = await svc.transport.getPublicJSON("/api/projects/" + p.from);
                    return { name: r.data?.name || p.from, icon_url: r.data?.icon_url || "" };
                }
                catch {
                    return { name: p.from, icon_url: "" };
                }
            },
        };
    }
    /** Drops inbox entries older than a week. */
    prune() {
        const cutoff = Date.now() - KEEP_MS;
        for (const k of lsKeys(INBOX_PREFIX)) {
            try {
                if ((JSON.parse(lsGet(k) || "{}").received_at ?? 0) < cutoff)
                    lsDel(k);
            }
            catch {
                lsDel(k);
            }
        }
    }
    /** Links for the files to send; paths are signed, blobs stored first. */
    async prepare(id, sources) {
        const out = [];
        const toSign = [];
        for (const [i, s] of sources.entries()) {
            if ("url" in s) {
                if (!isFilesURL(s.url, this.local))
                    throw new Error("RunApps: send files-host links only: " + s.url);
                out[i] = { url: s.url, name: s.name, type: s.type ?? "", ...(s.size !== undefined ? { size: s.size } : {}) };
            }
            else if ("blob" in s) {
                const name = s.name.replace(/[\\/]/g, "_") || "file";
                const obj = await this.files.put(`handoff/${id}/${name}`, s.blob);
                out[i] = { url: "", name, type: s.type ?? s.blob.type ?? "", size: obj.size };
                toSign.push({ path: obj.path, i });
            }
            else {
                const st = await this.files.stat(s.path);
                out[i] = { url: "", name: s.name ?? s.path.split("/").pop() ?? "file", type: s.type ?? st.content_type ?? "", size: st.size };
                toSign.push({ path: s.path, i });
            }
        }
        if (toSign.length) {
            const urls = await this.files.urls(toSign.map((t) => t.path), { expiresIn: SEND_LINK_SECONDS });
            for (const t of toSign) {
                const u = urls[t.path];
                if (!u)
                    throw new Error("RunApps: could not sign " + t.path);
                out[t.i].url = u;
            }
        }
        return out;
    }
}
/** Runs fn holding the origin-wide Web Lock `name` (one tab at a time);
 *  without Web Locks (old browsers, Node) it just runs fn. */
function withLock(name, fn) {
    const locks = typeof navigator !== "undefined"
        ? navigator.locks
        : undefined;
    return locks && typeof locks.request === "function" ? locks.request(name, fn) : fn();
}
/** Opens an empty window now, while the click's user activation lasts;
 *  null when blocked. */
function openBlank(name, features) {
    if (typeof window === "undefined")
        return null;
    const w = window.open("about:blank", name, features);
    if (w) {
        try {
            w.document.title = "RunApps";
            w.document.body.style.cssText = "margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;font:15px -apple-system,BlinkMacSystemFont,sans-serif;color:#888";
            w.document.body.textContent = "…";
        }
        catch { /* not same-origin any more */ }
    }
    return w;
}
/** Points a window opened by openBlank at url; when it could not be
 *  opened, opens url on the user's next click or key press instead. */
function navigateOrOpen(win, url, name, features) {
    if (win) {
        win.location.href = url;
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const types = ["pointerdown", "keydown", "touchend"];
        const handler = () => {
            for (const t of types)
                window.removeEventListener(t, handler, true);
            const w = window.open(url, name, features);
            if (w)
                resolve();
            else
                reject(new Error("RunApps: the browser blocked the new window"));
        };
        for (const t of types)
            window.addEventListener(t, handler, true);
    });
}
//# sourceMappingURL=apps.js.map