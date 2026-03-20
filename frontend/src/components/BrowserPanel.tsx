import { createSignal, onMount, onCleanup } from 'solid-js';
import { invoke, listen } from '@tauri-apps/api/core';
import {
  openBrowser,
  clickElement,
  fillElement,
  getSnapshot,
  currentSession,
} from '../stores/browser';

export function BrowserPanel() {
  const [url, setUrl] = createSignal('https://example.com');
  const [history, setHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [webviewLabel, setWebviewLabel] = createSignal<string | null>(null);

  let unlisten: (() => void) | null = null;

  onMount(async () => {
    unlisten = await listen<string>('browser-navigated', (event) => {
      setUrl(event.payload);
      updateHistory(event.payload);
    });
  });

  onCleanup(() => unlisten?.());

  async function createBrowser() {
    const label = Date.now().toString();
    await invoke('browser_create_webview', {
      url: url(),
      label,
      width: 1200,
      height: 800,
    });
    setWebviewLabel(label);
  }

  async function navigate(newUrl: string) {
    await invoke('browser_navigate', {
      webviewLabel: webviewLabel()!,
      url: newUrl,
    });
  }

  async function executeScript(script: string) {
    const result = await invoke<string>('browser_execute_script', {
      webviewLabel: webviewLabel()!,
      script,
    });
    return result;
  }

  function updateHistory(newUrl: string) {
    const newHistory = history().slice(0, historyIndex() + 1);
    newHistory.push(newUrl);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  }

  async function goBack() {
    const newIndex = historyIndex() - 1;
    if (newIndex >= 0) {
      setHistoryIndex(newIndex);
      await navigate(history()[newIndex]);
    }
  }

  async function goForward() {
    const newIndex = historyIndex() + 1;
    if (newIndex < history().length) {
      setHistoryIndex(newIndex);
      await navigate(history()[newIndex]);
    }
  }

  return (
    <div class="browser-panel">
      <Show when={!webviewLabel()}>
        <div class="browser-placeholder">
          <button onClick={createBrowser}>Open Browser</button>
        </div>
      </Show>

      <Show when={webviewLabel()}>
        <div class="browser-toolbar">
          <button onClick={goBack} disabled={historyIndex() <= 0}>
            ←
          </button>
          <button onClick={goForward} disabled={historyIndex() >= history().length - 1}>
            →
          </button>

          <input
            type="text"
            value={url()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                navigate(e.currentTarget.value);
              }
            }}
          />

          <button onClick={() => navigate(url())}>
            ↻
          </button>

          <button
            class="close"
            onClick={async () => {
              await invoke('browser_close', { webviewLabel: webviewLabel()! });
              setWebviewLabel(null);
            }}
          >
            ✕
          </button>
        </div>

        <div class="browser-devtools">
          <DevToolsPanel
            webviewLabel={webviewLabel()!}
            executeScript={executeScript}
          />
        </div>
      </Show>
    </div>
  );
}

function DevToolsPanel(props: {
  webviewLabel: string;
  executeScript: (script: string) => Promise<string>;
}) {
  const [script, setScript] = createSignal('');
  const [output, setOutput] = createSignal('');

  async function runScript() {
    try {
      const result = await props.executeScript(script());
      setOutput(JSON.stringify(result, null, 2));
    } catch (error) {
      setOutput(`Error: ${error}`);
    }
  }

  return (
    <div class="devtools-panel">
      <div class="tabs">
        <button class="active">Console</button>
      </div>

      <div class="console-panel">
        <textarea
          value={script()}
          onInput={(e) => setScript(e.currentTarget.value)}
          placeholder="// Enter JavaScript to execute"
        />
        <button onClick={runScript}>Run</button>
        <pre class="output">{output()}</pre>
      </div>
    </div>
  );
}
