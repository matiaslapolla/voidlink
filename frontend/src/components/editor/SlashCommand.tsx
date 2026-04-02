import { createSignal, createEffect, For, Show } from "solid-js"
import { Extension } from "@tiptap/core"
import { SolidRenderer } from "./SolidRenderer"
import Suggestion from "@tiptap/suggestion"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import type { Editor } from "@tiptap/core"
import tippy from "tippy.js"
import type { Instance } from "tippy.js"
import { cn } from "@/lib/utils"
import { commands } from "./slashCommands"
import type { CommandItem } from "./slashCommands"

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
          return commands.filter(item =>
            item.title.toLowerCase().includes(query.toLowerCase())
          )
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
