import { splitProps } from "solid-js";
import type { JSX } from "solid-js";

import { cn } from "@/lib/utils";

interface SeparatorProps extends JSX.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
}

function Separator(props: SeparatorProps) {
  const [local, rest] = splitProps(props, ["class", "orientation"]);
  const orientation = () => local.orientation ?? "horizontal";
  return (
    <div
      role="separator"
      data-slot="separator"
      data-orientation={orientation()}
      aria-orientation={orientation()}
      class={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
        local.class
      )}
      {...rest}
    />
  );
}

export { Separator };
