import type { RunApps } from "../client.js";
import type { AgentFS, FileStat, SessionData, SessionSummary, Skill } from "./types.js";
import { type Inflate } from "./zip.js";
export declare const SKILLS_ROOT = "/skills";
/** Saved agent sessions of a workspace (`workspace.sessions`). */
export interface SessionStore {
    /** Newest first. */
    list(): Promise<SessionSummary[]>;
    get(id: string): Promise<SessionData | null>;
    save(data: SessionData): Promise<void>;
    delete(id: string): Promise<void>;
}
export interface WorkspaceOptions {
    /**
     * Session id: workspaces with different ids are separate databases;
     * the same id (default `"default"`) opens the same one, also across
     * tabs and reloads.
     */
    id?: string;
    /** Scopes the database to an app; `client.workspace()` fills it in. */
    project?: string;
    /**
     * Skills zip(s): a path or URL fetched as is (`/skills.zip` in the
     * bundle, a public link), or `files:<path>` for a file in the user's
     * RunApps storage (fetched with the SDK's token). Unpacked under
     * `/skills`, re-fetched only when the server's ETag changes.
     */
    skills?: string | string[];
    /** Inflate for runtimes without DecompressionStream (tests: zlib.inflateRawSync). */
    inflate?: Inflate;
    fetch?: typeof fetch;
    /** IndexedDB to use (tests); in-memory when the runtime has none. */
    indexedDB?: IDBFactory | null;
}
export interface WorkspaceRead {
    data: string | Uint8Array;
    contentType?: string;
    size: number;
}
export declare class Workspace {
    readonly id: string;
    readonly dbName: string;
    private store;
    private readonly mounts;
    private readonly sources;
    private readonly client;
    private readonly inflate?;
    private readonly fetchFn;
    private readonly idb;
    private skillCache;
    private opened;
    /** The agent sessions saved in this workspace. */
    readonly sessions: SessionStore;
    constructor(client: RunApps | null, opts?: WorkspaceOptions);
    /** Opens the database and brings the skills layer up to date. */
    static open(client: RunApps | null, opts?: WorkspaceOptions): Promise<Workspace>;
    /** Resolves once the database is open and skills are unpacked (idempotent). */
    ready(): Promise<void>;
    /** Exposes `fs` under `prefix` (e.g. `/doc`); its paths are relative to the prefix. */
    mount(prefix: string, fs: AgentFS): void;
    unmount(prefix: string): void;
    /** What the system prompt says about the tree. */
    describe(): string;
    private route;
    list(prefix?: string): Promise<FileStat[]>;
    stat(path: string): Promise<FileStat | null>;
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<WorkspaceRead>;
    /** Whether `path` has files under it (a folder, in a tree that stores only files). */
    isFolder(path: string): Promise<boolean>;
    private missing;
    /** The file as text; throws for binary files. */
    readText(path: string): Promise<string>;
    write(path: string, content: string | Uint8Array, contentType?: string): Promise<void>;
    delete(path: string): Promise<void>;
    /** Removes everything the agent wrote (mounts and skills stay). */
    clearWork(): Promise<void>;
    /** The skills in `/skills` (parsed once per refresh). */
    skills(): Promise<Skill[]>;
    /** The body (instructions) of a skill, by name. */
    skillBody(name: string): Promise<{
        skill: Skill;
        body: string;
    }>;
    /**
     * Fetches the skills zips again. Each is skipped when the server says
     * it is unchanged (ETag / Last-Modified); `force` unpacks regardless.
     */
    refreshSkills(force?: boolean): Promise<void>;
    private unpackSource;
    private fetchSource;
    /** Deletes the database (tests, "reset" buttons). */
    destroy(): Promise<void>;
}
/** Absolute, `/`-separated, no `.`/`..`/doubled slashes, no trailing slash. */
export declare function normalizePath(path: string): string;
export declare function guessType(path: string, data: string | Uint8Array): string;
/** UTF-8 text of `bytes`, or null when it is not text. */
export declare function decodeText(bytes: Uint8Array): string | null;
/** A title for a session without one: its first user message, shortened. */
export declare function titleOf(d: SessionData): string;
/** Runs fn holding the origin-wide Web Lock `name`; without Web Locks it just runs fn. */
export declare function withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
/** An in-memory AgentFS, for tests and for documents an app builds on the fly. */
export declare function memoryFS(initial?: Record<string, string | Uint8Array>, opts?: {
    description?: string;
    readonly?: boolean;
}): AgentFS & {
    files: Map<string, string | Uint8Array>;
};
//# sourceMappingURL=workspace.d.ts.map