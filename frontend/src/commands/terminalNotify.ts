/// The OS notification for "your terminal finished".
///
/// Extracted from `TerminalSidebar`, where it fired from inside a row's own poll:
/// collapse the Terminals section and you got no notification at all, for a
/// long-running build in a shell you were specifically not watching. It also had
/// its own idea of when a completion counted, separate from
/// `store/activity.ts` — so the badge and the notification could disagree.
///
/// Now there is one caller (`MainSurface`), driven off the same `notify` signal
/// the in-app mark is driven off. In-app first, OS second: the badge is the
/// primary channel and always works, and this is the escalation for a user who
/// is not looking at VoidLink at all.
///
/// Permission is never *requested*. An unprompted permission dialog on a
/// terminal that happened to ring is exactly the kind of interruption §7.5.3
/// forbids; if the user has granted it, they get notifications, and if they have
/// not, the in-app mark still says everything.
export function notifyTerminal(label: string, body?: string): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(`${label} finished`, { body: body || undefined });
  } catch {
    // Some webviews expose the constructor and then refuse it. A failed
    // notification is never worth failing a caller for.
  }
}
