/** How an encoded value refers to a Blob stored out of band. */
export interface BlobRef {
    ref: string;
    type: string;
    size: number;
}
export interface BlobSink {
    /** Store the blob and return a stable reference for it. */
    (blob: Blob): Promise<BlobRef>;
}
export interface BlobSource {
    (ref: BlobRef): Promise<Blob>;
}
/**
 * Encode a structured-clone value into a JSON-safe one. Async only
 * because Blobs have to be read.
 */
export declare function encodeValue(value: unknown, sink?: BlobSink): Promise<unknown>;
/** Inverse of `encodeValue`. */
export declare function decodeValue(value: unknown, source?: BlobSource): Promise<unknown>;
export declare function encodeKey(key: IDBValidKey): unknown;
export declare function decodeKey(encoded: unknown): IDBValidKey;
/** Canonical string id for a key: equal keys give equal ids. */
export declare function keyId(key: IDBValidKey): string;
/** Deterministic 32-bit hash of a string (FNV-1a). */
export declare function hash32(s: string): number;
/**
 * Structural equality for structured-clone values: Dates by time,
 * binary by bytes, Map/Set by entries, Blobs by identity (two different
 * Blob objects count as a change). Used to find which fields a write
 * touched.
 */
export declare function deepEqual(a: unknown, b: unknown): boolean;
/** The fields of `value` that differ from `prior` (added, changed or
 *  removed). `undefined` when there is no prior: everything is new. */
export declare function changedFields(prior: unknown, value: unknown): string[] | undefined;
/** Read an inline key out of a value by IndexedDB keyPath rules. */
export declare function extractKey(value: unknown, keyPath: string | string[] | null): IDBValidKey | undefined;
//# sourceMappingURL=codec.d.ts.map