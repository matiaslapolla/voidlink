import { createEffect, Show } from "solid-js"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import TaskList from "@tiptap/extension-task-list"
import TaskItem from "@tiptap/extension-task-item"
import Focus from "@tiptap/extension-focus"
import { DragHandle } from "@tiptap/extension-drag-handle"
import { createTiptapEditor, EditorContent } from "@/lib/tiptap-solid"
import { EditorToolbar } from "./EditorToolbar"
import { SlashCommand } from "./SlashCommand"
import { NestedPageNode } from "./NestedPageNode"
import { MarkdownPaste } from "./MarkdownPaste"
import "./editor.css"

interface EditorProps {
  content?: string
  onUpdate?: (content: string) => void
  onCreateChildPage?: () => string
  onSelectPage?: (id: string) => void
  pages?: { id: string; title: string }[]
}

/** Build a GripVertical-style dots SVG icon via DOM methods (no innerHTML). */
function makeGripIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg"
  const svg = document.createElementNS(ns, "svg")
  svg.setAttribute("width", "16")
  svg.setAttribute("height", "16")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "2")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")

  const circles = [
    { cx: "9", cy: "5" },
    { cx: "9", cy: "12" },
    { cx: "9", cy: "19" },
    { cx: "15", cy: "5" },
    { cx: "15", cy: "12" },
    { cx: "15", cy: "19" },
  ]
  for (const { cx, cy } of circles) {
    const circle = document.createElementNS(ns, "circle")
    circle.setAttribute("cx", cx)
    circle.setAttribute("cy", cy)
    circle.setAttribute("r", "1")
    svg.appendChild(circle)
  }
  return svg
}

export function Editor(props: EditorProps) {
  const editor = createTiptapEditor(() => ({
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
      DragHandle.configure({
        render() {
          const el = document.createElement("div")
          el.className = "drag-handle"
          el.setAttribute("data-drag-handle", "")
          el.appendChild(makeGripIcon())
          return el
        },
      }),
      SlashCommand,
      NestedPageNode,
      MarkdownPaste,
    ],
    content: props.content ?? "",
    onUpdate: ({ editor: ed, transaction }) => {
      if (transaction.getMeta("pages-sync")) return
      props.onUpdate?.(ed.getHTML())
    },
  }))

  // Wire up nested page callbacks into editor storage
  createEffect(() => {
    const ed = editor()
    if (!ed) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = ed.storage as unknown as Record<string, any>
    if (storage["nestedPage"]) {
      storage["nestedPage"].onSelectPage = props.onSelectPage ?? null
      storage["nestedPage"].onCreateChildPage = props.onCreateChildPage ?? null
      storage["nestedPage"].pages = props.pages ?? []
      ed.view.dispatch(ed.state.tr.setMeta("pages-sync", true))
    }
  })

  return (
    <Show when={editor()}>
      {ed => (
        <div class="flex flex-col h-full">
          <EditorToolbar editor={ed()} />
          <div class="relative flex-1 overflow-y-auto p-6">
            <EditorContent editor={ed()} class="max-w-none min-h-full" />
          </div>
        </div>
      )}
    </Show>
  )
}
