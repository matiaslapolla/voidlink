import { Show } from "solid-js";
import type { ScanProgress } from "@/types/migration";

function formatTimestamp(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleTimeString();
}

interface RepositoryHeaderProps {
  scanStatus: ScanProgress | null;
  lastError: string | null;
}

export function RepositoryHeader(props: RepositoryHeaderProps) {
  return (
    <>
      <Show when={props.scanStatus}>
        {(status) => (
          <div class="border-b border-border px-3 py-2 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 bg-background/80">
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
          <div class="border-b border-border px-3 py-2">
            <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error()}
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
