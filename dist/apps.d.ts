import type { Transport } from "./transport.js";
import type { FileObject, FilesService } from "./files.js";
/** How a sender words a send: "edit" (work on it) or "open" (show it). */
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
}
/** A file in a handoff: a files-host link and what it is. */
export interface HandoffFile {
    url: string;
    name: string;
    type: string;
    size?: number;
}
/** A file to send: a path in this app's storage, a Blob, or a link on the
 *  files host this app already holds (a signed or public link). */
export type HandoffSource = {
    path: string;
    name?: string;
    type?: string;
} | {
    blob: Blob;
    name: string;
    type?: string;
} | {
    url: string;
    name: string;
    type?: string;
    size?: number;
};
export interface SendOptions {
    files: HandoffSource[];
    /** "edit" (default) or "open": how the receiver is asked to treat it. */
    action?: HandoffAction;
}
/** Files another app sent this one (`client.apps.onReceive`). */
export interface ReceivedHandoff {
    id: string;
    /** The sending app (slug). */
    from: string;
    action: HandoffAction;
    files: HandoffFile[];
    /** Copy file `index` into this app's storage at `path`, server side
     *  (the bytes do not pass through the browser). */
    importTo(path: string, index?: number): Promise<FileObject>;
    /** Download file `index`. */
    blob(index?: number): Promise<Blob>;
    /** The sending app's name and icon, for "Received from …". */
    fromApp(): Promise<{
        name: string;
        icon_url: string;
    }>;
}
/** The wire form of a handoff, in the inbox page's URL fragment. */
export interface HandoffPayload {
    v: 2;
    id: string;
    from: string;
    action: HandoffAction;
    files: HandoffFile[];
}
export declare function encodeHandoff(obj: unknown): string;
export declare function decodeHandoff(s: string): unknown;
/** The slug of an app page's own host, or "" off the platform's hosts
 *  (`<slug>.runapps.dev`, or `<slug>.localhost` in local development). */
export declare function appSlugOf(hostname: string): string;
/** Where another app runs, seen from this page: the same scheme, domain
 *  and port, with that app's slug as the subdomain. */
export declare function appOriginFrom(pageOrigin: string, slug: string): string;
/** Whether an origin is an app host. */
export declare function isAppOrigin(origin: string): boolean;
/** Whether a sent link points at the platform's files host (or, from a
 *  local app page, the local backend). */
export declare function isFilesURL(url: string, local: boolean): boolean;
/** Validates a handoff as it arrives; null when anything is off. */
export declare function parseHandoffPayload(raw: unknown, local: boolean): HandoffPayload | null;
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
export declare class AppsService {
    private transport;
    private files;
    private readonly project;
    private readonly signedIn;
    private readonly local;
    private handlers;
    private delivering;
    private listening;
    constructor(transport: Transport, files: FilesService, project: string | undefined, signedIn: () => boolean);
    /** This app's slug: its host's subdomain, else the `project` option. */
    get self(): string;
    /**
     * The apps that take a file type, as their bundles declare, in library
     * order and the page's language; this app is left out. Signed in, the
     * list also has the unlisted apps the user has.
     */
    receivers(opts: {
        type: string;
        action?: HandoffAction;
        signal?: AbortSignal;
    }): Promise<ReceiverApp[]>;
    /**
     * Send files to another app. Call it straight from the click that asks
     * for it: the app's inbox opens in a new tab (that needs the user
     * gesture), so the window is opened first and pointed at the inbox once
     * the links are signed. If the app is already open in a tab, that tab
     * takes the files and the new tab says so; otherwise the new tab becomes
     * the app.
     */
    send(to: string, opts: SendOptions): Promise<{
        id: string;
    }>;
    /**
     * Receive what other apps send this one: each handoff once, whether it
     * arrives now (in this tab or, with the app open in several tabs, in one
     * of them) or arrived while the app was closed. A handoff is forgotten
     * once a handler returns (or its promise resolves); a handler that throws
     * leaves it for later (another tab, the next start, or a new handler).
     */
    onReceive(handler: (h: ReceivedHandoff) => unknown): () => void;
    /** Handoffs waiting for this app (sent while it was closed, or not yet
     *  taken), without taking them. An app checks it at start, to skip its
     *  start screen or last document when it was opened to receive files. */
    waiting(): {
        id: string;
        from: string;
        action: HandoffAction;
        files: HandoffFile[];
    }[];
    /** Hears the inbox page (BroadcastChannel) and other tabs (storage). */
    private listen;
    /**
     * Hands one inbox entry to the handlers. Every open tab hears of it, so
     * tabs take turns under a lock named after the handoff (Web Locks,
     * shared by the origin's tabs): the one holding it reads the entry again
     * — another tab may have taken it — and only a tab whose handlers all
     * succeed removes it.
     */
    private deliver;
    private deliverLocked;
    private received;
    /** Drops inbox entries older than a week. */
    private prune;
    /** Links for the files to send; paths are signed, blobs stored first. */
    private prepare;
}
//# sourceMappingURL=apps.d.ts.map