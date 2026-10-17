/** True iff `model.capability_tags` includes a tag with the given stable ID. */
export const hasCapabilityTag = (model, id) => Array.isArray(model.capability_tags) &&
    model.capability_tags.some((t) => t.id === id);
/**
 * True iff the chat model accepts the given input modality. Lets you
 * filter by `"image"` / `"video"` / `"audio"` (or `"text"`, always
 * true for chat models that set the field at all) without remembering
 * whether the gateway uses canonical or aliased names.
 *
 * Returns `false` when `input_modalities` is unset — text-only is the
 * conservative default.
 *
 * @example
 *   const videoModels = (await client.models.list())
 *     .filter(m => acceptsModality(m, "video"));
 */
export const acceptsModality = (model, modality) => Array.isArray(model.input_modalities) &&
    model.input_modalities.includes(modality);
/** True iff the gateway flag in `options[key]` is set. Accepts bool or numeric 1. */
function optBool(model, key) {
    const v = model.options?.[key];
    if (typeof v === "boolean")
        return v;
    if (typeof v === "number")
        return v !== 0;
    return false;
}
/** Convenience: TTS model accepts a reference audio clip as `voice`? */
export const supportsVoiceClone = (model) => optBool(model, "supports_voice_clone");
/** Convenience: TTS model accepts a free-form `instruct_text` directive? */
export const supportsInstructText = (model) => optBool(model, "supports_instruct_text");
/** Convenience: admin-set default voice for a TTS model, or null. */
export const defaultVoice = (model) => {
    const v = model.options?.["default_voice"];
    return typeof v === "string" ? v : null;
};
/**
 * The platform's default model among `models` — the admin-starred one for
 * the capability, else the first of the capability. With `capability`
 * given, only that capability is considered; without it, the first
 * default in list order (so pass a list from
 * `client.models.list({ capability })`). Null when the list has none.
 */
export const defaultModel = (models, capability) => {
    const pool = capability ? models.filter((m) => m.capability === capability) : models;
    return pool.find((m) => m.is_default) ?? null;
};
export class ModelsService {
    transport;
    constructor(transport) {
        this.transport = transport;
    }
    /**
     * List models available on the gateway. Pass `{ capability: "..." }` to
     * filter server-side. Needs no sign-in or key.
     */
    async list(opts = {}, init) {
        let path = "/v1/models";
        if (opts.capability) {
            path += `?capability=${encodeURIComponent(opts.capability)}`;
        }
        // The catalogue is public: no token, so listing models never sends a
        // signed-out user to sign in.
        const resp = await this.transport.getPublicJSON(path, init);
        return resp.data;
    }
    /**
     * The platform's default model for a capability (`"text"` unless given):
     * the admin-starred one, else the first. What a request without `model`
     * would use before the user's own preference. Null when the capability
     * has no models.
     */
    async default(capability = "text", init) {
        return defaultModel(await this.list({ capability }, init), capability);
    }
}
//# sourceMappingURL=models.js.map