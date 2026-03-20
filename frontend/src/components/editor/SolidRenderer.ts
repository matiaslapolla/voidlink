import { createSignal } from "solid-js"
import { render as solidRender } from "solid-js/web"
import type { Component } from "solid-js"

export interface SolidRendererOptions<T extends Record<string, unknown>> {
  props: T
  editor: unknown
}

export class SolidRenderer<T extends Record<string, unknown>> {
  element: HTMLElement
  ref: unknown = null
  private dispose: () => void
  private setProps!: (p: T) => void

  constructor(
    component: Component<T & { ref?: (r: unknown) => void }>,
    options: SolidRendererOptions<T>
  ) {
    this.element = document.createElement("div")
    const [getProps, setProps] = createSignal<T>(options.props)
    this.setProps = setProps as (p: T) => void

    this.dispose = solidRender(
      () =>
        (component as Component<T & { ref?: (r: unknown) => void }>)({
          ...(getProps() as T),
          ref: (r: unknown) => {
            this.ref = r
          },
        }),
      this.element
    )
  }

  updateProps(newProps: T): void {
    this.setProps(newProps)
  }

  destroy(): void {
    this.dispose()
    if (this.element.parentNode) {
      this.element.parentNode.removeChild(this.element)
    }
  }
}
