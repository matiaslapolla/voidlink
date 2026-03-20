import { splitProps } from "solid-js";
import type { JSX } from "solid-js";

import { cn } from "@/lib/utils";

interface ScrollAreaProps extends JSX.HTMLAttributes<HTMLDivElement> {
  children?: JSX.Element;
}

function ScrollArea(props: ScrollAreaProps) {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <div
      data-slot="scroll-area"
      class={cn("overflow-y-auto relative", local.class)}
      {...rest}
    >
      {local.children}
    </div>
  );
}

interface ScrollBarProps extends JSX.HTMLAttributes<HTMLDivElement> {
  orientation?: "vertical" | "horizontal";
}

function ScrollBar(props: ScrollBarProps) {
  const [local, rest] = splitProps(props, ["class", "orientation"]);
  const orientation = () => local.orientation ?? "vertical";
  return (
    <div
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation()}
      class={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation() === "horizontal"
          ? "h-2.5 flex-col border-t border-t-transparent"
          : "h-full w-2.5 border-l border-l-transparent",
        local.class
      )}
      {...rest}
    >
      <div
        data-slot="scroll-area-thumb"
        class="relative flex-1 rounded-full bg-border"
      />
    </div>
  );
}

export { ScrollArea, ScrollBar };
