# Testing

## The three projects

`frontend/vitest.config.ts` defines three vitest projects, and the file suffix
picks which one a test runs in.

| Project | Files | Environment | For |
| --- | --- | --- | --- |
| `unit` | `src/**/*.test.ts` | `node` | Pure logic — stores, parsers, reducers, the lane algorithm |
| `render` | `src/**/*.test.tsx` | `jsdom` | Components, actually mounted |
| `browser` | `src/**/*.browser.test.tsx` | real headless Chromium (Playwright) | Components whose correctness *is* their geometry |

`npx vitest run` runs all three. `npx vitest run --project render` runs one.
`npm test` runs **unit + render only** — see below for why `browser` is not in
that set.

The split between unit and render is deliberate. The unit project loads no
Solid compiler and builds no jsdom, which is why ~860 tests finish in about a
second and a half; putting them all in jsdom would tax every one of them for
the benefit of a handful. It also makes the extension informative: **if a test
file ends in `.tsx`, it mounts something.** `.browser.test.tsx` extends that
rule rather than breaking it: three suffixes, three costs, and the filename
says which you are paying.

## Reaching for `browser` instead of `render`

jsdom has no layout engine. `getBoundingClientRect` returns zeroes for every
element, there is no scrolling and no real CSS cascade, and
`IntersectionObserver`/`ResizeObserver` are stubs `src/test/setup.ts` installs
just so mounting doesn't throw. A test that measures anything in jsdom is
measuring the stub, not the component — and a test that would pass with
`getBoundingClientRect` returning zeroes belongs in `render`, not `browser`.

