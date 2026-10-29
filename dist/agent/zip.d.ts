export interface ZipEntry {
    /** Path inside the zip, `/`-separated, no leading slash. */
    name: string;
    size: number;
    compressedSize: number;
    method: number;
    isDir: boolean;
    /** Offset of the local header. */
    offset: number;
}
export type Inflate = (compressed: Uint8Array) => Promise<Uint8Array> | Uint8Array;
export declare const MAX_ZIP_BYTES: number;
export declare function listZip(bytes: Uint8Array): ZipEntry[];
export declare function readZipEntry(bytes: Uint8Array, entry: ZipEntry, inflate?: Inflate): Promise<Uint8Array>;
//# sourceMappingURL=zip.d.ts.map