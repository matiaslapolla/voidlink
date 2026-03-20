import { createSignal, onMount } from 'solid-js';
import {
  openBrowser,
  clickElement,
  fillElement,
  getSnapshot,
  currentSession,
} from '../stores/browser';

export function BrowserAutomation() {
  const [url, setUrl] = createSignal('https://example.com');
  const [snapshot, setSnapshot] = createSignal<any>(null);
  const [actionHistory, setActionHistory] = createSignal<string[]>([]);

  onMount(async () => {
    await refreshSnapshot();
  });

  async function handleOpen() {
    await openBrowser(url());
    await refreshSnapshot();
  }

  async function refreshSnapshot() {
    const snap = await getSnapshot();
    setSnapshot(snap);
  }

  async function handleElementClick(ref: string) {
    await clickElement(ref);
    addAction(`Click @${ref}`);
    await refreshSnapshot();
  }

  async function handleElementFill(ref: string, value: string) {
    await fillElement(ref, value);
    addAction(`Fill @${ref}: "${value}"`);
    await refreshSnapshot();
  }

  function addAction(action: string) {
    setActionHistory([action, ...actionHistory()]);
  }

  return (
    <div class="browser-automation">
      <div class="toolbar">
        <input
          type="text"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
        <button onClick={handleOpen}>Open</button>
        <button onClick={refreshSnapshot}>Refresh</button>
      </div>

      <div class="panels">
        <div class="snapshot-panel">
          <Show when={snapshot()}>
            <h3>Page Snapshot</h3>
            <ElementTree
              elements={snapshot().elements}
              onElementClick={handleElementClick}
              onElementFill={handleElementFill}
            />
          </Show>
          <Show when={!currentSession()}>
            <p class="empty-state">No active browser session</p>
          </Show>
        </div>

        <div class="actions-panel">
          <h3>Action History</h3>
          <ul>
            <For each={actionHistory()}>
              {(action) => <li>{action}</li>}
            </For>
          </ul>
        </div>
      </div>
    </div>
  );
}

function ElementTree(props: {
  elements: any[];
  onElementClick: (ref: string) => void;
  onElementFill: (ref: string, value: string) => void;
}) {
  return (
    <div class="element-tree">
      <For each={props.elements}>
        {(element) => (
          <div class={`element ${element.tag}`}>
            <span class="tag">{element.tag}</span>
            <Show when={element.text}>
              <span class="text">"{element.text}"</span>
            </Show>
            <Show when={element.attributes?.role}>
              <span class="role">role="{element.attributes.role}"</span>
            </Show>
            <Show when={element.ref}>
              <span class="ref">@{element.ref}</span>
            </Show>

            <Show when={element.tag === 'button' || element.attributes?.role === 'button'}>
              <button onClick={() => props.onElementClick(element.ref)}>
                Click
              </button>
            </Show>

            <Show when={element.tag === 'input' || element.tag === 'textarea'}>
              <input
                type="text"
                placeholder="Enter value"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    props.onElementFill(element.ref, e.currentTarget.value);
                    e.currentTarget.value = '';
                  }
                }}
              />
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
