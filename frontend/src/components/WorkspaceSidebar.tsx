import { For, createSignal } from 'solid-js';
import { workspaces, activeWorkspace, setActiveWorkspace } from '../stores/workspaces';

export function WorkspaceSidebar() {
  const [collapsed, setCollapsed] = createSignal(false);

  return (
    <aside class={`workspace-sidebar ${collapsed() ? 'collapsed' : ''}`}>
      <button class="toggle" onClick={() => setCollapsed(!collapsed())}>
        ☰
      </button>

      <Show when={!collapsed()}>
        <div class="workspace-list">
          <For each={workspaces()}>
            {(workspace) => (
              <div
                class={`workspace-item ${workspace.id === activeWorkspaceId() ? 'active' : ''}`}
                onClick={() => setActiveWorkspace(workspace.id)}
              >
                <div class="workspace-info">
                  <span class="name">{workspace.name}</span>

                  <Show when={workspace.gitBranch}>
                    <span class="branch">🌿 {workspace.gitBranch}</span>
                  </Show>

                  <Show when={workspace.prNumber}>
                    <span class="pr">#{workspace.prNumber}</span>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>

        <button class="add-workspace">
          ➕ New Workspace
        </button>
      </Show>
    </aside>
  );
}
