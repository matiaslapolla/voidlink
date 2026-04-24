import type { JSX } from "solid-js";

interface AppShellProps {
  titleBar: JSX.Element;
  tabBar: JSX.Element;
  sidebar: JSX.Element;
  main: JSX.Element;
  rightSidebar: JSX.Element;
}

export function AppShell(props: AppShellProps) {
  return (
    <div class="flex flex-col h-screen w-screen text-foreground bg-background overflow-hidden">
      {props.titleBar}
      {props.tabBar}
      <div class="flex flex-1 overflow-hidden min-h-0">
        <div class="flex-shrink-0 flex">{props.sidebar}</div>
        <div class="flex-1 flex flex-col overflow-hidden min-w-0 relative">{props.main}</div>
        <div class="flex-shrink-0 flex">{props.rightSidebar}</div>
      </div>
    </div>
  );
}
