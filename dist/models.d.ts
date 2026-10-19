import type { Transport } from "./transport.js";
/**
 * One model available on the gateway. Pricing is in **pips** (1 USD =
 * 1,000,000 pips), per million tokens — multiply by tokens / 10⁶ for the
 * billed pip cost, or by tokens / 10¹² for USD.
 */
export interface Model {
    id: string;
    object: string;
    capability: string;
    provider?: string;
    /**
     * The model the platform uses for this capability when a request names
     * none: the one the admin starred in the gateway settings, else the
     * first of the capability. Exactly one model per capability carries it.
     * Use `defaultModel` to pick it out of a list.
     */
    is_default?: boolean;
    /** One or two sentences about the model, set on the gateway. */
    description?: string;
    /**
     * Server-derived "what this model can actually do" tags
     * (e.g. {id:"t2v", label:"Text-to-Video"}, {id:"i2v", label:"Image-to-Video"}).
     * Use `hasCapabilityTag` for stable filter checks; iterate for display.
     * Labels are in English — frontends localise on their side.
     */
    capability_tags?: Tag[];
    /**
     * Accepted input modalities for chat models. Omitted on capabilities
     * where it doesn't apply (image generation, TTS, etc.). Mirrors
     * Anthropic / Gemini's own `inputModalities` field — operator-set on
     * the gateway, surfaced verbatim here.
     *
     * Canonical values: `"text"`, `"image"`, `"video"`, `"audio"`. The
     * list is open — future modalities ride through without an SDK
     * update. Use `acceptsModality` for the stable filter check.
     *
     * @example
     *   const videoCapable = models.filter(m => acceptsModality(m, "video"));
     */
    input_modalities?: string[];
    options?: Record<string, unknown>;
    input_price_per_mtok: number;
    output_price_per_mtok: number;
    fixed_price: boolean;
    /** Pips per unit (an image, a second of video or speech). */
    fixed_cost: number;
    /**
     * A second's price per resolution, in pips (16:9, no input video), for a
     * video model priced by resolution — Seedance bills tokens, so 1080p
     * costs about 2.5× 720p. `fixed_cost` is then the default resolution's.
     */
    fixed_cost_by_resolution?: Record<string, number>;
    max_tokens: number;
    max_input_tokens: number;
    icon_url?: string;
    available_voices?: string[];
}
/**
 * One capability tag. Mirrors options_schema.Tag on the gateway. IDs
 * are stable across releases; Labels are subject to translation.
 */
export interface Tag {
    id: string;
    label: string;
}
/** True iff `model.capability_tags` includes a tag with the given stable ID. */
export declare const hasCapabilityTag: (model: Model, id: string) => boolean;
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
export declare const acceptsModality: (model: Model, modality: string) => boolean;
export interface ModelListOptions {
    /** Filter to one capability (e.g. "text", "vision", "image", "tts"). */
    capability?: string;
}
/** Convenience: TTS model accepts a reference audio clip as `voice`? */
export declare const supportsVoiceClone: (model: Model) => boolean;
/** Convenience: TTS model accepts a free-form `instruct_text` directive? */
export declare const supportsInstructText: (model: Model) => boolean;
/** Convenience: admin-set default voice for a TTS model, or null. */
export declare const defaultVoice: (model: Model) => string | null;
/**
 * The platform's default model among `models` — the admin-starred one for
 * the capability, else the first of the capability. With `capability`
 * given, only that capability is considered; without it, the first
 * default in list order (so pass a list from
 * `client.models.list({ capability })`). Null when the list has none.
 */
export declare const defaultModel: (models: Model[], capability?: string) => Model | null;
export declare class ModelsService {
    private readonly transport;
    constructor(transport: Transport);
    /**
     * List models available on the gateway. Pass `{ capability: "..." }` to
     * filter server-side. Needs no sign-in or key.
     */
    list(opts?: ModelListOptions, init?: {
        signal?: AbortSignal;
    }): Promise<Model[]>;
    /**
     * The platform's default model for a capability (`"text"` unless given):
     * the admin-starred one, else the first. What a request without `model`
     * would use before the user's own preference. Null when the capability
     * has no models.
     */
    default(capability?: string, init?: {
        signal?: AbortSignal;
    }): Promise<Model | null>;
}
//# sourceMappingURL=models.d.ts.map