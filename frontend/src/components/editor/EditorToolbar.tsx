import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import type { Editor } from "@tiptap/core";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Type, Heading, List, Plus } from "lucide-solid";
import { ExportMenu } from "./ExportMenu";

interface EditorToolbarProps {
  editor: Editor;
}

// Prevent the editor from losing selection when clicking toolbar buttons
function cmd(fn: () => void) {
  return (e: MouseEvent) => {
    e.preventDefault();
    fn();
  };
}

interface ToolbarItem {
  label: string;
  active: string | [string, Record<string, unknown>] | null;
  action: () => void;
}

interface GroupDef {
  label: string;
  icon: (props: { class?: string }) => any;
  items: ToolbarItem[];
}

function ToolbarGroupPopover(props: { group: GroupDef; editor: Editor }) {
  const [open, setOpen] = createSignal(false);
  let ref: HTMLDivElement | undefined;

  onMount(() => {
    const handler = (e: MouseEvent) => {
      if (ref && !ref.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    onCleanup(() => document.removeEventListener("mousedown", handler));
  });

  const hasActive = () => props.group.items.some((item) => {
    if (!item.active) return false;
    if (Array.isArray(item.active)) return props.editor.isActive(item.active[0], item.active[1]);
    return props.editor.isActive(item.active);
  });

  const Icon = props.group.icon;

  return (
    <div class="relative" ref={ref}>
      <Button
        variant={hasActive() ? "default" : "ghost"}
        size="sm"
        onMouseDown={(e: MouseEvent) => { e.preventDefault(); setOpen(!open()); }}
        title={props.group.label}
      >
        <Icon class="w-4 h-4" />
      </Button>
      <Show when={open()}>
        <div class="absolute top-full left-0 mt-1 bg-popover border border-border rounded-lg shadow-md p-1 min-w-[120px] z-50 flex flex-col gap-0.5">
          <For each={props.group.items}>
            {(item) => {
              const isActive = () => item.active
                ? Array.isArray(item.active)
                  ? props.editor.isActive(item.active[0], item.active[1])
                  : props.editor.isActive(item.active)
                : false;
              return (
                <button
                  class={`w-full text-left px-3 py-1.5 text-xs rounded-md transition-colors ${
                    isActive() ? "bg-accent text-accent-foreground" : "hover:bg-accent"
                  }`}
                  onMouseDown={cmd(item.action)}
                >
                  {item.label}
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function EditorToolbar(props: EditorToolbarProps) {
  let toolbarRef: HTMLDivElement | undefined;
  const [compact, setCompact] = createSignal(false);

  onMount(() => {
    const el = toolbarRef;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.width < 500);
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  const groups: GroupDef[] = [
    {
      label: "Text",
      icon: Type,
      items: [
        { label: "B", active: "bold", action: () => props.editor.chain().focus().toggleBold().run() },
        { label: "I", active: "italic", action: () => props.editor.chain().focus().toggleItalic().run() },
        { label: "S", active: "strike", action: () => props.editor.chain().focus().toggleStrike().run() },
        { label: "<>", active: "code", action: () => props.editor.chain().focus().toggleCode().run() },
      ],
    },
    {
      label: "Heading",
      icon: Heading,
      items: [
        { label: "H1", active: ["heading", { level: 1 }], action: () => props.editor.chain().focus().toggleHeading({ level: 1 }).run() },
        { label: "H2", active: ["heading", { level: 2 }], action: () => props.editor.chain().focus().toggleHeading({ level: 2 }).run() },
        { label: "H3", active: ["heading", { level: 3 }], action: () => props.editor.chain().focus().toggleHeading({ level: 3 }).run() },
      ],
    },
    {
      label: "Lists",
      icon: List,
      items: [
        { label: "List", active: "bulletList", action: () => props.editor.chain().focus().toggleBulletList().run() },
        { label: "1.", active: "orderedList", action: () => props.editor.chain().focus().toggleOrderedList().run() },
        { label: "Tasks", active: "taskList", action: () => props.editor.chain().focus().toggleTaskList().run() },
        { label: "Code", active: "codeBlock", action: () => props.editor.chain().focus().toggleCodeBlock().run() },
      ],
    },
    {
      label: "Insert",
      icon: Plus,
      items: [
        { label: "\u2014", active: null, action: () => props.editor.chain().focus().setHorizontalRule().run() },
        { label: "Quote", active: "blockquote", action: () => props.editor.chain().focus().toggleBlockquote().run() },
      ],
    },
  ];

  return (
    <div ref={toolbarRef} class="flex items-center gap-1 border-b border-border px-4 py-2 flex-shrink-0">
      <Show
        when={compact()}
        fallback={
          <>
            <For each={groups}>
              {(group, groupIdx) => (
                <>
                  <Show when={groupIdx() > 0}>
                    <Separator orientation="vertical" class="h-6 mx-1" />
                  </Show>
                  <For each={group.items}>
                    {(item) => {
                      const isActive = () => item.active
                        ? Array.isArray(item.active)
                          ? props.editor.isActive(item.active[0], item.active[1])
                          : props.editor.isActive(item.active)
                        : false;
                      return (
                        <Button
                          variant={isActive() ? "default" : "ghost"}
                          size="sm"
                          onMouseDown={cmd(item.action)}
                        >
                          {item.label}
                        </Button>
                      );
                    }}
                  </For>
                </>
              )}
            </For>
          </>
        }
      >
        <For each={groups}>
          {(g) => <ToolbarGroupPopover group={g} editor={props.editor} />}
        </For>
      </Show>
      <div class="ml-auto">
        <ExportMenu editor={props.editor} />
      </div>
    </div>
  );
}
