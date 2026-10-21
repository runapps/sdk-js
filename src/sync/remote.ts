// sync/remote.ts — the sync engine's storage, over the files API.
//
// Shards are plain JSON files in the user's file space for the app, so
// they share its quota, billing and deletion with everything else the
// app stores for that user. Conditional reads (304) and writes (412 /
// 409) come from the files API, which checks them against the store.

import type { FilesService } from "../files.js";
import type { APIError } from "../errors.js";
import type { SyncRemote } from "./engine.js";

export class FilesRemote implements SyncRemote {
  constructor(private readonly files: FilesService) {}

  async list(prefix: string): Promise<{ path: string; etag: string }[]> {
    const out: { path: string; etag: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.files.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const f of page.files) if (f.etag) out.push({ path: f.path, etag: f.etag });
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }

  async getJSON(path: string, ifNoneMatch?: string) {
    let r;
    try {
      r = await this.files.readJSON(path, ifNoneMatch ? { ifNoneMatch } : undefined);
    } catch (e) {
      // A shard that is not JSON (a write cut short before the gateway
      // checked lengths) would stall every pull; treat it as absent so
      // the next push writes it whole again.
      if (e instanceof SyntaxError) {
        console.warn("[runapps sync] ignoring unreadable shard", path);
        return { status: "missing" as const };
      }
      throw e;
    }
    if (r.notModified) return { status: "unchanged" as const };
    if (r.value === undefined) return { status: "missing" as const };
    return { status: "ok" as const, value: r.value, etag: r.etag ?? "" };
  }

  async putJSON(path: string, value: unknown, cond: { ifMatch?: string; ifNoneMatch?: boolean }) {
    try {
      const obj = await this.files.put(path, JSON.stringify(value), {
        contentType: "application/json",
        ...(cond.ifMatch ? { ifMatch: cond.ifMatch } : {}),
        ...(cond.ifNoneMatch ? { ifNoneMatch: true } : {}),
      });
      return { status: "ok" as const, etag: obj.etag ?? "", serverTime: obj.last_modified ? Date.parse(obj.last_modified) : undefined };
    } catch (e) {
      const code = (e as APIError).statusCode;
      if (code === 412 || code === 409) return { status: "conflict" as const };
      throw e;
    }
  }

  async putBlob(path: string, blob: Blob): Promise<void> {
    try {
      await this.files.put(path, blob, { contentType: blob.type || "application/octet-stream", ifNoneMatch: true });
    } catch (e) {
      if ((e as APIError).statusCode !== 409) throw e; // already stored: same bytes, same name
    }
  }

  getBlob(path: string): Promise<Blob> {
    return this.files.get(path);
  }
}
