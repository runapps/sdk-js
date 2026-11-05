import { appSlugOf } from "./apps.js";
// An app's public folder: what its creator keeps under `_public/` in their
// own files for the app, readable by anyone with no token at
// /v1/apps/<slug>/public/<path>. Templates, presets, skills, data the
// creator updates without touching the bundle; what the files mean is the
// app's business.
//
// Reads go out with no Authorization header, so they never ask anyone to
// sign in and a page can use them before anyone has. They are left to the
// browser's HTTP cache, which revalidates each one with the file's ETag:
// an update shows on the next read, an unchanged file costs a 304.
const PUBLIC_DIR = "_public/";
function encodePath(path) {
    return path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}
export class SharedService {
    transport;
    files;
    project;
    fixedSlug;
    constructor(transport, files, project, fixedSlug) {
        this.transport = transport;
        this.files = files;
        this.project = project;
        this.fixedSlug = fixedSlug;
    }
    /** The public folder of another app, to read. */
    of(slug) {
        return new SharedService(this.transport, this.files, this.project, slug);
    }
    slug() {
        const fromHost = typeof location !== "undefined" ? appSlugOf(location.hostname) : "";
        const slug = this.fixedSlug || fromHost || this.project;
        if (!slug)
            throw new Error("client.shared: name the app with the `project` option or .of(slug)");
        return slug;
    }
    /** The address of a file; it needs no token. */
    url(path) {
        return `${this.transport.baseURL}/v1/apps/${encodeURIComponent(this.slug())}/public/${encodePath(path)}`;
    }
    async fetchFile(path, init) {
        return this.transport.fetchPublic(this.url(path), init);
    }
    /** The folder's files in path order, a page at a time. */
    async list(opts) {
        const q = new URLSearchParams();
        if (opts?.prefix)
            q.set("prefix", opts.prefix);
        if (opts?.cursor)
            q.set("cursor", opts.cursor);
        if (opts?.limit)
            q.set("limit", String(opts.limit));
        const qs = q.toString() ? `?${q}` : "";
        const resp = await this.transport.fetchPublic(`${this.transport.baseURL}/v1/apps/${encodeURIComponent(this.slug())}/public${qs}`, opts?.signal ? { signal: opts.signal } : undefined);
        return (await resp.json());
    }
    async get(path, init) {
        return (await this.fetchFile(path, init)).blob();
    }
    async text(path, init) {
        return (await this.fetchFile(path, init)).text();
    }
    async json(path, init) {
        return (await this.fetchFile(path, init)).json();
    }
    /**
     * Copy a file into the signed-in user's own files for this app. The
     * platform does the copying, so nothing goes through the page; it is
     * billed to the user like any other write. Their copy is theirs: a later
     * update of the original does not touch it.
     */
    copy(path, to, opts) {
        return this.files.putFromURL(to, this.url(path), opts);
    }
    /** Whether the signed-in user created this app, so may publish to its
     *  folder. For showing the publishing controls to the right person. */
    async canPublish(init) {
        const me = await this.transport.getJSON(`/v1/me?app=${encodeURIComponent(this.slug())}`, init);
        return me.is_creator === true;
    }
    /**
     * Publish a file: for the app's creator, signed in to this app. These
     * are the ordinary file calls on `_public/<path>`, so `ifMatch` guards a
     * read-modify-write as usual. In anyone else's hands the same write only
     * lands in their own files, where nobody reads it.
     */
    put(path, body, opts) {
        return this.files.put(PUBLIC_DIR + path.replace(/^\/+/, ""), body, opts);
    }
    /** Remove a published file. */
    remove(path, init) {
        return this.files.del(PUBLIC_DIR + path.replace(/^\/+/, ""), init);
    }
}
//# sourceMappingURL=shared.js.map