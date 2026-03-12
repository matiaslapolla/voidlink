import type { Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Quote } from "lucide-react";
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

export function EditorToolbar({ editor }: EditorToolbarProps) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-4 py-2 flex-wrap">
      <Button
        variant={editor.isActive("bold") ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleBold().run())}
      >
        B
      </Button>
      <Button
        variant={editor.isActive("italic") ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleItalic().run())}
      >
        I
      </Button>
      <Button
        variant={editor.isActive("strike") ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleStrike().run())}
      >
        S
      </Button>
      <Button
        variant={editor.isActive("code") ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleCode().run())}
      >
        {"<>"}
      </Button>

      <Separator orientation="vertical" className="h-6 mx-1" />

      <Button
        variant={editor.isActive("heading", { level: 1 }) ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleHeading({ level: 1 }).run())}
      >
        H1
      </Button>
      <Button
        variant={editor.isActive("heading", { level: 2 }) ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}
      >
        H2
      </Button>
      <Button
        variant={editor.isActive("heading", { level: 3 }) ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}
      >
        H3
      </Button>

      <Separator orientation="vertical" className="h-6 mx-1" />

      <Button
        variant={editor.isActive("bulletList") ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleBulletList().run())}
      >
        List
      </Button>
      <Button
        variant={editor.isActive("orderedList") ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleOrderedList().run())}
      >
        1.
      </Button>
      <Button
        variant={editor.isActive("taskList") ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleTaskList().run())}
      >
        Tasks
      </Button>
      <Button
        variant={editor.isActive("codeBlock") ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleCodeBlock().run())}
      >
        Code
      </Button>

      <Separator orientation="vertical" className="h-6 mx-1" />

      <Button
        variant="ghost"
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().setHorizontalRule().run())}
      >
        —
      </Button>
      <Button
        variant={editor.isActive("blockquote") ? "default" : "ghost"}
        size="sm"
        onMouseDown={cmd(() => editor.chain().focus().toggleBlockquote().run())}
      >
        <Quote className="w-4 h-4" />
      </Button>

      <div className="ml-auto">
        <ExportMenu editor={editor} />
      </div>
    </div>
  );
}
