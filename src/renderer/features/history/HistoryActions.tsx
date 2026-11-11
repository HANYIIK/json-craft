import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Ellipsis,
  LoaderCircle,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { useI18n } from "../../i18n/i18n";

interface Props {
  id: string;
  name: string;
  pinned: boolean;
  disabled: boolean;
  busy: boolean;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function HistoryActions({
  id,
  name,
  pinned,
  disabled,
  busy,
  onPin,
  onRename,
  onDelete,
}: Props) {
  const { t } = useI18n();
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialItem = useRef(0);
  const needsFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();

  function close(restoreFocus = false) {
    setOpen(false);
    setPosition(undefined);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  function show(index = 0) {
    if (disabled) return;
    initialItem.current = index;
    needsFocus.current = true;
    setOpen(true);
  }

  function choose(action: () => void) {
    close(true);
    action();
  }

  useLayoutEffect(() => {
    if (!open) return;
    if (disabled) {
      close();
      return;
    }
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      const list = menu.current;
      if (!rect || !list) return;
      if (rect.bottom <= 0 || rect.top >= innerHeight) {
        close();
        return;
      }
      const inset = 8;
      const gap = 5;
      const height = list.offsetHeight;
      setPosition({
        top: Math.max(
          inset,
          Math.min(rect.bottom + gap, innerHeight - height - inset),
        ),
        left: Math.max(
          inset,
          Math.min(
            rect.right - list.offsetWidth,
            innerWidth - list.offsetWidth - inset,
          ),
        ),
      });
    };
    const onOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !trigger.current?.contains(event.target) &&
        !menu.current?.contains(event.target)
      )
        close();
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    document.addEventListener("pointerdown", onOutside);
    const observer = new ResizeObserver(update);
    if (trigger.current) observer.observe(trigger.current);
    if (menu.current) observer.observe(menu.current);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
      document.removeEventListener("pointerdown", onOutside);
      observer.disconnect();
    };
  }, [open, disabled]);

  useLayoutEffect(() => {
    if (!open || !position || !needsFocus.current) return;
    needsFocus.current = false;
    menu.current
      ?.querySelectorAll<HTMLButtonElement>("[role=menuitem]")
      [initialItem.current]?.focus({ preventScroll: true });
  }, [open, position]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const items = [
        ...menu.current!.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
      ];
      const current = items.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length;
      items[next]?.focus();
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="history-entry-action history-actions-trigger"
        data-history-actions={id}
        data-open={open || undefined}
        aria-label={t("更多操作 {{name}}", { name })}
        title={t("更多操作")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.key === "ArrowUp" ? 2 : 0);
          }
        }}
      >
        {busy ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <Ellipsis size={17} />
        )}
      </button>
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label={t("更多操作 {{name}}", { name })}
            className="history-actions-menu"
            data-history-actions={id}
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
            onKeyDown={navigate}
            onBlur={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                !event.currentTarget.contains(event.relatedTarget) &&
                !trigger.current?.contains(event.relatedTarget)
              )
                close();
            }}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => choose(onPin)}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
              {t(pinned ? "取消置顶" : "置顶")}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => choose(onRename)}
            >
              <Pencil size={14} />
              {t("修改名称")}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="history-actions-delete"
              onClick={() => choose(onDelete)}
            >
              <Trash2 size={14} />
              {t("删除")}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
