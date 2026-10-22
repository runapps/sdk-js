import type { Transport } from "./transport.js";
/** What `assets.verify` made of a picture. */
export interface AssetVerifyResult {
    /** "active": the picture is in the Seedance asset library — send
     *  `asset` to Seedance in its place. "no_face": it holds no face and
     *  Seedance takes it as it is. */
    status: "active" | "no_face";
    /** `asset://<id>`, for a reference image / first frame (status "active"). */
    asset?: string;
    asset_id?: string;
    /** Faces found in the picture. */
    faces: number;
    /** The picture was already in the library. */
    cached?: boolean;
}
/**
 * Seedance asset verification. Seedance refuses a reference picture with
 * a realistic face; `verify` puts the picture into the platform's
 * Seedance asset library (reviewed by Volcengine, a few seconds) and
 * answers its `asset://` URI, which Seedance takes in the picture's
 * place. Only for users the platform enabled it for: check
 * `(await client.me()).features.includes("seedance_asset_verify")`.
 *
 * The library is a cache that evicts pictures not used lately, so verify
 * again right before each Seedance call (a picture still held answers at
 * once) rather than keeping an old asset.
 *
 * Errors are `APIError`s with a `code`: "invalid_image" (400: not a
 * picture, or under 300 px / over 6000 px a side, or width/height
 * outside 0.4–2.5), "feature_not_enabled" (403), "rejected" (422:
 * Volcengine's review refused it), "busy" (429: retry after
 * `retryAfter` seconds).
 */
export declare class AssetsService {
    private transport;
    constructor(transport: Transport);
    /** Verify a picture (an http(s) URL or a data: URI) for Seedance. */
    verify(url: string, init?: {
        signal?: AbortSignal;
    }): Promise<AssetVerifyResult>;
}
//# sourceMappingURL=assets.d.ts.map