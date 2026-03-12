import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useCallback,
} from "react";
import type { Editor } from "@tiptap/core";
import { FileText } from "lucide-react";
import tippy from "tippy.js";
import type { Instance } from "tippy.js";

interface CommandItem {
  title: string;
  description: string;
  icon?: React.ReactNode;
  command: (props: { editor: Editor; range: { from: number; to: number } }) => void;
}

const commands: CommandItem[] = [
  {
    title: "Heading 1",
    description: "Large section heading",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run();
    },
  },
  {
    title: "Heading 2",
    description: "Medium section heading",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run();
    },
  },
  {
    title: "Heading 3",
    description: "Small section heading",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run();
    },
  },
  {
    title: "Bullet List",
    description: "Unordered list",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    title: "Numbered List",
    description: "Ordered list",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    title: "Task List",
    description: "Checklist with checkboxes",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
    },
  },
  {
    title: "Code Block",
    description: "Code snippet",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
    },
  },
  {
    title: "Blockquote",
    description: "Quote block",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
    },
  },
  {
    title: "Divider",
    description: "Horizontal rule",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run();
    },
  },
  {
    title: "Page",
    description: "Create a nested page",
    icon: <FileText className="w-3.5 h-3.5" />,
    command: ({ editor, range }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const storage = editor.storage as Record<string, any>;
      const createFn = storage.nestedPage?.onCreateChildPage as
        | (() => string)
        | null;
      if (!createFn) return;
      const id = createFn();
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: "nestedPage", attrs: { pageId: id, pageTitle: "Untitled" } })
        .run();
    },
  },
];

interface CommandListRef {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const CommandList = forwardRef<CommandListRef, SuggestionProps<CommandItem>>(
  (props, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    const selectItem = useCallback(
      (index: number) => {
        const item = props.items[index];
        if (item) {
          props.command(item);
        }
      },
      [props],
    );

    useEffect(() => {
      setSelectedIndex(0);
    }, [props.items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (event.key === "ArrowUp") {
          setSelectedIndex(
            (prev) => (prev + props.items.length - 1) % props.items.length,
          );
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((prev) => (prev + 1) % props.items.length);
          return true;
        }
        if (event.key === "Enter") {
          selectItem(selectedIndex);
          return true;
        }
        return false;
      },
    }));

    if (props.items.length === 0) {
      return (
        <div className="bg-popover border border-border rounded-lg shadow-md p-2 text-sm text-muted-foreground">
          No results
        </div>
      );
    }

    return (
      <div className="bg-popover border border-border rounded-lg shadow-md p-1 min-w-[200px] max-h-[300px] overflow-y-auto">
        {props.items.map((item, index) => (
          <button
            key={item.title}
            className={`w-full text-left px-3 py-2 rounded-md text-sm flex flex-col gap-0.5 ${
              index === selectedIndex
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/50"
            }`}
            onClick={() => selectItem(index)}
          >
            <span className="font-medium">{item.title}</span>
            <span className="text-xs text-muted-foreground">
              {item.description}
            </span>
          </button>
        ))}
      </div>
    );
  },
);

CommandList.displayName = "CommandList";

export const SlashCommand = Extension.create({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        command: ({
          editor,
          range,
          props,
        }: {
          editor: Editor;
          range: { from: number; to: number };
          props: CommandItem;
        }) => {
          props.command({ editor, range });
        },
        items: ({ query }: { query: string }) => {
          return commands.filter((item) =>
            item.title.toLowerCase().includes(query.toLowerCase()),
          );
        },
        render: () => {
          let component: ReactRenderer<CommandListRef>;
          let popup: Instance[];

          return {
            onStart: (props: SuggestionProps<CommandItem>) => {
              component = new ReactRenderer(CommandList, {
                props,
                editor: props.editor,
              });

              if (!props.clientRect) return;

              popup = tippy("body", {
                getReferenceClientRect: props.clientRect as () => DOMRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: "manual",
                placement: "bottom-start",
              });
            },
            onUpdate(props: SuggestionProps<CommandItem>) {
              component.updateProps(props);
              if (props.clientRect) {
                popup[0].setProps({
                  getReferenceClientRect: props.clientRect as () => DOMRect,
                });
              }
            },
            onKeyDown(props: SuggestionKeyDownProps) {
              if (props.event.key === "Escape") {
                popup[0].hide();
                return true;
              }
              return component.ref?.onKeyDown(props) ?? false;
            },
            onExit() {
              popup[0].destroy();
              component.destroy();
            },
          };
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
