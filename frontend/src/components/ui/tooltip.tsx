import { splitProps } from "solid-js";
import type { JSX } from "solid-js";
import {
  Root as TooltipRoot,
  Trigger as TooltipTriggerPrimitive,
  Portal as TooltipPortalPrimitive,
  Content as TooltipContentPrimitive,
  Arrow as TooltipArrowPrimitive,
} from "@kobalte/core/tooltip";

import { cn } from "@/lib/utils";

interface TooltipProviderProps {
  delay?: number;
  children?: JSX.Element;
}

function TooltipProvider(props: TooltipProviderProps) {
  // Kobalte doesn't have a separate provider; delay is set on Root
  return <>{props.children}</>;
}

interface TooltipProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delay?: number;
  children?: JSX.Element;
}

function Tooltip(props: TooltipProps) {
  return (
    <TooltipRoot
      openDelay={props.delay ?? 0}
      open={props.open}
      defaultOpen={props.defaultOpen}
      onOpenChange={props.onOpenChange}
    >
      {props.children}
    </TooltipRoot>
  );
}

function TooltipTrigger(props: JSX.HTMLAttributes<HTMLElement> & { children?: JSX.Element }) {
  return <TooltipTriggerPrimitive data-slot="tooltip-trigger" {...(props as any)} />;
}

interface TooltipContentProps extends JSX.HTMLAttributes<HTMLDivElement> {
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  align?: "start" | "center" | "end";
  alignOffset?: number;
  children?: JSX.Element;
}

function TooltipContent(props: TooltipContentProps) {
  const [local, rest] = splitProps(props, ["class", "side", "sideOffset", "align", "alignOffset", "children"]);
  return (
    <TooltipPortalPrimitive>
      <TooltipContentPrimitive
        data-slot="tooltip-content"
        class={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95",
          local.class
        )}
        {...(rest as any)}
      >
        {local.children}
        <TooltipArrowPrimitive class="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipContentPrimitive>
    </TooltipPortalPrimitive>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
