import { useEditor, EditorContent } from "@tiptap/react";
import { useEffect } from "react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Focus from "@tiptap/extension-focus";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { GripVertical } from "lucide-react";
import { EditorToolbar } from "./EditorToolbar";
import { SlashCommand } from "./SlashCommand";
import { NestedPageNode } from "./NestedPageNode";
import { MarkdownPaste } from "./MarkdownPaste";
import "./editor.css";

interface EditorProps {
  content?: string;
  onUpdate?: (content: string) => void;
  onCreateChildPage?: () => string;
  onSelectPage?: (id: string) => void;
  pages?: { id: string; title: string }[];
}

export function Editor({
  content = "",
  onUpdate,
  onCreateChildPage,
  onSelectPage,
  pages,
}: EditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: 'Type "/" for commands…',
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Focus.configure({ className: "has-focus", mode: "deepest" }),
      SlashCommand,
      NestedPageNode,
      MarkdownPaste,
    ],
    content,
    onUpdate: ({ editor, transaction }) => {
      if (transaction.getMeta("pages-sync")) return;
      onUpdate?.(editor.getHTML());
    },
  });

  // Wire up nested page callbacks into editor storage
  useEffect(() => {
    if (!editor) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = editor.storage as Record<string, any>;
    if (storage.nestedPage) {
      storage.nestedPage.onSelectPage = onSelectPage ?? null;
      storage.nestedPage.onCreateChildPage = onCreateChildPage ?? null;
      storage.nestedPage.pages = pages ?? [];
      // Dispatch a no-op transaction so NodeViews re-render with updated page titles
      editor.view.dispatch(editor.state.tr.setMeta("pages-sync", true));
    }
  }, [editor, onSelectPage, onCreateChildPage, pages]);

  if (!editor) return null;

  return (
    <div className="flex flex-col h-full">
      <EditorToolbar editor={editor} />
      <div className="relative flex-1 overflow-y-auto p-6">
        <DragHandle editor={editor}>
          <GripVertical className="w-4 h-4" />
        </DragHandle>
        <EditorContent
          editor={editor}
          className="max-w-none min-h-full"
        />
      </div>
    </div>
  );
}
