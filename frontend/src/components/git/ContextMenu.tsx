/// The right-click menu, now an adapter over `components/ui/Menu`.
///
/// It used to be the implementation: a Portal, a viewport clamp, an Escape
/// handler, and a `click` listener deferred by `setTimeout(0)` to dodge the
/// opening click. That gave it no enter or exit (MOTION-PLAN F6), no keyboard
/// navigation at all (F7), and a dismiss that a drag begun outside the menu
/// could not trigger (F8).
///
/// The behaviour moved to `ui/Menu` rather than being fixed here because the
/// tab strip's two portal menus want the same thing, and three more copies of
/// a roving `tabindex` is how the first three copies happened. This file
/// survives as the name its two callers already import (`WorkspaceRail`,
/// `GitSidebar`) and as the place `ContextMenuItem`'s shape is documented — a
/// rename across both call sites would have been churn with no reader on the
/// other side of it.
import { Menu, type MenuItem } from "@/components/ui/Menu";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /// Kept as a boolean for the existing callers. `ui/Menu` takes a *reason*,
  /// because §7.6 forbids a disabled control that does not say why; a caller
  /// still passing the boolean gets the generic reason below, which is honest
  /// (the action is unavailable in this state) without inventing a specific
  /// one it does not know.
  disabled?: boolean;
  /// Why the row is unavailable. Preferred over `disabled` — pass this and the
  /// row states its own reason.
  disabledReason?: string;
  separatorBefore?: boolean;
}

const GENERIC_REASON = "Not available in this state";

export function ContextMenu(props: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /// Where focus returns when the menu closes — the row that was right-clicked.
  returnFocusTo?: HTMLElement | null;
}) {
  const items = (): MenuItem[] =>
    props.items.map((item) => ({
      label: item.label,
      onSelect: item.onSelect,
      danger: item.danger,
      separatorBefore: item.separatorBefore,
      disabledReason: item.disabledReason ?? (item.disabled ? GENERIC_REASON : undefined),
    }));

  return (
    <Menu
      x={props.x}
      y={props.y}
      items={items()}
      onClose={props.onClose}
      returnFocusTo={props.returnFocusTo}
      label="Context menu"
    />
  );
}
