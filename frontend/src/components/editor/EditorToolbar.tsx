import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Type, Heading, List, Plus, Quote } from "lucide-react";
import { ExportMenu } from "./ExportMenu";

interface EditorToolbarProps {
  editor: Editor;
}

// Prevent the editor from losing selection when clicking toolbar buttons
function cmd(fn: () => void) {
  return (e: React.MouseEvent) => {
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
  icon: React.ComponentType<{ className?: string }>;
  items: ToolbarItem[];
}

function ToolbarGroupPopover({ group, editor }: { group: GroupDef; editor: Editor }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const hasActive = group.items.some((item) => {
    if (!item.active) return false;
    if (Array.isArray(item.active)) return editor.isActive(item.active[0], item.active[1]);
    return editor.isActive(item.active);
  });

  const Icon = group.icon;

  return (
    <div className="relative" ref={ref}>
      <Button
        variant={hasActive ? "default" : "ghost"}
        size="sm"
        onMouseDown={(e) => { e.preventDefault(); setOpen(!open); }}
        title={group.label}
      >
        <Icon className="w-4 h-4" />
      </Button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded-lg shadow-md p-1 min-w-[120px] z-50 flex flex-col gap-0.5">
          {group.items.map((item) => {
            const isActive = item.active
              ? Array.isArray(item.active)
                ? editor.isActive(item.active[0], item.active[1])
                : editor.isActive(item.active)
              : false;
            return (
              <button
                key={item.label}
                className={`w-full text-left px-3 py-1.5 text-xs rounded-md transition-colors ${
                  isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent"
                }`}
                onMouseDown={cmd(item.action)}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function EditorToolbar({ editor }: EditorToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.width < 500);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const groups: GroupDef[] = [
    {
      label: "Text",
      icon: Type,
      items: [
        { label: "B", active: "bold", action: () => editor.chain().focus().toggleBold().run() },
        { label: "I", active: "italic", action: () => editor.chain().focus().toggleItalic().run() },
        { label: "S", active: "strike", action: () => editor.chain().focus().toggleStrike().run() },
        { label: "<>", active: "code", action: () => editor.chain().focus().toggleCode().run() },
      ],
    },
    {
      label: "Heading",
      icon: Heading,
      items: [
        { label: "H1", active: ["heading", { level: 1 }], action: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
        { label: "H2", active: ["heading", { level: 2 }], action: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
        { label: "H3", active: ["heading", { level: 3 }], action: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
      ],
    },
    {
      label: "Lists",
      icon: List,
      items: [
        { label: "List", active: "bulletList", action: () => editor.chain().focus().toggleBulletList().run() },
        { label: "1.", active: "orderedList", action: () => editor.chain().focus().toggleOrderedList().run() },
        { label: "Tasks", active: "taskList", action: () => editor.chain().focus().toggleTaskList().run() },
        { label: "Code", active: "codeBlock", action: () => editor.chain().focus().toggleCodeBlock().run() },
      ],
    },
    {
      label: "Insert",
      icon: Plus,
      items: [
        { label: "\u2014", active: null, action: () => editor.chain().focus().setHorizontalRule().run() },
        { label: "Quote", active: "blockquote", action: () => editor.chain().focus().toggleBlockquote().run() },
      ],
    },
  ];

  return (
    <div ref={toolbarRef} className="flex items-center gap-1 border-b border-border px-4 py-2 flex-shrink-0">
      {compact ? (
        <>
          {groups.map((g) => (
            <ToolbarGroupPopover key={g.label} group={g} editor={editor} />
          ))}
        </>
      ) : (
        <>
          <Button variant={editor.isActive("bold") ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleBold().run())}>B</Button>
          <Button variant={editor.isActive("italic") ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleItalic().run())}>I</Button>
          <Button variant={editor.isActive("strike") ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleStrike().run())}>S</Button>
          <Button variant={editor.isActive("code") ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleCode().run())}>{"<>"}</Button>

          <Separator orientation="vertical" className="h-6 mx-1" />

          <Button variant={editor.isActive("heading", { level: 1 }) ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleHeading({ level: 1 }).run())}>H1</Button>
          <Button variant={editor.isActive("heading", { level: 2 }) ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}>H2</Button>
          <Button variant={editor.isActive("heading", { level: 3 }) ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}>H3</Button>

          <Separator orientation="vertical" className="h-6 mx-1" />

          <Button variant={editor.isActive("bulletList") ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleBulletList().run())}>List</Button>
          <Button variant={editor.isActive("orderedList") ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleOrderedList().run())}>1.</Button>
          <Button variant={editor.isActive("taskList") ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleTaskList().run())}>Tasks</Button>
          <Button variant={editor.isActive("codeBlock") ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleCodeBlock().run())}>Code</Button>

          <Separator orientation="vertical" className="h-6 mx-1" />

          <Button variant="ghost" size="sm" onMouseDown={cmd(() => editor.chain().focus().setHorizontalRule().run())}>{"\u2014"}</Button>
          <Button variant={editor.isActive("blockquote") ? "default" : "ghost"} size="sm" onMouseDown={cmd(() => editor.chain().focus().toggleBlockquote().run())}><Quote className="w-4 h-4" /></Button>
        </>
      )}
      <div className="ml-auto">
        <ExportMenu editor={editor} />
      </div>
    </div>
  );
}
