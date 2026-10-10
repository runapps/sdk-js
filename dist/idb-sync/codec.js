// idb-sync/codec.ts — JSON encoding for IndexedDB values and keys.
//
// IndexedDB stores anything the structured-clone algorithm accepts:
// Dates, Maps, Sets, binary, Blobs, nested objects, undefined. The sync
// snapshots on the server are JSON, so every such value is wrapped in a
// small tagged object on the way out and rebuilt on the way in. Plain
// JSON values pass through untouched, which keeps the common case (a
// record of strings and numbers) byte-for-byte readable on the server.
//
// Blobs are not inlined: `encodeValue` hands them to a `BlobSink` which
// stores the bytes elsewhere (the engine uploads them as files) and
// returns a reference; `decodeValue` asks a `BlobSource` for the bytes.
const TAG = "$rt";
const BIN_CTORS = {
    ArrayBuffer: (b) => b,
    Uint8Array: (b) => new Uint8Array(b),
    Int8Array: (b) => new Int8Array(b),
    Uint8ClampedArray: (b) => new Uint8ClampedArray(b),
    Int16Array: (b) => new Int16Array(b),
    Uint16Array: (b) => new Uint16Array(b),
    Int32Array: (b) => new Int32Array(b),
    Uint32Array: (b) => new Uint32Array(b),
    Float32Array: (b) => new Float32Array(b),
    Float64Array: (b) => new Float64Array(b),
    BigInt64Array: (b) => new BigInt64Array(b),
    BigUint64Array: (b) => new BigUint64Array(b),
    DataView: (b) => new DataView(b),
};
function bytesToBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}
function base64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++)
        out[i] = s.charCodeAt(i);
    return out;
}
function isPlainObject(v) {
    if (v === null || typeof v !== "object")
        return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}
/**
 * Encode a structured-clone value into a JSON-safe one. Async only
 * because Blobs have to be read.
 */
