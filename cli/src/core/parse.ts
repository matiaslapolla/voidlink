/**
 * Reading the vault back.
 *
 * `builders.ts` is the write half — RegisterInput to markdown. This is the read
 * half: markdown back to a structured record. PURE — no IO, no filesystem. The
 * caller supplies raw file contents.
 *
 * This is deliberately a *narrow* frontmatter reader, not a YAML parser. It
 * understands exactly the shapes `buildFrontmatter` emits — scalars, flow
 * arrays, and the `links:` block list — because those are the only shapes the
 * vault contains. A general YAML dependency would buy nothing and would happily
 * accept documents the rest of this contract can't represent.
 */

import { TYPE_FOLDER } from "./builders.js";
import { ENTRY_TYPES } from "./contract.js";
import type { EntryType } from "./contract.js";

/** A parsed vault entry. `created` stays a string — it's an ISO-8601 stamp. */
export interface ParsedEntry {
  id: string;
  type: EntryType;
  title: string;
  project?: string;
  ticket?: string;
  labels: string[];
  created: string;
  /** Wikilink targets from the frontmatter `links:` block, verbatim. */
  links: string[];
  body: string;
}

/** Folder name -> entry type, the inverse of TYPE_FOLDER. */
export const FOLDER_TYPE: Record<string, EntryType> = Object.fromEntries(
  ENTRY_TYPES.map((t) => [TYPE_FOLDER[t], t]),
) as Record<string, EntryType>;

/**
 * Undo `yamlScalar`. Bare scalars pass through; double-quoted ones are
 * unescaped. Single quotes are not emitted by the writer, so a value that
 * starts with one is treated as a bare scalar rather than guessed at.
 */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return value;
}

/** Parse a YAML flow array — `[a, "b, c"]` — respecting quoted commas. */
function parseFlowArray(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];

  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (const ch of inner) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inQuotes) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(unquote(current));
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(unquote(current));

  return out.filter((s) => s !== "");
}

/**
 * Split a document into its frontmatter lines and body. Returns undefined when
 * the document has no `---`-fenced frontmatter at all, which is the signal to
 * skip a file rather than to throw — `vault/` holds hand-written notes with no
 * frontmatter, and index notes are regenerated wholesale.
 */
function splitFrontmatter(
  contents: string,
): { lines: string[]; body: string } | undefined {
  const normalized = contents.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return undefined;

  const rest = normalized.slice(3);
  if (!/^\r?\n/.test(rest)) return undefined;

  // The closing fence is a line that is exactly "---".
  const closing = rest.match(/\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!closing || closing.index === undefined) return undefined;

  const block = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + closing[0].length);

  return { lines: block.split(/\r?\n/).filter((l) => l.trim() !== ""), body };
}

/**
 * Parse one entry file. Returns undefined for anything that isn't a typed
 * entry — no frontmatter, an index note (`type: index`), an unknown type, or a
 * missing id. A dangling or malformed file is skipped, never fatal: the index
 * is derived and rebuildable, so one bad file must not take down a whole
 * reindex.
 */
export function parseEntry(contents: string): ParsedEntry | undefined {
  const split = splitFrontmatter(contents);
  if (!split) return undefined;

  const scalars = new Map<string, string>();
  const links: string[] = [];
  let inLinks = false;

  for (const line of split.lines) {
    // Block-list items under `links:` are indented "  - "[[...]]"".
    if (inLinks && /^\s+-\s/.test(line)) {
      const item = unquote(line.replace(/^\s+-\s*/, ""));
      const wikilink = item.match(/^\[\[(.+)\]\]$/);
      links.push(wikilink?.[1] ?? item);
      continue;
    }

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) {
      inLinks = false;
      continue;
    }

    const key = kv[1];
    const value = kv[2] ?? "";
    if (key === undefined) continue;

    if (key === "links") {
      inLinks = true;
      continue;
    }
    inLinks = false;
    scalars.set(key, value);
  }

  const rawType = scalars.get("type");
  if (rawType === undefined) return undefined;
  const type = unquote(rawType) as EntryType;
  if (!(ENTRY_TYPES as readonly string[]).includes(type)) return undefined;

  const rawId = scalars.get("id");
  if (rawId === undefined) return undefined;
  const id = unquote(rawId);
  if (!id) return undefined;

  const rawLabels = scalars.get("labels");
  const project = scalars.get("project");
  const ticket = scalars.get("ticket");

  const entry: ParsedEntry = {
    id,
    type,
    title: unquote(scalars.get("title") ?? ""),
    labels: rawLabels === undefined ? [] : parseFlowArray(rawLabels),
    created: unquote(scalars.get("created") ?? ""),
    links,
    body: split.body.replace(/\s+$/, ""),
  };

  if (project !== undefined && unquote(project)) entry.project = unquote(project);
  if (ticket !== undefined && unquote(ticket)) entry.ticket = unquote(ticket);

  return entry;
}
