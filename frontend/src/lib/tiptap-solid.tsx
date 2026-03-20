import { createSignal, onMount, onCleanup, createEffect, type Accessor } from "solid-js"
import type { EditorOptions } from "@tiptap/core"
import { Editor } from "@tiptap/core"

/**
 * Creates a Tiptap editor instance managed by SolidJS lifecycle.
 * options() is called once on mount to configure the editor.
 */
export function createTiptapEditor(options: () => Partial<EditorOptions>): Accessor<Editor | null> {
  const [editor, setEditor] = createSignal<Editor | null>(null)

  onMount(() => {
    const instance = new Editor(options())
    // Forward editor update events to trigger reactivity
    instance.on("update", () => setEditor(instance))
    instance.on("selectionUpdate", () => setEditor(instance))
    instance.on("transaction", () => setEditor(instance))
    setEditor(instance)
    onCleanup(() => {
      instance.destroy()
      setEditor(null)
    })
  })

  return editor
}

/**
 * Renders the Tiptap editor's ProseMirror DOM into a container element.
 */
export function EditorContent(props: { editor: Editor | null; class?: string }) {
  let ref: HTMLDivElement | undefined

  createEffect(() => {
    const ed = props.editor
    if (ed && ref && !ref.contains(ed.view.dom)) {
      while (ref.firstChild) ref.removeChild(ref.firstChild)
      ref.appendChild(ed.view.dom)
    }
  })

  return <div ref={el => (ref = el)} class={props.class} />
}