export async function encodeValue(value, sink) {
    if (value === undefined)
        return { [TAG]: "undef" };
    if (value === null)
        return null;
    switch (typeof value) {
        case "string":
        case "boolean":
            return value;
        case "number":
            if (Number.isNaN(value))
                return { [TAG]: "num", v: "NaN" };
            if (value === Infinity)
                return { [TAG]: "num", v: "Infinity" };
            if (value === -Infinity)
                return { [TAG]: "num", v: "-Infinity" };
            if (Object.is(value, -0))
                return { [TAG]: "num", v: "-0" };
            return value;
        case "bigint":
            return { [TAG]: "bigint", v: value.toString() };
        case "function":
        case "symbol":
            throw new TypeError(`runapps sync: ${typeof value} values cannot be stored`);
    }
    if (value instanceof Date) {
        const t = value.getTime();
        return { [TAG]: "date", v: Number.isNaN(t) ? "invalid" : t };
    }
    if (value instanceof RegExp)
        return { [TAG]: "re", s: value.source, f: value.flags };
    if (typeof Blob !== "undefined" && value instanceof Blob) {
        if (!sink)
            throw new TypeError("runapps sync: Blob values need a blob sink");
        const ref = await sink(value);
        const out = { [TAG]: "blob", r: ref.ref, t: ref.type, s: ref.size };
        const f = value;
        if (typeof File !== "undefined" && value instanceof File) {
            out.n = f.name;
            out.m = f.lastModified;
        }
        return out;
    }
    if (value instanceof ArrayBuffer) {
        return { [TAG]: "bin", c: "ArrayBuffer", v: bytesToBase64(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
        const name = value.constructor.name;
        if (!(name in BIN_CTORS))
            throw new TypeError(`runapps sync: unsupported binary type ${name}`);
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return { [TAG]: "bin", c: name, v: bytesToBase64(bytes) };
    }
    if (value instanceof Map) {
        const v = [];
        for (const [k, x] of value)
            v.push([await encodeValue(k, sink), await encodeValue(x, sink)]);
        return { [TAG]: "map", v };
    }
    if (value instanceof Set) {
        const v = [];
        for (const x of value)
            v.push(await encodeValue(x, sink));
        return { [TAG]: "set", v };
    }
    if (Array.isArray(value)) {
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++)
            out[i] = await encodeValue(value[i], sink);
        return out;
    }
    if (isPlainObject(value)) {
        // A plain object that happens to carry our tag key is wrapped so it
        // cannot be mistaken for an encoding marker.
        const needsWrap = Object.prototype.hasOwnProperty.call(value, TAG);
        const out = {};
        for (const k of Object.keys(value))
            out[k] = await encodeValue(value[k], sink);
        return needsWrap ? { [TAG]: "obj", v: out } : out;
    }
    // Class instances: structured clone keeps own enumerable properties
    // only, so do the same.
    const out = {};
    for (const k of Object.keys(value))
        out[k] = await encodeValue(value[k], sink);
    return out;
}
/** Inverse of `encodeValue`. */
export async function decodeValue(value, source) {
    if (value === null || typeof value !== "object")
        return value;
    if (Array.isArray(value)) {
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++)
            out[i] = await decodeValue(value[i], source);
        return out;
    }
    const obj = value;
    const tag = obj[TAG];
    if (typeof tag === "string") {
        const t = obj;
        switch (t[TAG]) {
            case "undef":
                return undefined;
            case "date":
                return t.v === "invalid" ? new Date(NaN) : new Date(t.v);
            case "num":
                return t.v === "NaN" ? NaN : t.v === "Infinity" ? Infinity : t.v === "-Infinity" ? -Infinity : -0;
            case "bigint":
                return BigInt(t.v);
            case "re":
                return new RegExp(t.s, t.f);
            case "bin": {
                const bytes = base64ToBytes(t.v);
                const buf = new ArrayBuffer(bytes.byteLength);
                new Uint8Array(buf).set(bytes);
                const make = BIN_CTORS[t.c];
                if (!make)
                    throw new TypeError(`runapps sync: unsupported binary type ${t.c}`);
                return make(buf);
            }
            case "map": {
                const m = new Map();
                for (const pair of t.v) {
                    m.set(await decodeValue(pair[0], source), await decodeValue(pair[1], source));
                }
                return m;
            }
            case "set": {
                const s = new Set();
                for (const x of t.v)
                    s.add(await decodeValue(x, source));
                return s;
            }
            case "blob": {
                if (!source)
                    throw new TypeError("runapps sync: Blob values need a blob source");
                const blob = await source({ ref: t.r, type: t.t, size: t.s });
                if (t.n !== undefined && typeof File !== "undefined") {
                    return new File([blob], t.n, { type: t.t, lastModified: t.m ?? Date.now() });
                }
                return blob;
            }
            case "obj":
                return decodeValue(t.v, source);
        }
    }
    const out = {};
    for (const k of Object.keys(obj))
        out[k] = await decodeValue(obj[k], source);
    return out;
}
// ── Keys ─────────────────────────────────────────────────────────────
//
// A valid IndexedDB key is a number, a string, a Date, binary, or an
// array of those. Keys are encoded synchronously (no Blobs possible)
// and also rendered to a canonical string that serves as the record id
// inside a shard and as the input to the shard hash.
export function encodeKey(key) {
    if (typeof key === "number") {
        if (Number.isNaN(key))
            throw new TypeError("runapps sync: NaN is not a valid key");
        return key;
    }
    if (typeof key === "string")
        return key;
    if (key instanceof Date)
        return { [TAG]: "date", v: key.getTime() };
    if (key instanceof ArrayBuffer)
        return { [TAG]: "bin", c: "ArrayBuffer", v: bytesToBase64(new Uint8Array(key)) };
    if (ArrayBuffer.isView(key)) {
        return {
            [TAG]: "bin",
            c: "ArrayBuffer",
            v: bytesToBase64(new Uint8Array(key.buffer, key.byteOffset, key.byteLength)),
        };
    }
    if (Array.isArray(key))
        return key.map((k) => encodeKey(k));
    throw new TypeError("runapps sync: invalid IndexedDB key");
}
export function decodeKey(encoded) {
    if (typeof encoded === "number" || typeof encoded === "string")
        return encoded;
    if (Array.isArray(encoded))
        return encoded.map(decodeKey);
    if (encoded && typeof encoded === "object") {
        const t = encoded;
        if (t[TAG] === "date")
            return new Date(t.v);
        if (t[TAG] === "bin") {
            const bytes = base64ToBytes(t.v);
            const buf = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(buf).set(bytes);
            return buf;
        }
    }
    throw new TypeError("runapps sync: invalid encoded key");
}
/** Canonical string id for a key: equal keys give equal ids. */
export function keyId(key) {
    return JSON.stringify(encodeKey(key));
}
/** Deterministic 32-bit hash of a string (FNV-1a). */
export function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/**
 * Structural equality for structured-clone values: Dates by time,
 * binary by bytes, Map/Set by entries, Blobs by identity (two different
 * Blob objects count as a change). Used to find which fields a write
 * touched.
 */
