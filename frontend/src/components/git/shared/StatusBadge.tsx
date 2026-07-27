/// The one place a git file status turns into something on screen.
///
/// voidlink used to draw statuses two different ways: lucide file glyphs in the
/// sidebar (`FilePlus`, `FileMinus`, …) and single letters in the compare view.
/// The glyphs lost — a letter says *which* change it is at a glance, which is
/// the whole point of the column, and it is the language every git UI worth
/// copying already speaks. Both call sites now share this module so a status can
/// never mean two different things in two panes.
///
/// The letters deliberately differ from VS Code's on one row: untracked files
/// get `A`, not `U`, and `U` is reserved for conflicts. In a changes list an
/// untracked file *is* an addition — it is what you are about to add — and
/// "unmerged" is the status that actually needs its own letter.

import type { JSX } from "solid-js";

export type StatusTone = "success" | "destructive" | "info" | "warning" | "muted";

export interface StatusGlyph {
  letter: string;
  tone: StatusTone;
  /// Full word, for the `title` attribute. A one-letter column is unreadable to
  /// anyone who hasn't learned the key, so the long form always stays reachable.
  label: string;
}

/// Map a status string — as returned by `git_file_status` and carried on
/// `FileDiff.status` — to its letter. Pure and total: an unrecognised status
/// yields `?` rather than throwing, because a new libgit2 status word should
/// degrade to "something changed" instead of taking the pane down.
export function statusLetter(status: string): StatusGlyph {
  switch (status) {
    case "added":
      return { letter: "A", tone: "success", label: "Added" };
    case "untracked":
      return { letter: "A", tone: "success", label: "Untracked" };
    case "modified":
      return { letter: "M", tone: "info", label: "Modified" };
    case "typechange":
      return { letter: "M", tone: "info", label: "Type changed" };
    case "deleted":
      return { letter: "D", tone: "destructive", label: "Deleted" };
    case "renamed":
      return { letter: "R", tone: "info", label: "Renamed" };
    case "copied":
      return { letter: "C", tone: "info", label: "Copied" };
    case "conflicted":
      return { letter: "U", tone: "warning", label: "Conflicted" };
    case "unmerged":
      return { letter: "U", tone: "warning", label: "Unmerged" };
    default:
      return { letter: "?", tone: "muted", label: status || "Unknown" };
  }
}

const TONE_CLASS: Record<StatusTone, string> = {
  success: "text-success",
  destructive: "text-destructive",
  info: "text-info",
  warning: "text-warning",
  muted: "text-muted-foreground",
};

export function statusToneClass(tone: StatusTone): string {
  return TONE_CLASS[tone];
}

/// Fixed-width so file names stay aligned down the column regardless of letter.
export function StatusBadge(props: { status: string; class?: string }): JSX.Element {
  const glyph = () => statusLetter(props.status);
  return (
    <span
      title={glyph().label}
      aria-label={glyph().label}
      class={`w-3 shrink-0 text-center font-mono text-[10px] font-bold leading-none tabular-nums ${statusToneClass(glyph().tone)} ${props.class ?? ""}`}
    >
      {glyph().letter}
    </span>
  );
}
