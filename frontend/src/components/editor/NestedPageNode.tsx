import { Node, mergeAttributes } from "@tiptap/core"
import type { NodeViewRenderer } from "@tiptap/core"

/** Build a lucide-style FileText SVG icon via DOM methods (no innerHTML). */
function makeFileTextIcon(): SVGSVGElement {
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

  const paths = [
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    "M14 2v4a2 2 0 0 0 2 2h4",
    "M10 9H8",
    "M16 13H8",
    "M16 17H8",
  ]
  for (const d of paths) {
    const path = document.createElementNS(ns, "path")
    path.setAttribute("d", d)
    svg.appendChild(path)
  }
  return svg
}

export const NestedPageNode = Node.create({
  name: "nestedPage",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      pageId: { default: null },
      pageTitle: { default: "Untitled" },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="nested-page"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "nested-page" })]
  },

  addStorage() {
    return {
      onSelectPage: null as ((id: string) => void) | null,
      onCreateChildPage: null as (() => string) | null,
      pages: [] as { id: string; title: string }[],
    }
  },

  addNodeView(): NodeViewRenderer {
    return ({ node, editor }) => {
      const dom = document.createElement("div")
      dom.setAttribute("data-type", "nested-page")
      dom.setAttribute("contenteditable", "false")
      dom.className =
        "flex items-center gap-2 px-3 py-2 rounded-md border border-border cursor-pointer hover:bg-accent/50 my-1 select-none"

      const iconEl = document.createElement("span")
      iconEl.className = "text-muted-foreground flex-shrink-0"
      iconEl.appendChild(makeFileTextIcon())

      const titleEl = document.createElement("span")
      titleEl.className = "text-sm font-medium truncate"

      const updateTitle = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = editor.storage as unknown as Record<string, any>
        const pages = (storage["nestedPage"]?.pages ?? []) as { id: string; title: string }[]
        const page = pages.find(p => p.id === (node.attrs.pageId as string))
        titleEl.textContent = page?.title ?? (node.attrs.pageTitle as string | null) ?? "Untitled"
      }

      updateTitle()

      dom.appendChild(iconEl)
      dom.appendChild(titleEl)

      dom.addEventListener("click", () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = editor.storage as unknown as Record<string, any>
        const onSelectPage = storage["nestedPage"]?.onSelectPage as ((id: string) => void) | null
        onSelectPage?.(node.attrs.pageId as string)
      })

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type !== node.type) return false
          updateTitle()
          return true
        },
        destroy() {
          // no additional cleanup needed
        },
      }
    }
  },
})
