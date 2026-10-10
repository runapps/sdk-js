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
        const r = await this.files.readJSON(path, ifNoneMatch ? { ifNoneMatch } : undefined);
        if (r.notModified)
            return { status: "unchanged" };
        if (r.value === undefined)
            return { status: "missing" };
        return { status: "ok", value: r.value, etag: r.etag ?? "" };
    }
    async putJSON(path, value, cond) {
        try {
            const obj = await this.files.put(path, JSON.stringify(value), {
                contentType: "application/json",
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