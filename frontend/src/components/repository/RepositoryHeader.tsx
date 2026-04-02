import { Show } from "solid-js";
import { FolderOpen, RefreshCcw } from "lucide-solid";
import type { ScanProgress } from "@/types/migration";

function formatTimestamp(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleTimeString();
}

interface RepositoryHeaderProps {
  repoRoot: string | null;
  scanStatus: ScanProgress | null;
  lastError: string | null;
  onChooseRepo: () => void;
  onScan: (full: boolean) => void;
}

export function RepositoryHeader(props: RepositoryHeaderProps) {
  return (
    <header class="border-b border-border p-3 space-y-3 bg-background/80">
      <div class="flex flex-wrap items-center gap-2">
        <button
          onClick={props.onChooseRepo}
          class="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent/60"
        >
          <FolderOpen class="w-4 h-4" />
          Choose Repository
        </button>

        <button
          onClick={() => props.onScan(false)}
          disabled={!props.repoRoot}
          class="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-accent/60"
        >
          <RefreshCcw class="w-4 h-4" />
          Scan
        </button>

        <button
          onClick={() => props.onScan(true)}
          disabled={!props.repoRoot}
          class="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-accent/60"
        >
          Full Rescan
        </button>

        <div class="text-xs text-muted-foreground">
          {props.repoRoot ?? "Select a repository to begin"}
        </div>
      </div>

      <Show when={props.scanStatus}>
        {(status) => (
          <div class="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
            <span>scan: {status().status}</span>
            <span>scanned: {status().scannedFiles}</span>
            <span>indexed files: {status().indexedFiles}</span>
            <span>indexed chunks: {status().indexedChunks}</span>
            <span>finished: {formatTimestamp(status().finishedAt)}</span>
          </div>
        )}
      </Show>

      <Show when={props.lastError}>
        {(error) => (
          <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error()}
          </div>
        )}
      </Show>
    </header>
  );
}
