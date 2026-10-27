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
/** Blobs an app already shows a Send to… button for (sendButton), so the
 *  after-download card (watchDownloads) does not offer them twice. */
const offeredBlobs = new WeakSet();
/** The "Send to…" button's icon (a paper plane, 16 px, the text's colour). */
const SEND_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M14.5 21.7a.5.5 0 0 0 .9 0l6.6-19.2a.5.5 0 0 0-.6-.6L2.2 8.5a.5.5 0 0 0 0 .9l8 3.2a2 2 0 0 1 1.1 1.1z"/><path d="m21.9 2.1-10.9 11"/></svg>';
/** File type from a name, for blobs that carry none. */
const EXT_TYPES = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
    avif: "image/avif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", psd: "image/vnd.adobe.photoshop",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    m4a: "audio/mp4", flac: "audio/flac", aiff: "audio/aiff", mid: "audio/midi", midi: "audio/midi",
    pdf: "application/pdf", csv: "text/csv", tsv: "text/tab-separated-values", txt: "text/plain", md: "text/markdown",
    html: "text/html", json: "application/json", zip: "application/zip", ics: "text/calendar", vcf: "text/vcard",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ods: "application/vnd.oasis.opendocument.spreadsheet", dxf: "application/dxf",
    step: "model/step", stp: "model/step", stl: "model/stl", glb: "model/gltf-binary", gltf: "model/gltf+json",
};
function typeOf(blob, name) {
    const t = (blob.type || "").split(";")[0].trim();
    if (t && t !== "application/octet-stream")
        return t;
    return EXT_TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""] ?? t;
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
function lsSet(key, value) {
    try {
        localStorage.setItem(key, value);
    }
    catch { /* full or blocked */ }
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
    watchingDownloads = false;
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
     * of them) or arrived while the app was closed. Nothing is taken without
     * the app saying so: with `confirm: true` the SDK asks the user first;
     * otherwise the handler decides, and may answer "later" (the user put it
     * off: offered again at the next start) or "pass" (not here: another
     * tab may take it). A handoff leaves the inbox once a handler is done
     * with it; a handler that throws leaves it for later too.
     */
    onReceive(handler, opts = {}) {
        const fn = opts.confirm
            ? async (h) => {
                const choice = await confirmReceive(h);
                if (choice === "later")
                    return "later";
                if (choice === "ignore")
                    return undefined;
                return handler(h);
            }
            : handler;
        this.handlers.push(fn);
        this.listen();
        if (typeof localStorage !== "undefined") {
            // What waited — including what the user put off last time.
            queueMicrotask(() => { for (const k of lsKeys(INBOX_PREFIX))
                void this.deliver(k.slice(INBOX_PREFIX.length), true); });
        }
        return () => { this.handlers = this.handlers.filter((h) => h !== fn); };
    }
    /**
     * The standard "Send to…" button, for an app's export panel (next to its
     * Download / Save buttons) — every app puts the same control in the same
     * kind of place. It lists the apps that take `type`, stays hidden when
     * there are none, and sends from the click (a new tab opens there).
     * `files` may be a function, read at click time, for a panel whose file
     * changes; it must return synchronously (the click must not await).
     * Pass `className` to look like the app's own buttons.
     */
    sendButton(opts) {
        const zh = /^zh/i.test(document.documentElement.lang || navigator.language || "");
        if (Array.isArray(opts.files))
            for (const f of opts.files)
                if ("blob" in f)
                    offeredBlobs.add(f.blob);
        // Hidden until some app takes the type. An inline display would beat
        // the hidden attribute, so the display itself is switched too.
        const wrap = document.createElement("span");
        wrap.style.cssText = "position:relative;display:none";
        wrap.hidden = true;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = opts.className ?? "";
        btn.setAttribute("aria-haspopup", "menu");
        if (!opts.className)
            btn.style.cssText = "font:inherit;padding:6px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer";
        btn.style.display = "inline-flex";
        btn.style.alignItems = "center";
        btn.style.gap = "6px";
        if (opts.icon !== false)
            btn.insertAdjacentHTML("beforeend", SEND_ICON);
        btn.append(opts.label ?? (zh ? "发送到…" : "Send to…"));
        wrap.append(btn);
        let apps = [];
        void this.receivers({ type: opts.type.split(";")[0] }).then((list) => {
            apps = list;
            wrap.hidden = list.length === 0;
            wrap.style.display = list.length ? "inline-flex" : "none";
        }).catch(() => { });
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!apps.length)
                return;
            showSendMenu(btn, apps, zh, (app, action) => {
                const files = typeof opts.files === "function" ? opts.files() : opts.files;
                this.send(app.slug, { files, action: opts.action ?? action }).then(() => opts.onSent?.(app), (err) => {
                    if (opts.onError)
                        opts.onError(err);
                    else
                        console.warn("RunApps: send failed", err);
                });
            });
        });
        return wrap;
    }
    /**
     * After the app downloads a file (an export, a "Save to device"), offer
     * to send it on: a small card in the corner — "<file> · Send to… · ×" —
     * the same in every app, shown only when some app takes the file's type
     * and not for a file the app already shows a sendButton for. It notices
     * downloads made the usual way (a link with `download` to a blob: or
     * data: URL, clicked or dispatched), so an app needs only this call.
     */
    watchDownloads() {
        if (this.watchingDownloads || typeof window === "undefined" || typeof HTMLAnchorElement === "undefined")
            return;
        this.watchingDownloads = true;
        const blobs = new Map();
        const create = URL.createObjectURL.bind(URL);
        const revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = (obj) => {
            const u = create(obj);
            if (obj instanceof Blob)
                blobs.set(u, obj);
            return u;
        };
        URL.revokeObjectURL = (u) => {
            setTimeout(() => blobs.delete(u), 60_000);
            revoke(u);
        };
        const seen = new WeakSet();
        const offer = (a) => {
            const name = a.download;
            if (!name || !a.href)
                return;
            const fromBlob = blobs.get(a.href);
            const got = fromBlob
                ? Promise.resolve(fromBlob)
                : a.href.startsWith("data:") ? fetch(a.href).then((r) => r.blob()) : null;
            void got?.then((blob) => {
                if (seen.has(blob))
                    return;
                seen.add(blob);
                this.offer(blob, name);
            }).catch(() => { });
        };
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            offer(this);
            return click.call(this);
        };
        const dispatch = EventTarget.prototype.dispatchEvent;
        HTMLAnchorElement.prototype.dispatchEvent = function (ev) {
            if (ev.type === "click")
                offer(this);
            return dispatch.call(this, ev);
        };
        document.addEventListener("click", (e) => {
            const a = e.target?.closest?.("a[download]");
            if (a && !e.isTrusted)
                return; // a synthetic click on an attached link went through dispatchEvent above
            if (a)
                offer(a);
        }, true);
    }
    /**
     * Offer to send a file the app just made — saved to the user's storage,
     * say, rather than downloaded: the same corner card watchDownloads shows
     * after a download ("Exported <file> · Send to… · ×"), only when some
     * app takes the type, and not for a file a sendButton already offers.
     * Call it once the export has succeeded.
     */
    offer(blob, name) {
        if (typeof document === "undefined" || offeredBlobs.has(blob))
            return;
        const type = typeOf(blob, name);
        if (!type)
            return;
        const button = this.sendButton({ type, files: [{ blob, name, type }], onSent: () => close() });
        // sendButton marked the blob; this card is the offer for it.
        const zh = /^zh/i.test(document.documentElement.lang || navigator.language || "");
        document.querySelector("[data-runapps-sendcard]")?.remove();
        const card = document.createElement("div");
        card.setAttribute("data-runapps-sendcard", "");
        card.setAttribute("role", "status");
        card.style.cssText = [
            "position:fixed", "right:16px", "bottom:16px", "z-index:2147483646", "display:none", "align-items:center", "gap:10px",
            "max-width:min(420px,calc(100vw - 32px))", "padding:10px 10px 10px 14px", "border-radius:12px",
            "border:1px solid rgba(127,127,127,.3)", "box-shadow:0 10px 30px rgba(0,0,0,.2)", "color-scheme:light dark",
            "background:Canvas", "color:CanvasText", "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        ].join(";");
        card.hidden = true;
        const label = document.createElement("span");
        label.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85";
        label.textContent = (zh ? "已导出 " : "Exported ") + name;
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "×";
        x.setAttribute("aria-label", zh ? "关闭" : "Close");
        x.style.cssText = "border:0;background:none;color:inherit;font:18px/1 inherit;cursor:pointer;opacity:.6;padding:2px 6px";
        x.addEventListener("click", () => close());
        card.append(label, button, x);
        const host = [...document.querySelectorAll("dialog[open]")].filter((d) => { try {
            return d.matches(":modal");
        }
        catch {
            return false;
        } }).pop() || document.body;
        host.append(card);
        // Shown once the button knows some app takes the type (it unhides);
        // until then display:none, which the hidden attribute alone can't beat.
        const reveal = new MutationObserver(() => { if (!button.hidden) {
            card.hidden = false;
            card.style.display = "flex";
            reveal.disconnect();
        } });
        reveal.observe(button, { attributes: true, attributeFilter: ["hidden"] });
        const timer = setTimeout(() => close(), 20_000);
        function close() {
            clearTimeout(timer);
            reveal.disconnect();
            card.remove();
        }
    }
    /** Removes a handoff from the inbox without taking it. */
    dismiss(id) {
        lsDel(INBOX_PREFIX + id);
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
    async deliver(id, sweep = false) {
        if (!this.handlers.length || this.delivering.has(id) || !lsGet(INBOX_PREFIX + id))
            return;
        this.delivering.add(id);
        try {
            await withLock(INBOX_PREFIX + id, () => this.deliverLocked(id, sweep));
        }
        finally {
            this.delivering.delete(id);
        }
    }
    /** `sweep`: the start-up pass, which also offers what was put off;
     *  live arrivals skip it, so "Later" in one tab is not asked in the
     *  next one. */
    async deliverLocked(id, sweep) {
        const raw = lsGet(INBOX_PREFIX + id);
        if (!raw)
            return; // another tab took it
        let entry = null;
        let p = null;
        try {
            entry = JSON.parse(raw);
            p = parseHandoffPayload(entry?.payload, this.local);
        }
        catch {
            p = null;
        }
        if (!p || p.id !== id || !entry) {
            lsDel(INBOX_PREFIX + id);
            return;
        }
        if (entry.deferred_at && !sweep)
            return;
        const h = this.received(p);
        try {
            for (const fn of this.handlers) {
                const answer = await fn(h);
                if (answer === "later") {
                    lsSet(INBOX_PREFIX + id, JSON.stringify({ ...entry, deferred_at: Date.now() }));
                    return;
                }
                if (answer === "pass")
                    return;
            }
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
/**
 * The menu behind sendButton: the apps, each "Edit in …" / "Open in …"
 * with its icon, under (or above) the button. It goes inside the topmost
 * open modal <dialog> when there is one (the browser's top layer would
 * cover it otherwise) and closes on a pick, Escape or a click elsewhere.
 */
function showSendMenu(anchor, apps, zh, pick) {
    document.querySelector("[data-runapps-sendmenu]")?.remove();
    const menu = document.createElement("div");
    menu.setAttribute("data-runapps-sendmenu", "");
    menu.setAttribute("role", "menu");
    menu.style.cssText = [
        "position:fixed", "z-index:2147483647", "min-width:220px", "max-height:300px", "overflow:auto", "padding:4px",
        "border:1px solid rgba(127,127,127,.3)", "border-radius:10px", "box-shadow:0 10px 30px rgba(0,0,0,.22)",
        "color-scheme:light dark", "background:Canvas", "color:CanvasText",
        "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    ].join(";");
    for (const app of apps) {
        const action = app.actions.includes("edit") ? "edit" : "open";
        const item = document.createElement("button");
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;border-radius:7px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer";
        item.addEventListener("mouseenter", () => { item.style.background = "rgba(127,127,127,.14)"; });
        item.addEventListener("mouseleave", () => { item.style.background = "none"; });
        if (app.icon_url) {
            const img = document.createElement("img");
            img.src = app.icon_url;
            img.alt = "";
            img.style.cssText = "width:18px;height:18px;border-radius:4px;object-fit:cover;flex:none";
            item.append(img);
        }
        const text = document.createElement("span");
        text.textContent = action === "edit"
            ? (zh ? `用 ${app.name} 编辑` : `Edit in ${app.name}`)
            : (zh ? `在 ${app.name} 中打开` : `Open in ${app.name}`);
        item.append(text);
        item.addEventListener("click", (e) => { e.stopPropagation(); close(); pick(app, action); });
        menu.append(item);
    }
    const host = [...document.querySelectorAll("dialog[open]")].filter((d) => { try {
        return d.matches(":modal");
    }
    catch {
        return false;
    } }).pop() || document.body;
    host.append(menu);
    const r = anchor.getBoundingClientRect();
    const h = menu.offsetHeight;
    const below = r.bottom + 6 + h <= window.innerHeight;
    menu.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - h)}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    const onDoc = (e) => { if (!menu.contains(e.target))
        close(); };
    const onKey = (e) => { if (e.key === "Escape") {
        e.stopPropagation();
        close();
    } };
    function close() {
        menu.remove();
        document.removeEventListener("pointerdown", onDoc, true);
        document.removeEventListener("keydown", onKey, true);
    }
    setTimeout(() => {
        document.addEventListener("pointerdown", onDoc, true);
        document.addEventListener("keydown", onKey, true);
    }, 0);
}
/**
 * The SDK's own "another app sent you files" dialog, for apps that do not
 * ask in their own UI: Receive / Later / Ignore. A modal <dialog>, so it
 * sits above the app's own modals (the browser's top layer); Escape and
 * closing it mean Later. Words follow the page's language (zh or en).
 */
async function confirmReceive(h) {
    if (typeof document === "undefined" || typeof HTMLDialogElement === "undefined")
        return "receive";
    const zh = /^zh/i.test(document.documentElement.lang || navigator.language || "");
    const from = (await h.fromApp().catch(() => null))?.name || h.from;
    const n = h.files.length;
    const t = zh
        ? { title: `${from} 发来 ${n} 个文件`, receive: "接收", later: "稍后", ignore: "忽略" }
        : { title: `${from} sent you ${n} file${n === 1 ? "" : "s"}`, receive: "Receive", later: "Later", ignore: "Ignore" };
    const names = h.files.slice(0, 3).map((f) => f.name).join("\n") + (n > 3 ? (zh ? `\n…等 ${n} 个` : `\n… ${n} in all`) : "");
    const d = document.createElement("dialog");
    d.setAttribute("style", [
        "border:1px solid rgba(127,127,127,.3)", "border-radius:12px", "padding:18px 18px 14px", "width:min(360px,calc(100vw - 32px))",
        "font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif", "color-scheme:light dark",
        "color:CanvasText", "background:Canvas", "box-shadow:0 12px 40px rgba(0,0,0,.25)",
    ].join(";"));
    const title = document.createElement("div");
    title.textContent = t.title;
    title.setAttribute("style", "font-weight:600;font-size:15px;margin-bottom:6px");
    const list = document.createElement("div");
    list.textContent = names;
    list.setAttribute("style", "white-space:pre-line;opacity:.75;font-size:13px;margin-bottom:14px;word-break:break-all");
    const row = document.createElement("div");
    row.setAttribute("style", "display:flex;justify-content:flex-end;gap:8px");
    const button = (label, value, primary = false) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.value = value;
        b.setAttribute("style", "font:inherit;padding:6px 14px;border-radius:8px;cursor:pointer;" + (primary
            ? "border:0;background:#2563eb;color:#fff"
            : "border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit"));
        b.addEventListener("click", () => d.close(value));
        return b;
    };
    row.append(button(t.ignore, "ignore"), button(t.later, "later"), button(t.receive, "receive", true));
    d.append(title, list, row);
    document.body.append(d);
    return new Promise((resolve) => {
        d.addEventListener("close", () => {
            const v = d.returnValue;
            d.remove();
            resolve(v === "receive" || v === "ignore" ? v : "later");
        }, { once: true });
        d.showModal();
        row.lastElementChild?.focus();
    });
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