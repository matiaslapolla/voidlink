import type { SearchResult } from "./migration";

export type ContextItemKind = "search-result" | "file" | "diff-hunk" | "freetext";

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  /** Display label (file path, search anchor, or user-provided) */
  label: string;
  /** The actual content/snippet */
  content: string;
  /** Optional file path this item relates to */
  filePath?: string;
  /** Estimated token count (word-based approximation) */
  tokenEstimate: number;
  /** When this item was added */
  addedAt: number;
}

/** Convert a SearchResult to a ContextItem */
export function contextItemFromSearch(result: SearchResult): ContextItem {
  return {
    id: result.id,
    kind: "search-result",
    label: result.anchor,
    content: result.snippet,
    filePath: result.filePath,
    tokenEstimate: result.snippet.split(/\s+/).filter(Boolean).length,
    addedAt: Date.now(),
  };
}

/** Create a context item from a diff hunk */
export function contextItemFromDiff(filePath: string, hunkContent: string): ContextItem {
  return {
    id: crypto.randomUUID(),
    kind: "diff-hunk",
    label: filePath,
    content: hunkContent,
    filePath,
    tokenEstimate: hunkContent.split(/\s+/).filter(Boolean).length,
    addedAt: Date.now(),
  };
}

/** Create a freetext context item */
export function contextItemFromText(label: string, content: string): ContextItem {
  return {
    id: crypto.randomUUID(),
    kind: "freetext",
    label,
    content,
    tokenEstimate: content.split(/\s+/).filter(Boolean).length,
    addedAt: Date.now(),
  };
}