That is exactly the surfaces the `render` project cannot reach: the
`@tanstack/solid-virtual` lists (commit graph, file tree), tab-strip overflow,
the splitter, sticky headers, the MRU overlay, xterm, Monaco. Five are proven
now —
[`CommitGraph.browser.test.tsx`](../../frontend/src/components/git/history/CommitGraph.browser.test.tsx)
checks that rows and the SVG gutter overlay agree on where a row actually is
on screen, including across the windowing threshold `CommitGraph.tsx` applies
above 60 rows; [`TabStrip.browser.test.tsx`](../../frontend/src/components/layout/TabStrip.browser.test.tsx)
checks the overflow chevron against a real `ResizeObserver` and drags a tab
between two pane groups with a real `DataTransfer` — a constructor jsdom does
not implement at all;
[`SplitDiffRenderer.browser.test.tsx`](../../frontend/src/components/git/shared/SplitDiffRenderer.browser.test.tsx)
reveals the hunk toolbar with a real hover (`opacity-0 group-hover:opacity-100`
is a fact jsdom's absent stylesheet cannot state at all), scrolls 400px into a
hunk to watch its `sticky` header stay pinned and hand the slot to the next
one, and puts a 2000-character line into one side of a split row to prove the
other column does not move;
[`Splitter.browser.test.tsx`](../../frontend/src/components/layout/Splitter.browser.test.tsx)
measures the 8px hit area around the 1px rule, checks a hover changes colour
and nothing about the box, and resolves `calc(var(--island-gap) / 2 - 4px)` —
a custom property inside a `calc()`, which is also why `islandGapPx()` can only
ever return its own fallback in jsdom;
[`FileTree.browser.test.tsx`](../../frontend/src/components/files/FileTree.browser.test.tsx)
windows a 500-file directory, the one list whose rows are *measured*
(`virtualizer.measureElement`) rather than estimated.

**Falsify a browser test before you keep it.** Every one of the five files was
run against a deliberately broken component — the Tailwind import removed, or
the single class the test is about deleted — and confirmed to fail for the
right reason. This is not ceremony: two assertions were rewritten because of
it. `SplitDiffRenderer`'s column-width check passed with `flex-1` removed
(it compared the two columns to each other, where it should have compared each
to the row), and `FileTree`'s offset check asserted `index × rowHeight`, which
a dynamically-measured list does not satisfy by design. A geometry test that
passes against a broken layout is worse than no test, and the only way to know
is to break the layout.

`src/test/setup.browser.ts` mirrors `setup.ts`'s Tauri stub — same fake, same
`./tauri.ts`, imported rather than forked — but skips the jsdom stubs entirely:
a real browser needs no `matchMedia`/`ResizeObserver`/`scrollIntoView`
pretending to work, because they already do. It does add one thing `setup.ts`
doesn't: an import of the app's `index.css`, and the browser project's own Vite
config loads the Tailwind plugin to compile it. Geometry tests are only
meaningful against the real cascade — `overflow-auto` has to actually clip,
`flex-1` has to actually size a scroll container, or a "windowing" test would
never see anything windowed.

```tsx
// frontend/src/components/git/history/CommitGraph.browser.test.tsx
const rows = screen.getAllByRole("option");
const tops = rows.map((r) => r.getBoundingClientRect().top);
const rowHeight = tops[1] - tops[0];
expect(rowHeight).toBeGreaterThan(10); // 0 in jsdom; this is the tell
```

Run it with `npm run test:browser`, or interactively with `npm run test:ui`
(`@vitest/ui`, useful for watch-mode triage across any project). `npm test`
deliberately excludes `browser`: it is roughly two orders of magnitude slower
per test than `render`, and a suite that takes minutes stops being run. CI
should run `unit` + `render` on every push and `browser` on demand or
pre-merge — not because the tests are less trustworthy, but because Playwright's
browser binaries are a **~300 MB download** (`npx playwright install chromium`)
that dominates a cold run unless it is cached between them.

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
matchers, unmounts between tests, stubs the four things jsdom does not
implement that components reach for anyway — `matchMedia` (every reduced-motion
check), `ResizeObserver` (anything measuring a pane), `scrollIntoView` (every
list with a cursor) and pointer capture (`Splitter.onPointerDown` calls
`setPointerCapture` on its first line) — and fakes the Tauri boundary.
Unstubbed, all four throw, and the pointer-capture one throws from inside an
event handler: the test that clicked stays green and Vitest reports an
unhandled error beside whichever test happened to run last.

### The Tauri boundary

**A render test never mocks a module.** `setup.ts` replaces
`@tauri-apps/api`'s `invoke`, `listen`, `emit`, `Channel` and
`getCurrentWindow` for the whole project, and a test says what Rust would have
answered:

```tsx
import { mockTauri, tauriCalls, lastInvokeArgs, emitTauriEvent } from "@/test/tauri";

beforeEach(() => {
  mockTauri({
    journal_query: () => stored,          // a function: re-read per call
    journal_repos: [],                    // or a plain value
    git_status: ({ repoPath }) => statusFor(repoPath as string),
  });
});

it("queries the repository it was given", async () => {
  render(() => <TimelineSurface repoPath="/repo" />);
  await waitFor(() => expect(tauriCalls("journal_query")).toHaveLength(1));
  expect(lastInvokeArgs("journal_query")?.query).toMatchObject({ repo: "/repo" });
});
```

The seam is at the process boundary because that is where the process boundary
is. Everything above it — `@/api/*`'s argument shaping and return typing,
`@/store/*`'s batching, debouncing and subscription lifecycle — runs unchanged
and is therefore under test. A test that replaced `journalApi.query` instead
proves the component calls *something*; it cannot notice that the transport now
sends `{ q }` where Rust reads `{ query }`.

The helpers:

| | |
| --- | --- |
| `mockTauri(handlers)` | Install or merge handlers. A value is returned as-is; a function receives the invoke arguments and may be async or throw |
| `tauriCalls(command?)` | What crossed the boundary, in order. No argument means everything |
| `lastInvokeArgs(command)` | Arguments of the most recent call |
| `emitTauriEvent(name, payload)` | Deliver an event as Rust's broadcast would |
| `tauriListenerCount(name)` | How many listeners are attached — the honest way to assert subscribe *and* unsubscribe |
| `tauriChannel()` | The `Channel` the code under test just constructed, for streaming commands |
| `setTauriWindowLabel(label)` | Which window the code thinks it is in |

Two behaviours are deliberate and worth knowing before they surprise you:

- **An unstubbed command rejects**, naming itself and suggesting the key to add.
  Resolving `undefined` would turn a missing handler into a component quietly
  rendering an empty state, and a test that passes for that reason is worse than
  no test.
- **Subscriptions attach asynchronously.** `onJournalAppended` goes through a
  dynamic import and then `listen`, so a surface that has already painted its
  first query is not necessarily listening yet. Wait for
  `tauriListenerCount(EVENT)` before emitting. The old hand-rolled mocks captured
  the handler synchronously and so could never have surfaced that ordering.

Mocking a *store* is still occasionally right — `HillsSection.test.tsx` does,
because the store is pure `localStorage` state and the test is about the
section. Mocking an `@/api/*` module is not: that is the layer this harness
exists to keep under test.

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

**That backlog is now down to one row.** `GitSidebar` — the surface that
carried the most findings and had never been mounted — has 31 tests; the
splitter, sticky headers, `SplitDiffRenderer` and its hunk actions, and the
file tree's virtualized list all have theirs, split between the two projects
by the rule below rather than by component. What is left is the **MRU
overlay**, which lives inside `MainSurface` and needs that whole surface
mounted rather than a component lifted out of it. `../TODO.md` tracks it.

The rule, so it does not get re-litigated per test:

> Use jsdom unless the assertion is about geometry. If the test would pass with
> `getBoundingClientRect` returning zeroes, it belongs in jsdom.

## Rust

`cd src-tauri && cargo test --lib` — 269 tests, all in-module `#[cfg(test)]`
blocks. `cargo clippy --all-targets -- -D warnings` must be clean; warnings are
errors in this repo.

Tests that need a repository build one in a `tempfile::tempdir()`. Tests that
need an `AppHandle` generally indicate a design problem — see the `APP` static
in `src-tauri/src/journal/mod.rs` for a case where keeping the handle out of a
command's signature was worth more than the alternative, and why.
