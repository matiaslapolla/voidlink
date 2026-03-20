import { For, Show, createSignal } from 'solid-js';
import { notifications, markAsRead, markAllAsRead } from '../services/notifications';

export function NotificationPanel() {
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal<string>('all');

  const filteredNotifications = () => {
    const all = notifications();
    if (filter() === 'all') return all;
    return all.filter(n => n.level === filter());
  };

  return (
    <>
      <button
        class={`notification-toggle ${open() ? 'open' : ''}`}
        onClick={() => setOpen(!open())}
      >
        🔔
        <Show when={unreadCount() > 0}>
          <span class="badge">{unreadCount()}</span>
        </Show>
      </button>

      <Show when={open()}>
        <div class="notification-panel">
          <div class="panel-header">
            <h3>Notifications</h3>
            <div class="filters">
              <For each={['all', 'error', 'warning', 'info']}>
                {(level) => (
                  <button
                    class={filter() === level ? 'active' : ''}
                    onClick={() => setFilter(level)}
                  >
                    {level}
                  </button>
                )}
              </For>
            </div>
            <button
              onClick={() => markAllAsRead('active')}
              disabled={unreadCount() === 0}
            >
              Mark all read
            </button>
          </div>

          <div class="notification-list">
            <For each={filteredNotifications()}>
              {(notification) => (
                <NotificationItem
                  notification={notification}
                  onClick={() => {
                    markAsRead(notification.id);
                  }}
                />
              )}
            </For>
          </div>
        </div>
      </Show>
    </>
  );
}

function NotificationItem(props: {
  notification: any;
  onClick: () => void;
}) {
  return (
    <div
      class={`notification-item ${props.notification.unread ? 'unread' : ''} ${props.notification.level}`}
      onClick={props.onClick}
    >
      <div class="notification-content">
        <h4>{props.notification.title}</h4>
        <p>{props.notification.body}</p>
        <span class="timestamp">
          {new Date(props.notification.timestamp).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}
