import { splitProps } from "solid-js";
import type { JSX } from "solid-js";
import {
  Root as ContextMenuRoot,
  Trigger as ContextMenuTriggerPrimitive,
  Portal as ContextMenuPortalPrimitive,
  Content as ContextMenuContentPrimitive,
  Item as ContextMenuItemPrimitive,
  Separator as ContextMenuSeparatorPrimitive,
} from "@kobalte/core/context-menu";
import { cn } from "@/lib/utils";

function ContextMenu(props: { children?: JSX.Element }) {
  return <ContextMenuRoot {...props} />;
}

function ContextMenuTrigger(props: JSX.HTMLAttributes<HTMLElement> & { children?: JSX.Element; as?: any }) {
  return <ContextMenuTriggerPrimitive as={props.as ?? "div"} {...(props as any)} />;
}

function ContextMenuPortal(props: { children?: JSX.Element }) {
  return <ContextMenuPortalPrimitive {...(props as any)} />;
}

function ContextMenuContent(props: JSX.HTMLAttributes<HTMLDivElement> & { children?: JSX.Element }) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <ContextMenuPortal>
      <ContextMenuContentPrimitive
        class={cn(
          "z-[9999] min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95",
          local.class,
        )}
        {...(rest as any)}
      />
    </ContextMenuPortal>
  );
}

function ContextMenuItem(
  props: JSX.HTMLAttributes<HTMLDivElement> & {
    children?: JSX.Element;
    onSelect?: () => void;
    disabled?: boolean;
    destructive?: boolean;
  },
) {
  const [local, rest] = splitProps(props, ["class", "onSelect", "disabled", "destructive"]);
  return (
    <ContextMenuItemPrimitive
      onSelect={local.onSelect}
      disabled={local.disabled}
      class={cn(
        "flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs cursor-pointer outline-none transition-colors select-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        "data-[disabled]:opacity-40 data-[disabled]:pointer-events-none",
        local.destructive && "text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive",
        local.class,
      )}
      {...(rest as any)}
    />
  );
}

function ContextMenuSeparator(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <ContextMenuSeparatorPrimitive
      class={cn("my-1 h-px bg-border", local.class)}
      {...(rest as any)}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
};
