import { splitProps } from "solid-js";
import type { JSX } from "solid-js";
import {
  Root as DialogRoot,
  Trigger as DialogTriggerPrimitive,
  Portal as DialogPortalPrimitive,
  Overlay as DialogOverlayPrimitive,
  Content as DialogContentPrimitive,
  Title as DialogTitlePrimitive,
  Description as DialogDescriptionPrimitive,
  CloseButton as DialogCloseButtonPrimitive,
} from "@kobalte/core/dialog";

import { cn } from "@/lib/utils";

function Dialog(props: JSX.HTMLAttributes<HTMLElement> & { open?: boolean; onOpenChange?: (open: boolean) => void; children?: JSX.Element }) {
  return <DialogRoot {...(props as any)} />;
}

function DialogTrigger(props: JSX.HTMLAttributes<HTMLElement> & { children?: JSX.Element }) {
  return <DialogTriggerPrimitive data-slot="dialog-trigger" {...(props as any)} />;
}

function DialogPortal(props: { children?: JSX.Element; mount?: Node }) {
  return <DialogPortalPrimitive {...(props as any)} />;
}

function DialogOverlay(props: JSX.HTMLAttributes<HTMLDivElement> & { children?: JSX.Element }) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DialogOverlayPrimitive
      data-slot="dialog-overlay"
      class={cn(
        "fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0",
        local.class,
      )}
      {...(rest as any)}
    />
  );
}

// Keep old name as alias for backwards compatibility
const DialogBackdrop = DialogOverlay;

function DialogContent(props: JSX.HTMLAttributes<HTMLDivElement> & { children?: JSX.Element }) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DialogContentPrimitive
      data-slot="dialog-content"
      class={cn(
        "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-popover text-popover-foreground border border-border rounded-lg shadow-lg p-6 data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95",
        local.class,
      )}
      {...(rest as any)}
    />
  );
}

// Keep old name as alias for backwards compatibility
const DialogPopup = DialogContent;

function DialogTitle(props: JSX.HTMLAttributes<HTMLHeadingElement> & { children?: JSX.Element }) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DialogTitlePrimitive
      data-slot="dialog-title"
      class={cn("text-lg font-semibold mb-2", local.class)}
      {...(rest as any)}
    />
  );
}

function DialogDescription(props: JSX.HTMLAttributes<HTMLParagraphElement> & { children?: JSX.Element }) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DialogDescriptionPrimitive
      data-slot="dialog-description"
      class={cn("text-sm text-muted-foreground mb-4", local.class)}
      {...(rest as any)}
    />
  );
}

function DialogClose(props: JSX.HTMLAttributes<HTMLElement> & { children?: JSX.Element }) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DialogCloseButtonPrimitive
      data-slot="dialog-close"
      class={cn(local.class)}
      {...(rest as any)}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogBackdrop,
  DialogContent,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogClose,
};
