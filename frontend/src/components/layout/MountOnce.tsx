import { createMemo, createSignal, type JSX } from "solid-js";

interface MountOnceProps<T> {
  when: T | undefined | null | false;
  children: (value: () => NonNullable<T>) => JSX.Element;
}

/**
 * Like <Show>, but once children are mounted they are never unmounted.
 * The accessor always returns the latest truthy value.
 *
 * Use for components with expensive internal state (terminals, chat views)
 * that must survive their trigger becoming momentarily falsy.
 */
export function MountOnce<T>(props: MountOnceProps<T>) {
  const [mounted, setMounted] = createSignal(false);
  const [latestValue, setLatestValue] = createSignal<NonNullable<T>>(undefined as any);

  const shouldRender = createMemo(() => {
    const v = props.when;
    if (v) {
      setLatestValue(() => v as NonNullable<T>);
      if (!mounted()) setMounted(true);
    }
    return mounted();
  });

  return (
    <>
      {shouldRender() ? props.children(latestValue as () => NonNullable<T>) : null}
    </>
  );
}
