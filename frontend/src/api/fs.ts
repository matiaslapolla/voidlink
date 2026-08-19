import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null;
  /// Only ever true when the entry was listed with `includeIgnored` — it means
  /// gitignore would otherwise have hidden it.
  ignored: boolean;
}

/// One hit, as the Rust walker reports it. Line and column are 1-based and
/// column counts characters, so both drop straight into a Monaco position.
export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  /// The matched line, windowed around the hit for long lines.
  preview: string;
  /// The hit's 1-based offset inside `preview`, which differs from `column`
  /// whenever the head of the line was trimmed away.
  previewColumn: number;
  length: number;
}

export interface SearchError {
  path: string;
  message: string;
}

export interface SearchSummary {
  filesScanned: number;
  filesMatched: number;
  matches: number;
  /// The result cap was reached and the walk stopped. Never present it as a
  /// complete result set.
  truncated: boolean;
  /// A newer query superseded this one. Discard everything it delivered.
  cancelled: boolean;
  errors: SearchError[];
}

/// Modification stamp for one path, as `fs_stat_files` reports it.
export interface FileStamp {
  path: string;
  exists: boolean;
  /// Seconds since the epoch, or `null` where the filesystem does not say.
  modified: number | null;
  size: number;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  includeIgnored?: boolean;
  maxResults?: number;
}

export interface SearchBatch {
  searchId: string;
  seq: number;
  matches: SearchMatch[];
}

const SEARCH_BATCH_EVENT = "fs-search-batch";

export const fsApi = {
  listDir(path: string, includeIgnored?: boolean): Promise<FsEntry[]> {
    return invoke<FsEntry[]>("fs_list_dir", { path, includeIgnored: includeIgnored ?? false });
  },

  readFile(path: string): Promise<string> {
    return invoke<string>("fs_read_file", { path });
  },

  writeFile(path: string, content: string): Promise<void> {
    return invoke<void>("fs_write_file", { path, content });
  },

  createFile(path: string): Promise<void> {
    return invoke<void>("fs_create_file", { path });
  },

  createDir(path: string): Promise<void> {
    return invoke<void>("fs_create_dir", { path });
  },

  rename(from: string, to: string): Promise<void> {
    return invoke<void>("fs_rename", { from, to });
  },

  delete(path: string): Promise<void> {
    return invoke<void>("fs_delete", { path });
  },

  /// Recursive for directories. `to` is the full destination path, and an
  /// occupied one is refused rather than overwritten — the explorer derives a
  /// free name before it calls this.
  copy(from: string, to: string): Promise<void> {
    return invoke<void>("fs_copy", { from, to });
  },

  findRepoRoot(path: string): Promise<string | null> {
    return invoke<string | null>("fs_find_repo_root", { path });
  },

  /// Walk `root` for `query`, resolving with the summary once the walk ends.
  ///
  /// Matches arrive through `onSearchBatch`, not through this promise: a
  /// repo-wide traversal takes seconds and a panel that renders nothing until
  /// it finishes reads as broken. `searchId` is the caller's handle for
  /// cancellation and its only way to tell this query's batches from a
  /// superseded one's.
  searchFiles(
    searchId: string,
    root: string,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchSummary> {
    return invoke<SearchSummary>("fs_search_files", { searchId, root, query, options });
  },

  /// Supersede an in-flight search. The walk stops at its next file, so one
  /// last batch may still arrive — callers filter on `searchId` regardless.
  cancelSearch(searchId: string): Promise<void> {
    return invoke<void>("fs_search_cancel", { searchId });
  },

  /// Stat a batch of paths in one round trip. Used to notice out-of-band
  /// edits under open tabs; see `components/editor/externalChanges.ts` for why
  /// this is polled rather than watched.
  statFiles(paths: string[]): Promise<FileStamp[]> {
    return invoke<FileStamp[]>("fs_stat_files", { paths });
  },

  onSearchBatch(handler: (batch: SearchBatch) => void): Promise<UnlistenFn> {
    return listen<SearchBatch>(SEARCH_BATCH_EVENT, (e) => handler(e.payload));
  },
};
