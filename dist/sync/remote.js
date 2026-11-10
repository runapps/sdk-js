// sync/remote.ts — the sync engine's storage, over the files API.
//
// Shards are plain JSON files in the user's file space for the app, so
// they share its quota, billing and deletion with everything else the
// app stores for that user. Conditional reads (304) and writes (412 /
// 409) come from the files API, which checks them against the store.
export class FilesRemote {
    files;
    constructor(files) {
        this.files = files;
    }
    async list(prefix) {
        const out = [];
        let cursor;
        do {
            const page = await this.files.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
            for (const f of page.files)
                if (f.etag)
                    out.push({ path: f.path, etag: f.etag });
            cursor = page.next_cursor;
        } while (cursor);
        return out;
    }
    async getJSON(path, ifNoneMatch) {
        let r;
        try {
            r = await this.files.readJSON(path, ifNoneMatch ? { ifNoneMatch } : undefined);
        }
        catch (e) {
            // A file that is not JSON (a write cut short before the gateway
            // checked lengths). Say so, with its ETag: the engine neither
            // takes it for an empty shard (that would read as "every record
            // in it was deleted") nor stalls on it, and the next write replaces
            // it with If-Match.
            if (e instanceof SyntaxError) {
                console.warn("[runapps sync] unreadable file, will be rewritten", path);
                try {
                    const st = await this.files.stat(path);
                    return { status: "corrupt", etag: st.etag ?? "" };
                }
                catch {
                    return { status: "missing" };
                }
            }
            throw e;
        }
        const st = r.serverTime !== undefined ? { serverTime: r.serverTime } : {};
        if (r.notModified)
            return { status: "unchanged", ...st };
        if (r.value === undefined)
            return { status: "missing", ...st };
        return { status: "ok", value: r.value, etag: r.etag ?? "", ...st };
    }
    async putJSON(path, value, cond, opts) {
        const body = JSON.stringify(value);
        // keepalive bodies are capped at 64 KB (all such requests together);
        // a bigger shard goes as a normal write and may not outlive the page.
        const keepalive = opts?.keepalive && new TextEncoder().encode(body).length < 60_000;
        try {
            const obj = await this.files.put(path, body, {
                contentType: "application/json",
                ...(keepalive ? { keepalive: true } : {}),
                ...(cond.ifMatch ? { ifMatch: cond.ifMatch } : {}),
                ...(cond.ifNoneMatch ? { ifNoneMatch: true } : {}),
            });
            return { status: "ok", etag: obj.etag ?? "", serverTime: obj.last_modified ? Date.parse(obj.last_modified) : undefined };
        }
        catch (e) {
            const code = e.statusCode;
            if (code === 412 || code === 409)
                return { status: "conflict" };
            throw e;
        }
    }
    async remove(path) {
        try {
            await this.files.del(path);
        }
        catch (e) {
            if (e.statusCode !== 404)
                throw e;
        }
    }
    async putBlob(path, blob) {
        try {
            await this.files.put(path, blob, { contentType: blob.type || "application/octet-stream", ifNoneMatch: true });
        }
        catch (e) {
            if (e.statusCode !== 409)
                throw e; // already stored: same bytes, same name
        }
    }
    getBlob(path) {
        return this.files.get(path);
    }
}
//# sourceMappingURL=remote.js.map