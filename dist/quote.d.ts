/**
 * What a call would cost, asked without running it: `client.video.quote`,
 * `client.image.quote` and `client.audio.quoteSpeech` send the call's own
 * parameters to `POST /v1/quote/<endpoint>`. The price is the one the
 * signed-in user would be charged, in USD, platform and creator fees
 * included — show it before a dear call (a 30 s 1080p video) starts.
 */
export interface Quote {
    total_cost: number;
    /** How the price was worked out, e.g. "720p 16:9 · 5s out · 108000 tokens …". */
    note?: string;
}
//# sourceMappingURL=quote.d.ts.map