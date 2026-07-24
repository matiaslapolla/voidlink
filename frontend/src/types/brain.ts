export type BrainEntryType =
  | "decision"
  | "shipped"
  | "note"
  | "discovery"
  | "content"
  | "training";

export interface BrainEntry {
  id: string;
  entryType: BrainEntryType;
  title: string;
  project: string | null;
  ticket: string | null;
  labels: string[];
  created: string | null;
  /** Vault-relative path, e.g. "notes/2026-07-19-foo.md". */
  path: string;
}

export interface BrainEntryDetail extends BrainEntry {
  body: string;
}
