import { createSignal, createEffect, For, Show } from "solid-js"
import { Extension } from "@tiptap/core"
import { SolidRenderer } from "./SolidRenderer"
import Suggestion from "@tiptap/suggestion"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import type { Editor } from "@tiptap/core"
import tippy from "tippy.js"
import type { Instance } from "tippy.js"
import { cn } from "@/lib/utils"

interface CommandItem {
  title: string
  description: string
  aliases?: string[]
  command: (props: { editor: Editor; range: { from: number; to: number } }) => void
}

const commands: CommandItem[] = [
  {
    title: "Heading 1",
    description: "Large section heading",
    aliases: ["h1", "heading1"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run()
    },
  },
  {
    title: "Heading 2",
    description: "Medium section heading",
    aliases: ["h2", "heading2"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run()
    },
  },
  {
    title: "Heading 3",
    description: "Small section heading",
    aliases: ["h3", "heading3"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run()
    },
  },
  {
    title: "Bullet List",
    description: "Unordered list",
    aliases: ["bullet", "list", "-", "*"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run()
    },
  },
  {
    title: "Numbered List",
    description: "Ordered list",
    aliases: ["numbered", "1.", "num", "ordered"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run()
    },
  },
  {
    title: "Task List",
    description: "Checklist with checkboxes",
    aliases: ["task", "todo", "check", "checkbox"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run()
    },
  },
  {
    title: "Code Block",
    description: "Code snippet",
    aliases: ["code", "```", "pre"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run()
    },
  },
  {
    title: "Blockquote",
    description: "Quote block",
    aliases: ["quote", ">", "blockquote"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run()
    },
  },
  {
    title: "Divider",
    description: "Horizontal rule",
    aliases: ["divider", "hr", "---", "horizontal"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run()
    },
  },
  {
    title: "Page",
    description: "Create a nested page",
    aliases: ["page", "nested", "child"],
    command: ({ editor, range }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const storage = editor.storage as Record<string, any>
      const createFn = storage.nestedPage?.onCreateChildPage as (() => string) | null
      if (!createFn) return
      const id = createFn()
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: "nestedPage", attrs: { pageId: id, pageTitle: "Untitled" } })
        .run()
    },
  },
]

interface CommandListRef {
  onKeyDown: (opts: { event: KeyboardEvent }) => boolean
}

interface CommandListProps extends SuggestionProps<CommandItem> {
  ref?: (r: CommandListRef) => void
}

function CommandList(props: CommandListProps) {
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  props.ref?.({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === "ArrowUp") {
        setSelectedIndex(i => (i + props.items.length - 1) % props.items.length)
        return true
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex(i => (i + 1) % props.items.length)
        return true
      }
      if (event.key === "Enter") {
        const item = props.items[selectedIndex()]
        if (item) item.command({ editor: props.editor as Editor, range: props.range })
        return true
      }
      return false
    },
  })

  createEffect(() => {
    if (props.items.length) setSelectedIndex(0)
  })

  return (
    <Show
      when={props.items.length > 0}
      fallback={
        <div class="bg-popover border border-border rounded-lg shadow-md p-2 text-sm text-muted-foreground">
          No results
        </div>
      }
    >
      <div class="bg-popover border border-border rounded-lg shadow-md p-1 min-w-[200px] max-h-[300px] overflow-y-auto">
        <For each={props.items}>
          {(item, index) => (
            <button
              class={cn(
                "w-full text-left px-3 py-2 rounded-md text-sm flex flex-col gap-0.5",
                index() === selectedIndex()
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50"
              )}
              onClick={() => item.command({ editor: props.editor as Editor, range: props.range })}
            >
              <span class="font-medium">{item.title}</span>
              <span class="text-xs text-muted-foreground">{item.description}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

export const SlashCommand = Extension.create({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        allowSpaces: true,
        command: ({
          editor,
          range,
          props,
        }: {
          editor: Editor
          range: { from: number; to: number }
          props: CommandItem
        }) => {
          props.command({ editor, range })
        },
        items: ({ query }: { query: string }) => {
          const normalizedQuery = query.toLowerCase().trim()
          return commands.filter(item => {
            const matchesTitle = item.title.toLowerCase().includes(normalizedQuery)
            const matchesAlias = item.aliases?.some(alias =>
              alias.toLowerCase().includes(normalizedQuery)
            )
            return matchesTitle || matchesAlias
          })
        },
        render: () => {
          let component: SolidRenderer<Record<string, unknown>>
          let popup: Instance[]

          return {
            onStart: (props: SuggestionProps<CommandItem>) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              component = new SolidRenderer(CommandList as any, {
                props: props as unknown as Record<string, unknown>,
                editor: props.editor,
              })

              if (!props.clientRect) return

              popup = tippy("body", {
                getReferenceClientRect: props.clientRect as () => DOMRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: "manual",
                placement: "bottom-start",
              })
            },
            onUpdate(props: SuggestionProps<CommandItem>) {
              component.updateProps(props as unknown as Record<string, unknown>)
              if (props.clientRect) {
                popup[0].setProps({
                  getReferenceClientRect: props.clientRect as () => DOMRect,
                })
              }
            },
            onKeyDown(props: SuggestionKeyDownProps) {
              if (props.event.key === "Escape") {
                popup[0].hide()
                return true
              }
              if (props.event.key === " ") {
                const query = props.text?.toLowerCase().trim()
                if (query) {
                  const exactMatch = commands.find(item =>
                    item.aliases?.some(alias => alias.toLowerCase() === query)
                  )
                  if (exactMatch) {
                    exactMatch.command({ editor: props.editor as Editor, range: props.range })
                    popup[0].hide()
                    return true
                  }
                }
              }
              const ref = component.ref as CommandListRef | null
              return ref?.onKeyDown({ event: props.event }) ?? false
            },
            onExit() {
              popup[0].destroy()
              component.destroy()
            },
          }
        },
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ]
  },
})
