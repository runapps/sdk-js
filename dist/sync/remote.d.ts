import type { FilesService } from "../files.js";
import type { SyncRemote } from "./engine.js";
export declare class FilesRemote implements SyncRemote {
    private readonly files;
    constructor(files: FilesService);
    list(prefix: string): Promise<{
        path: string;
        etag: string;
    }[]>;
    getJSON(path: string, ifNoneMatch?: string): Promise<{
        status: "corrupt";
        etag: string;
    } | {
        status: "missing";
        etag?: undefined;
    } | {
        serverTime: number;
        status: "unchanged";
        etag?: undefined;
    } | {
        serverTime?: undefined;
        status: "unchanged";
        etag?: undefined;
    } | {
        serverTime: number;
        status: "missing";
        etag?: undefined;
    } | {
        serverTime: number;
        status: "ok";
        value: {} | null;
        etag: string;
    } | {
        serverTime?: undefined;
        status: "ok";
        value: {} | null;
        etag: string;
    }>;
    putJSON(path: string, value: unknown, cond: {
        ifMatch?: string;
        ifNoneMatch?: boolean;
    }, opts?: {
        keepalive?: boolean;
    }): Promise<{
        status: "ok";
        etag: string;
        serverTime: number | undefined;
    } | {
        status: "conflict";
        etag?: undefined;
        serverTime?: undefined;
    }>;
    remove(path: string): Promise<void>;
    putBlob(path: string, blob: Blob): Promise<void>;
    getBlob(path: string): Promise<Blob>;
}
//# sourceMappingURL=remote.d.ts.map