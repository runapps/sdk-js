export interface TextEdit {
    oldText: string;
    newText: string;
}
export declare function normalizeForFuzzyMatch(text: string): string;
/**
 * Applies `edits` to `content`. Each oldText must occur exactly once and
 * the matches must not overlap. Returns the new content; throws with
 * pi's wording when an edit cannot be applied.
 */
export declare function applyEdits(path: string, content: string, edits: TextEdit[]): string;
//# sourceMappingURL=edit.d.ts.map