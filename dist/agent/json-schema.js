// A small JSON Schema checker for tool arguments. Covers what tool schemas
// use in practice — type, required, properties, additionalProperties,
// enum, const, items, bounds, anyOf/oneOf — and returns readable messages
// that go back to the model as the tool result, so it can fix the call.
// (`validate.ts` speaks the gateway's option-schema vocabulary, not JSON
// Schema, so it does not apply here.)
/** Problems found, as `path: message` lines; empty when the value fits. */
export function validateSchema(schema, value) {
    if (!schema)
        return [];
    const errors = [];
    check(schema, value, "", errors, 0);
    return errors;
}
function typeOf(v) {
    if (v === null)
        return "null";
    if (Array.isArray(v))
        return "array";
    if (typeof v === "number")
        return Number.isInteger(v) ? "integer" : "number";
    return typeof v;
}
function matchesType(want, v) {
    const t = typeOf(v);
    if (want === "number")
        return t === "number" || t === "integer";
    if (want === "integer")
        return t === "integer";
    return want === t;
}
function check(schema, value, path, errors, depth) {
    if (depth > 32)
        return;
    const at = path || "arguments";
    // Combinators: pass when one branch passes.
    for (const key of ["anyOf", "oneOf"]) {
        const branches = schema[key];
        if (Array.isArray(branches) && branches.length) {
            const ok = branches.some((b) => {
                const e = [];
                check(b, value, path, e, depth + 1);
                return e.length === 0;
            });
            if (!ok)
                errors.push(`${at}: does not match any allowed form`);
            return;
        }
    }
    if (Array.isArray(schema.allOf)) {
        for (const b of schema.allOf)
            check(b, value, path, errors, depth + 1);
    }
    if (schema.type !== undefined) {
        const types = (Array.isArray(schema.type) ? schema.type : [schema.type]);
        if (!types.some((t) => matchesType(t, value))) {
            errors.push(`${at}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
            return;
        }
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
        errors.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
        return;
    }
    if ("const" in schema && !deepEqual(schema.const, value)) {
        errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
        return;
    }
    if (typeof value === "string") {
        if (typeof schema.minLength === "number" && value.length < schema.minLength)
            errors.push(`${at}: shorter than ${schema.minLength} characters`);
        if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
            errors.push(`${at}: longer than ${schema.maxLength} characters`);
        if (typeof schema.pattern === "string") {
            try {
                if (!new RegExp(schema.pattern, "u").test(value))
                    errors.push(`${at}: does not match pattern ${schema.pattern}`);
            }
            catch { /* bad pattern in the schema: ignore */ }
        }
    }
    else if (typeof value === "number") {
        if (typeof schema.minimum === "number" && value < schema.minimum)
            errors.push(`${at}: below minimum ${schema.minimum}`);
        if (typeof schema.maximum === "number" && value > schema.maximum)
            errors.push(`${at}: above maximum ${schema.maximum}`);
        if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
            errors.push(`${at}: must be greater than ${schema.exclusiveMinimum}`);
        if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum)
            errors.push(`${at}: must be less than ${schema.exclusiveMaximum}`);
    }
    else if (Array.isArray(value)) {
        if (typeof schema.minItems === "number" && value.length < schema.minItems)
            errors.push(`${at}: needs at least ${schema.minItems} items`);
        if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
            errors.push(`${at}: at most ${schema.maxItems} items`);
        if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
            value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, errors, depth + 1));
        }
    }
    else if (value && typeof value === "object") {
        const obj = value;
        const props = (schema.properties && typeof schema.properties === "object" ? schema.properties : {});
        if (Array.isArray(schema.required)) {
            for (const r of schema.required) {
                if (!(r in obj) || obj[r] === undefined)
                    errors.push(`${at}: missing required "${r}"`);
            }
        }
        for (const [k, v] of Object.entries(obj)) {
            const sub = props[k];
            if (sub) {
                check(sub, v, path ? `${path}.${k}` : k, errors, depth + 1);
            }
            else if (schema.additionalProperties === false) {
                const known = Object.keys(props);
                errors.push(`${at}: unknown field "${k}"${known.length ? ` (allowed: ${known.join(", ")})` : ""}`);
            }
            else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
                check(schema.additionalProperties, v, path ? `${path}.${k}` : k, errors, depth + 1);
            }
        }
    }
}
function deepEqual(a, b) {
    if (a === b)
        return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object")
        return false;
    if (Array.isArray(a) !== Array.isArray(b))
        return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length)
        return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
}
//# sourceMappingURL=json-schema.js.map