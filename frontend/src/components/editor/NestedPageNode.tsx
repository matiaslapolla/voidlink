import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { FileText } from "lucide-react";

function NestedPageNodeView({ node, editor }: NodeViewProps) {
  const { pageId } = node.attrs as { pageId: string };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storage = editor.storage as Record<string, any>;
  const pages = storage.nestedPage?.pages as { id: string; title: string }[] | undefined;
  const liveTitle = pages?.find((p) => p.id === pageId)?.title ?? "Untitled";

  const handleClick = () => {
    const onSelectPage = storage.nestedPage?.onSelectPage as
      | ((id: string) => void)
      | null;
    onSelectPage?.(pageId);
  };

  return (
    <NodeViewWrapper>
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-md border border-border cursor-pointer hover:bg-accent/50 my-1 select-none"
        onClick={handleClick}
        contentEditable={false}
      >
        <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm font-medium">{liveTitle}</span>
      </div>
    </NodeViewWrapper>
  );
}

export const NestedPageNode = Node.create({
  name: "nestedPage",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      pageId: { default: null },
      pageTitle: { default: "Untitled" },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="nested-page"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "nested-page" })];
  },

  addStorage() {
    return {
      onSelectPage: null as ((id: string) => void) | null,
      onCreateChildPage: null as (() => string) | null,
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(NestedPageNodeView);
  },
});
