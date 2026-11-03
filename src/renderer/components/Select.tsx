import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { useI18n } from "../i18n/i18n";
import "./select.css";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface Props {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
  size?: "compact" | "default";
}

interface Position {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export function Select({
  label,
  value,
  options,
  onChange,
  id,
  disabled = false,
  size = "default",
}: Props) {
  const { t, language } = useI18n();
  const generatedId = useId();
  const listId = `${generatedId}-options`;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<Position>();
  const enabled = options.flatMap((option, index) =>
    option.disabled ? [] : [index],
  );
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const unavailable = disabled || !enabled.length;

  function close() {
    setOpen(false);
    setPosition(undefined);
    search.current = { text: "", time: 0 };
  }

  function show(index = selectedIndex) {
    if (unavailable) return;
    setActive(enabled.includes(index) ? index : enabled[0]);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled || unavailable) return;
    onChange(option.value);
    close();
    trigger.current?.focus({ preventScroll: true });
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (unavailable || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      close();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(active);
      else show();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open)
        show(
          selectedIndex < 0 && event.key === "ArrowUp"
            ? enabled.at(-1)
            : selectedIndex,
        );
      else {
        const current = enabled.indexOf(active);
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActive(
          enabled[(current + direction + enabled.length) % enabled.length],
        );
      }
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      show(event.key === "Home" ? enabled[0] : enabled[enabled.length - 1]);
    } else if (event.key.length === 1 && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const now = Date.now();
      const character = event.key.toLocaleLowerCase(language);
      const previous =
        now - search.current.time < 700 ? search.current.text : "";
      const text = previous + character;
      search.current = { text, time: now };
      const query = [...text].every((letter) => letter === character)
        ? character
        : text;
      const start = query.length === 1 ? (open ? active : selectedIndex) : -1;
      const order = [
        ...enabled.filter((index) => index > start),
        ...enabled.filter((index) => index <= start),
      ];
      const match = order.find((index) =>
        options[index].label.toLocaleLowerCase(language).startsWith(query),
      );
      if (match !== undefined) show(match);
    }
  }

  useLayoutEffect(() => {
    if (!open) return;
    if (unavailable) {
      setOpen(false);
      setPosition(undefined);
      return;
    }
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      const list = menu.current;
      if (!rect || !list) return;
      if (
        rect.bottom <= 0 ||
        rect.top >= innerHeight ||
        rect.right <= 0 ||
        rect.left >= innerWidth
      ) {
        setOpen(false);
        return;
      }
      const inset = 8;
      const gap = 6;
      const width = Math.min(
        Math.max(rect.width, size === "compact" ? 148 : 220),
        innerWidth - inset * 2,
      );
      const below = innerHeight - rect.bottom - gap - inset;
      const above = rect.top - gap - inset;
      const desired = Math.min(list.scrollHeight, 280);
      const upwards = below < desired && above > below;
      const maxHeight = Math.max(0, Math.min(280, upwards ? above : below));
      setPosition({
        top: upwards
          ? Math.max(inset, rect.top - gap - Math.min(desired, maxHeight))
          : rect.bottom + gap,
        left: Math.max(inset, Math.min(rect.left, innerWidth - width - inset)),
        width,
        maxHeight,
      });
    };
    update();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target))
        return;
      update();
    };
    const onOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !trigger.current?.contains(event.target) &&
        !menu.current?.contains(event.target)
      )
        close();
    };
    window.addEventListener("resize", update);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerdown", onOutside);
    const observer = new ResizeObserver(update);
    if (trigger.current) observer.observe(trigger.current);
    if (menu.current) observer.observe(menu.current);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", onOutside);
      observer.disconnect();
    };
  }, [open, unavailable, size, options]);

  useLayoutEffect(() => {
    if (open)
      menu.current
        ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        className={`select-trigger select-${size}`}
        aria-label={label}
        aria-expanded={open && !unavailable}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && active >= 0 ? `${listId}-${active}` : undefined
        }
        disabled={unavailable}
        data-open={open || undefined}
        onKeyDown={onKeyDown}
        onClick={() => (open ? close() : show())}
        onBlur={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !menu.current?.contains(event.relatedTarget)
          )
            close();
        }}
      >
        {selected?.icon && <span className="select-icon">{selected.icon}</span>}
        <span className="select-value">{selected?.label ?? t("请选择")}</span>
        <ChevronDown size={13} className="select-chevron" />
      </button>
      {open &&
        !unavailable &&
        createPortal(
          <div
            ref={menu}
            id={listId}
            className="select-menu"
            role="listbox"
            aria-label={t("{{label}}选项", { label })}
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              width: position?.width ?? 220,
              maxHeight: position?.maxHeight ?? 280,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {options.map((option, index) => (
              <div
                id={`${listId}-${index}`}
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className="select-option"
                data-index={index}
                data-active={active === index || undefined}
                onPointerMove={() => !option.disabled && setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                {option.icon && (
                  <span className="select-icon">{option.icon}</span>
                )}
                <span className="select-option-content">
                  <span>{option.label}</span>
                  {option.description && (
                    <span className="select-option-description">
                      {option.description}
                    </span>
                  )}
                </span>
                {option.value === value && (
                  <Check size={14} className="select-check" />
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
