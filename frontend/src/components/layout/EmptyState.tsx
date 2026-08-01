/// The §9.7 empty state, rendered. The copy — and the rule that no two share
/// an icon or a sentence — lives in `emptyStates.ts`, which is DOM-free so it
/// can be tested in plain node.
import { Show, type Component, type JSX } from "solid-js";
import {
  Archive,
  Boxes,
  FileSearch,
  FolderGit2,
  GitCommit,
  LayoutGrid,
  PackageOpen,
  PanelsTopLeft,
  SearchX,
  Tag,
} from "lucide-solid";
import { EMPTY_STATES, type EmptyStateId } from "./emptyStates";

export type { EmptyStateId } from "./emptyStates";
export { EMPTY_STATES, emptyStateCollisions } from "./emptyStates";

type LucideIcon = Component<{ class?: string }>;

/// Name → component. The indirection exists so the registry stays importable
/// without a DOM; it is not a general icon lookup and should not become one.
const ICONS: Record<string, LucideIcon> = {
  Archive,
  Boxes,
  FileSearch,
  FolderGit2,
  GitCommit,
  LayoutGrid,
  PackageOpen,
  PanelsTopLeft,
  SearchX,
  Tag,
};

export interface EmptyStateProps {
  id: EmptyStateId;
  /// The fix, rendered as a real control. Prose telling the user what they
  /// could do instead of a thing they can press is the anti-pattern §9.7 names.
  action?: JSX.Element;
  /// Padding for the panel it sits in. Sidebar sections are short; a pane body
  /// has room to breathe.
  size?: "inline" | "pane";
  class?: string;
}

export function EmptyState(props: EmptyStateProps) {
  const copy = () => EMPTY_STATES[props.id];
  return (
    <div
      class={`flex flex-col items-center justify-center text-center gap-2 ${
        props.size === "pane" ? "py-10 px-6" : "py-6 px-3"
      } ${props.class ?? ""}`}
    >
      {(() => {
        const Icon = ICONS[copy().iconName];
        return <Icon class="w-5 h-5 text-muted-foreground opacity-60" />;
      })()}
      <p class="text-body text-muted-foreground max-w-[36ch]">{copy().line}</p>
      <Show when={props.action}>{props.action}</Show>
    </div>
  );
}

/// The accelerator an empty state offers. A button, never a sentence.
export function EmptyStateAction(props: {
  onClick: () => void;
  children: JSX.Element;
  chord?: string;
}) {
  return (
    <button
      onClick={props.onClick}
      class="mt-0.5 flex items-center gap-1.5 text-body px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {props.children}
      <Show when={props.chord}>
        <span class="text-micro font-mono text-muted-foreground/70">{props.chord}</span>
      </Show>
    </button>
  );
}
