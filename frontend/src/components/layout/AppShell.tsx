import type { JSX } from "solid-js";

interface AppShellProps {
  titleBar: JSX.Element;
  /// Far-left vertical column listing workspaces and their worktrees. Replaces
  /// the old full-width `tabBar` slot — the tab strip is per-worktree now and
  /// lives inside `main`.
  rail: JSX.Element;
  sidebar: JSX.Element;
  main: JSX.Element;
  rightSidebar: JSX.Element;
  statusBar: JSX.Element;
}

export function AppShell(props: AppShellProps) {
  return (
    <div class="flex flex-col h-screen w-screen text-foreground bg-background overflow-hidden">
      {props.titleBar}
      <div class="flex flex-1 overflow-hidden min-h-0">
        <div class="flex-shrink-0 flex">{props.rail}</div>
        <div class="flex-shrink-0 flex">{props.sidebar}</div>
        <div class="flex-1 flex flex-col overflow-hidden min-w-0 relative">{props.main}</div>
        <div class="flex-shrink-0 flex">{props.rightSidebar}</div>
      </div>
      {props.statusBar}
    </div>
  );
}
