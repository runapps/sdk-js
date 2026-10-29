// The built-in file tools over a Workspace: list, read (with line
// ranges), write, edit (exact replacement), delete, search. Their
// descriptions are what the model reads, so they say what each does and
// what comes back.

import { defineTool } from "./tool.js";
import type { Tool } from "./types.js";
import { normalizePath, type Workspace } from "./workspace.js";

const MAX_LIST = 400;
const MAX_READ_LINES = 2000;
const MAX_SEARCH_HITS = 60;

export function fileTools(ws: Workspace): Tool[] {
  return [
    defineTool<{ path?: string }>({
      name: "list_files",
      description:
        "List the files under a folder of the workspace (recursive), one per line with the size in bytes. Start at / to see everything; /skills holds the skills.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Folder to list. Default /" } },
        additionalProperties: false,
      },
      async execute({ path }) {
        const files = await ws.list(path || "/");
        if (!files.length) return `No files under ${normalizePath(path || "/")}.`;
        const lines = files.slice(0, MAX_LIST).map((f) => `${f.path}  (${f.size} B)`);
        if (files.length > MAX_LIST) lines.push(`… ${files.length - MAX_LIST} more; list a sub-folder.`);
        return lines.join("\n");
      },
    }),

    defineTool<{ path: string; start_line?: number; end_line?: number }>({
      name: "read_file",
      description:
        "Read a text file from the workspace. Returns the whole file, or the lines from start_line to end_line (1-based, inclusive) for long files. Binary files are described, not returned.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute({ path, start_line, end_line }) {
        if (await ws.isFolder(path)) {
          const files = await ws.list(path);
          return `${normalizePath(path)} is a folder with ${files.length} file${files.length === 1 ? "" : "s"}:\n` +
            files.slice(0, MAX_LIST).map((f) => `${f.path}  (${f.size} B)`).join("\n");
        }
        const { data, size, contentType } = await ws.read(path);
        let text: string;
        if (typeof data === "string") text = data;
        else {
          const { decodeText } = await import("./workspace.js");
          const t = decodeText(data);
          if (t === null) return `${normalizePath(path)} is a binary file (${contentType ?? "unknown type"}, ${size} bytes).`;
          text = t;
        }
        const lines = text.split("\n");
        if (start_line === undefined && end_line === undefined && lines.length <= MAX_READ_LINES) return text;
        const from = Math.max(1, start_line ?? 1);
        const to = Math.min(lines.length, end_line ?? from + MAX_READ_LINES - 1);
        if (from > lines.length) return `The file has ${lines.length} lines; start_line ${from} is past the end.`;
        const slice = lines.slice(from - 1, to).join("\n");
        return `[${normalizePath(path)}: lines ${from}-${to} of ${lines.length}]\n${slice}`;
      },
    }),

    defineTool<{ path: string; content: string }>({
      name: "write_file",
      description:
        "Create or overwrite a text file in the workspace with the given content. Folders are implied by the path. Prefer edit_file for small changes to an existing file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute({ path, content }) {
        const existed = await ws.exists(path);
        await ws.write(path, content);
        return `${existed ? "Updated" : "Created"} ${normalizePath(path)} (${new TextEncoder().encode(content).byteLength} bytes).`;
      },
    }),

    defineTool<{ path: string; old_text: string; new_text: string }>({
      name: "edit_file",
      description:
        "Replace one exact occurrence of old_text in a workspace file with new_text. old_text must match exactly once, whitespace included; include enough surrounding lines to make it unique. Use an empty new_text to delete the passage.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old_text: { type: "string", minLength: 1 }, new_text: { type: "string" } },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
      async execute({ path, old_text, new_text }) {
        const text = await ws.readText(path);
        const count = text.split(old_text).length - 1;
        if (count === 0) throw new Error(`old_text was not found in ${normalizePath(path)}. Read the file and copy the passage exactly.`);
        if (count > 1) throw new Error(`old_text occurs ${count} times in ${normalizePath(path)}; include more context so it matches once.`);
        await ws.write(path, text.replace(old_text, () => new_text));
        return `Edited ${normalizePath(path)}.`;
      },
    }),

    defineTool<{ path: string }>({
      name: "delete_file",
      description: "Delete a file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      destructive: true,
      confirm: ({ path }) => `Delete ${normalizePath(path)}?`,
      async execute({ path }) {
        await ws.delete(path);
        return `Deleted ${normalizePath(path)}.`;
      },
    }),

    defineTool<{ query: string; path?: string; regex?: boolean }>({
      name: "search_files",
      description:
        "Search the text files of the workspace for a string (or a regular expression with regex: true). Returns matching lines as path:line: text, at most 60.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          path: { type: "string", description: "Folder to search. Default /" },
          regex: { type: "boolean" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute({ query, path, regex }, ctx) {
        let re: RegExp;
        try {
          re = regex ? new RegExp(query, "i") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        } catch (e) {
          throw new Error(`Invalid regular expression: ${(e as Error).message}`);
        }
        const hits: string[] = [];
        let scanned = 0;
        for (const f of await ws.list(path || "/")) {
          ctx.signal.throwIfAborted();
          if (f.size > 2_000_000) continue;
          let text: string;
          try {
            text = await ws.readText(f.path);
          } catch {
            continue;
          }
          scanned++;
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
            if (re.test(lines[i]!)) hits.push(`${f.path}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          }
          if (hits.length >= MAX_SEARCH_HITS) break;
        }
        if (!hits.length) return `No matches for ${JSON.stringify(query)} in ${scanned} text files.`;
        return hits.join("\n") + (hits.length >= MAX_SEARCH_HITS ? `\n… stopped at ${MAX_SEARCH_HITS} matches; narrow the search.` : "");
      },
    }),
  ];
}
