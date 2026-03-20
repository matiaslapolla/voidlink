import { createSignal, onMount, onCleanup } from 'solid-js';
import { listen } from '@tauri-apps/api/event';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export function Chat() {
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [input, setInput] = createSignal('');
  const [streaming, setStreaming] = createSignal(false);

  let unlisten: (() => void) | null = null;

  onMount(() => {
    // Listen for agent stream events
    listen<string>(`agent-stream:${props.agentId}`, (event) => {
      appendMessage('assistant', event.payload);
      setStreaming(false);
    }).then(un => unlisten = un);
  });

  onCleanup(() => unlisten?.());

  function appendMessage(role: 'user' | 'assistant', content: string) {
    setMessages([...messages(), { role, content, timestamp: Date.now() }]);
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const text = input();
    if (!text.trim()) return;
    
    appendMessage('user', text);
    setInput('');
    setStreaming(true);
    
    try {
      await invoke('agent_stream', {
        agentId: props.agentId,
        input: text,
      });
    } catch (error) {
      console.error('Agent error:', error);
      setStreaming(false);
    }
  }

  return (
    <div class="chat-container">
      <div class="messages">
        <For each={messages()}>
          {(msg) => (
            <div class={`message ${msg.role}`}>
              <div class="message-content">
                {msg.content}
              </div>
              <span class="timestamp">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
            </div>
          )}
        </For>
        <Show when={streaming()}>
          <div class="message assistant streaming">
            <div class="message-content">
              <span class="dots">...</span>
            </div>
          </div>
        </Show>
      </div>
      <form onSubmit={handleSubmit} class="input-form">
        <input
          type="text"
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          placeholder="Type a message..."
          disabled={streaming()}
        />
        <button type="submit" disabled={streaming()}>
          <Show when={streaming()} fallback="Send">
            Sending...
          </Show>
        </button>
      </form>
    </div>
  );
}
