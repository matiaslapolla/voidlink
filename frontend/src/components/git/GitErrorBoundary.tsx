import { ErrorBoundary, type JSX } from "solid-js";
import { AlertTriangle } from "lucide-solid";

/// A boundary around a git surface.
///
/// SolidJS resources *rethrow* when read, and `repoInfo()` / `log()` are read
/// straight inside JSX and memos all over the sidebar with nothing above them to
/// catch it. So any command that hard-errored — and `git_repo_info`, `git_log`
/// and `git_list_refs` all used to hard-error on a repository with no commits —
/// took the entire panel down to a white rectangle with no way back.
///
/// This is deliberately not a generic app-wide boundary: what makes it useful is
/// the retry, and "retry" here means *this* pane refetching its git state, which
/// is exactly what the shared refresh pulse does.
export function GitErrorBoundary(props: {
  /// What failed, for the message: "Branches", "the git sidebar".
  surface: string;
  onRetry?: () => void;
  children: JSX.Element;
}) {
  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <div class="p-3 text-[12px] text-muted-foreground space-y-2">
          <div class="flex items-center gap-1.5 text-destructive">
            <AlertTriangle class="w-3.5 h-3.5 shrink-0" />
            <span class="font-medium">{props.surface} could not be read</span>
          </div>
          <p class="font-mono text-[11px] leading-snug break-words text-muted-foreground/90">
            {err instanceof Error ? err.message : String(err)}
          </p>
          <button
            onClick={() => {
              props.onRetry?.();
              reset();
            }}
            class="px-2 py-1 rounded border border-border text-[11px] hover:bg-accent/40 hover:text-foreground transition-colors"
          >
            Try again
          </button>
        </div>
      )}
    >
      {props.children}
    </ErrorBoundary>
  );
}