export function deepEqual(a, b) {
    if (Object.is(a, b))
        return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object")
        return false;
    if (a instanceof Date || b instanceof Date) {
        return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
    }
    if (typeof Blob !== "undefined" && (a instanceof Blob || b instanceof Blob))
        return false;
    if (ArrayBuffer.isView(a) || a instanceof ArrayBuffer || ArrayBuffer.isView(b) || b instanceof ArrayBuffer) {
        const toBytes = (x) => x instanceof ArrayBuffer ? new Uint8Array(x) : ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : null;
        const ba = toBytes(a);
        const bb = toBytes(b);
        if (!ba || !bb || ba.length !== bb.length || a.constructor !== b.constructor)
            return false;
        for (let i = 0; i < ba.length; i++)
            if (ba[i] !== bb[i])
                return false;
        return true;
    }
    if (a instanceof Map || b instanceof Map) {
        if (!(a instanceof Map && b instanceof Map) || a.size !== b.size)
            return false;
        for (const [k, v] of a)
            if (!b.has(k) || !deepEqual(v, b.get(k)))
                return false;
        return true;
    }
    if (a instanceof Set || b instanceof Set) {
        if (!(a instanceof Set && b instanceof Set) || a.size !== b.size)
            return false;
        for (const v of a)
            if (!b.has(v))
                return false;
        return true;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i++)
            if (!deepEqual(a[i], b[i]))
                return false;
        return true;
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length)
        return false;
    for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, k))
            return false;
        if (!deepEqual(a[k], b[k]))
            return false;
    }
    return true;
}
/** The fields of `value` that differ from `prior` (added, changed or
 *  removed). `undefined` when there is no prior: everything is new. */
export function changedFields(prior, value) {
    if (!isPlainObject(prior) || !isPlainObject(value))
        return undefined;
    const out = [];
    for (const k of new Set([...Object.keys(prior), ...Object.keys(value)])) {
        const inP = Object.prototype.hasOwnProperty.call(prior, k);
        const inV = Object.prototype.hasOwnProperty.call(value, k);
        if (inP !== inV || !deepEqual(prior[k], value[k]))
            out.push(k);
    }
    return out;
}
/** Read an inline key out of a value by IndexedDB keyPath rules. */
export function extractKey(value, keyPath) {
    if (keyPath === null || keyPath === undefined)
        return undefined;
    const one = (path) => {
        let cur = value;
        if (path === "")
            return cur;
        for (const part of path.split(".")) {
            if (cur === null || typeof cur !== "object")
                return undefined;
            cur = cur[part];
        }
        return cur;
    };
    if (Array.isArray(keyPath)) {
        const parts = keyPath.map(one);
        return parts.some((p) => p === undefined) ? undefined : parts;
    }
    const k = one(keyPath);
    return k === undefined ? undefined : k;
}
//# sourceMappingURL=codec.js.map