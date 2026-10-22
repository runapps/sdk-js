/**
 * APIError represents an error returned by the RunApps gateway.
 *
 * Use `instanceof APIError` (or check `name === "APIError"`) to distinguish
 * gateway errors from network / runtime errors:
 *
 * ```ts
 * try {
 *   await client.chat.create({ model: "...", messages: [...] });
 * } catch (e) {
 *   if (e instanceof APIError) {
 *     console.error(`API ${e.statusCode}: ${e.message}`);
 *   } else {
 *     throw e;
 *   }
 * }
 * ```
 */
export declare class APIError extends Error {
    readonly statusCode: number;
    readonly type: string;
    /** The body's machine-readable `code` when it has one, e.g. "busy",
     *  "feature_not_enabled" (assets.verify). */
    readonly code?: string;
    /** Seconds to wait before retrying, from a 429's `retry_after` or
     *  `Retry-After`. */
    readonly retryAfter?: number;
    constructor(statusCode: number, type: string, message: string, code?: string, retryAfter?: number);
}
//# sourceMappingURL=errors.d.ts.map