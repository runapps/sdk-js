import type { Skill } from "./types.js";
export declare const MAX_SKILL_DESCRIPTION = 1024;
export interface ParsedSkill {
    skill: Skill;
    /** The instructions after the frontmatter. */
    body: string;
    warnings: string[];
}
/**
 * Parses a SKILL.md. `path` is where it sits in the workspace; the folder
 * name is the fallback for a missing `name`. Returns null when the file
 * has no usable description (such a skill is not loaded).
 */
export declare function parseSkill(text: string, path: string): ParsedSkill | null;
/**
 * The YAML subset frontmatter uses: `key: value` lines, quoted or plain
 * scalars, one level of nesting under `metadata:` (flattened to
 * `metadata.key`), `>`/`|` block scalars for long descriptions.
 */
export declare function parseFrontmatter(text: string): Record<string, string>;
//# sourceMappingURL=skills.d.ts.map