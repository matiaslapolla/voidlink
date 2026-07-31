# Testing

## The two projects

`frontend/vitest.config.ts` defines two vitest projects, and the file extension
picks which one a test runs in.

| Project | Files | Environment | For |
| --- | --- | --- | --- |
| `unit` | `src/**/*.test.ts` | `node` | Pure logic — stores, parsers, reducers, the lane algorithm |
| `render` | `src/**/*.test.tsx` | `jsdom` | Components, actually mounted |

`npx vitest run` runs both. `npx vitest run --project render` runs one.

The split is deliberate. The unit project loads no Solid compiler and builds no
jsdom, which is why ~860 tests finish in about a second and a half; putting them
all in jsdom would tax every one of them for the benefit of a handful. It also
makes the extension informative: **if a test file ends in `.tsx`, it mounts
something.**

## Writing a render test

```tsx
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

it("does the thing", async () => {
  const user = userEvent.setup();
  render(() => <Thing prop="value" />);
  await user.click(screen.getByRole("button", { name: "Go" }));
  expect(screen.getByText("Went")).toBeInTheDocument();
});
```

`render` takes a **function returning** a component, not an element — Solid has
no rerender, and the function is what gives the library a reactive root to own.

`src/test/setup.ts` runs first for this project only. It installs the jest-dom
matchers, unmounts between tests, and stubs the three things jsdom does not
implement that components reach for anyway: `matchMedia` (every reduced-motion
check), `ResizeObserver` (anything measuring a pane) and `scrollIntoView` (every
list with a cursor). Unstubbed, all three throw during mount and the failure
names the wrong thing.

### Query by role, not by class

`getByRole("button", { name: "Agents" })` survives a restyle; a class selector
does not, and a test that breaks on a Tailwind change is a test people learn to
delete. It also means an element with no accessible name fails the test, which
is the cheapest accessibility check available.

## What belongs where

Put logic in a `.ts` module beside the component and test it in the unit
project. `components/timeline/` is the shape to copy: `timelineModel.ts` holds
the grouping, filtering and merging with 17 unit tests, and
`TimelineSurface.test.tsx` then only has to prove the component is *wired* to
it — that it queries, renders, appends live events, and cleans up.

That division is not ceremony. Logic tested through a DOM is slower to run and
much harder to read a failure from: an assertion about a rendered string tells
you something is wrong somewhere between the query and the pixel.

## The gap this closed, and the one still open

Before this harness there were no render tests at all. Roughly 100 fixes from
the 2026-07-30 git-surfaces audit were shipped having never been mounted once
in a test — the config's own comment said "this is not a component test
harness", and it was accurate.

**That backlog is still untested.** The harness exists and the timeline uses it;
the git sidebar, the compare tree, the commit graph and the diff view do not yet
have render tests. Adding them is ordinary follow-on work, not another
infrastructure project.

## Rust

`cd src-tauri && cargo test --lib` — 269 tests, all in-module `#[cfg(test)]`
blocks. `cargo clippy --all-targets -- -D warnings` must be clean; warnings are
errors in this repo.

Tests that need a repository build one in a `tempfile::tempdir()`. Tests that
need an `AppHandle` generally indicate a design problem — see the `APP` static
in `src-tauri/src/journal/mod.rs` for a case where keeping the handle out of a
command's signature was worth more than the alternative, and why.
