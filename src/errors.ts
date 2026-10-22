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
export class APIError extends Error {
  public readonly statusCode: number;
  public readonly type: string;
  /** The body's machine-readable `code` when it has one, e.g. "busy",
   *  "feature_not_enabled" (assets.verify). */
  public readonly code?: string;
  /** Seconds to wait before retrying, from a 429's `retry_after` or
   *  `Retry-After`. */
  public readonly retryAfter?: number;

  constructor(statusCode: number, type: string, message: string, code?: string, retryAfter?: number) {
    super(`runapps: ${statusCode} ${type}: ${message}`);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.type = type;
    if (code !== undefined) this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}
