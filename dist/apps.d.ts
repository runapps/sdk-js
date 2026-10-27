import type { Transport } from "./transport.js";
import type { FilesService } from "./files.js";
/** What an app can be handed, as its bundle.json declares it. */
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
    /** An edit sends its result back to the sender. */
    reply: boolean;
}
/** A file in a handoff: a signed (or public) link and what it is. */
export interface HandoffFile {
    url: string;
    name: string;
    type: string;
    size?: number;
}
/** A file to hand over: a path in this app's storage, a Blob, or a URL
 *  on the files host this app already holds (a signed or public link). */
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
    /** "edit" (default) asks for the result back; "open" just hands over. */
    action?: HandoffAction;
    /** Anything JSON the sender wants back with the result (e.g. which
     *  canvas node the file came from). Stays in this app; not sent. */
    context?: unknown;
}
/** A result sent back to this app (`client.apps.onResult`). */
export interface HandoffResult {
    id: string;
    /** The app that sent it (slug). */
    from: string;
    files: HandoffFile[];
    /** The context given to `send`. */
    context: unknown;
    /** The app the files were sent to and the action asked. */
    to: string;
    action: HandoffAction;
}
/** The handoff this app was opened with (`client.apps.incoming`). */
export interface IncomingHandoff {
    id: string;
    /** The sending app (slug). */
    from: string;
    action: HandoffAction;
    files: HandoffFile[];
    /** The sender wants the result back (`reply`). */
    canReply: boolean;
    /** The app has already taken the files in (see `markImported`). */
    imported: boolean;
    /** Copy file `index` into this app's storage at `path`, server side
     *  (the bytes do not pass through the browser). */
    importTo(path: string, index?: number): Promise<import("./files.js").FileObject>;
    /** Download file `index`. */
    blob(index?: number): Promise<Blob>;
    /** Record that the files were taken in, so a reload of the page does
     *  not take them in again. The reply stays possible. */
    markImported(): void;
    /** The sending app's name and icon, for "Send back to …". */
    fromApp(): Promise<{
        name: string;
        icon_url: string;
    }>;
    /**
     * Send the result back to the sender. Call it straight from the click
     * that asks for it: it opens a small window on the sender's origin,
     * which needs the user gesture. Blobs are stored in this app first
     * (`handoff/<id>/<name>`) and handed back as signed links.
     */
    reply(files: HandoffSource[]): Promise<void>;
    /** Forget the handoff (the user declined it, or it is done). */
    dismiss(): void;
}
/** The wire form of a handoff, in the receiving app's URL fragment. */
export interface HandoffPayload {
    v: 1;
    id: string;
    from: string;
    /** Where to send a result: the sender's origin. */
    reply_to?: string;
    action: HandoffAction;
    files: HandoffFile[];
}
/** The wire form of a result, in the callback page's URL fragment. */
export interface ResultPayload {
    v: 1;
    id: string;
    from: string;
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
/** Whether an origin is an app host (the only places a result may go). */
export declare function isAppOrigin(origin: string): boolean;
/** Whether a handed-over link points at the platform's files host (or,
 *  from a local app page, the local backend). */
export declare function isFilesURL(url: string, local: boolean): boolean;
/** Validates a handoff as it arrives; null when anything is off. */
export declare function parseHandoffPayload(raw: unknown, local: boolean): HandoffPayload | null;
/** Validates a result read back from localStorage. */
export declare function parseResultPayload(raw: unknown, local: boolean): ResultPayload | null;
/**
 * Reads a handoff from this page's URL fragment, before anything else
 * touches the fragment, and removes it from the address bar (other
 * fragment parameters stay). It is kept in sessionStorage so a reload, or
 * a sign-in that redirects the whole page, does not lose it. Called by
 * the client constructor; null when the page was not opened with one.
 */
export declare function takeIncomingHandoff(): HandoffPayload | null;
/**
 * App handoff: hand files to another app on the platform, take what
 * another app handed this one, and send results back.
 *
 * ```ts
 * // Sender: which apps edit a video, then hand one over.
 * const apps = await client.apps.receivers({ type: "video/mp4", action: "edit" });
 * button.onclick = () => client.apps.send(apps[0].slug, {
 *   files: [{ path: "clips/a.mp4" }], context: { nodeId },
 * });
 * client.apps.onResult(async (r) => {
 *   await client.files.putFromURL("clips/a-edited.mp4", r.files[0].url);
 * });
 *
 * // Receiver: the app was opened with files.
 * const inc = client.apps.incoming;
 * if (inc && !inc.imported) { await inc.importTo("in/" + inc.files[0].name); inc.markImported(); }
 * sendBack.onclick = () => inc.reply([{ blob: edited, name: "edited.mp4" }]);
 * ```
 *
 * An app declares what it takes in its bundle.json:
 * `{"receives": [{"types": ["video/*"], "action": "edit", "reply": true}]}`.
 */
export declare class AppsService {
    private transport;
    private files;
    private readonly project;
    private readonly signedIn;
    /** The handoff this page was opened with, or null. */
    readonly incoming: IncomingHandoff | null;
    private readonly local;
    private resultHandlers;
    private delivering;
    constructor(transport: Transport, files: FilesService, project: string | undefined, signedIn: () => boolean, payload: HandoffPayload | null);
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
     * Hand files to another app: it opens in a new tab with them. Call it
     * straight from the click that asks for it (a new tab needs the user
     * gesture); the window is opened first and pointed at the app once the
     * links are signed. With action "edit" the app can send a result back,
     * which arrives through `onResult` with `context`.
     */
    send(to: string, opts: SendOptions): Promise<{
        id: string;
    }>;
    /**
     * Receive results other apps send back. Results that arrived while
     * this app was closed are delivered as soon as a handler is set. A
     * result is forgotten once a handler returns (or its promise
     * resolves); a handler that throws gets it again next time.
     */
    onResult(handler: (r: HandoffResult) => unknown): () => void;
    /** Handoffs this app sent that have not come back yet. */
    pending(): {
        id: string;
        to: string;
        action: HandoffAction;
        context: unknown;
        at: number;
    }[];
    private deliver;
    /** Drops handoffs (sent or received) older than a week. */
    private prune;
    /** Signed links for the files to hand over; blobs are stored first. */
    private prepare;
    private makeIncoming;
}
//# sourceMappingURL=apps.d.ts.map