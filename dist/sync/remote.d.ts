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
        status: "missing";
        value?: undefined;
        etag?: undefined;
    } | {
        status: "unchanged";
        value?: undefined;
        etag?: undefined;
    } | {
        status: "ok";
        value: {} | null;
        etag: string;
    }>;
    putJSON(path: string, value: unknown, cond: {
        ifMatch?: string;
        ifNoneMatch?: boolean;
    }): Promise<{
        status: "ok";
        etag: string;
        serverTime: number | undefined;
    } | {
        status: "conflict";
        etag?: undefined;
        serverTime?: undefined;
    }>;
    putBlob(path: string, blob: Blob): Promise<void>;
    getBlob(path: string): Promise<Blob>;
}
//# sourceMappingURL=remote.d.ts.map