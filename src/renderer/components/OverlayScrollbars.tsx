import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import "./overlay-scrollbars.css";

type Axis = "x" | "y";
type Point = { x: number; y: number };
type Bounds = { left: number; right: number; top: number; bottom: number };
type Metrics = {
  start: number;
  length: number;
  thumbLength: number;
  maximum: number;
};
type ScrollOwner = {
  element: HTMLElement;
  x: HTMLElement | null;
  y: HTMLElement | null;
};

const thickness = 8;
const inset = 0;
const minimumThumb = 24;
const scrollableOverflow = /^(auto|scroll|overlay)$/;
const clippingOverflow = /^(auto|scroll|overlay|hidden|clip)$/;

function getOwner(element: Element | null): ScrollOwner | null {
  let owner: ScrollOwner | null = null;
  for (let current = element; current; current = current.parentElement) {
    if (!(current instanceof HTMLElement)) continue;
    const horizontal = current.scrollWidth > current.clientWidth + 1;
    const vertical = current.scrollHeight > current.clientHeight + 1;
    if (!horizontal && !vertical) continue;
    const style = getComputedStyle(current);
    const x = horizontal && scrollableOverflow.test(style.overflowX);
    const y = vertical && scrollableOverflow.test(style.overflowY);
    if (!x && !y) continue;
    owner ??= { element: current, x: null, y: null };
    if (x && !owner.x) owner.x = current;
    if (y && !owner.y) owner.y = current;
    if (owner.x && owner.y) break;
  }
  return owner;
}

function clientBounds(element: HTMLElement): Bounds {
  const rect = element.getBoundingClientRect();
  const left = rect.left + element.clientLeft;
  const top = rect.top + element.clientTop;
  return {
    left,
    top,
    right: left + element.clientWidth,
    bottom: top + element.clientHeight,
  };
}

function visibleBounds(element: HTMLElement): Bounds | null {
  if (!element.isConnected || !element.checkVisibility()) return null;
  const own = clientBounds(element);
  const bounds = {
    left: Math.max(0, own.left),
    right: Math.min(window.innerWidth, own.right),
    top: Math.max(0, own.top),
    bottom: Math.min(window.innerHeight, own.bottom),
  };
  for (
    let ancestor = element.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);
    const clipX = clippingOverflow.test(style.overflowX);
    const clipY = clippingOverflow.test(style.overflowY);
    if (!clipX && !clipY) continue;
    const clip = clientBounds(ancestor);
    if (clipX) {
      bounds.left = Math.max(bounds.left, clip.left);
      bounds.right = Math.min(bounds.right, clip.right);
    }
    if (clipY) {
      bounds.top = Math.max(bounds.top, clip.top);
      bounds.bottom = Math.min(bounds.bottom, clip.bottom);
    }
  }
  return bounds.right - bounds.left > thickness &&
    bounds.bottom - bounds.top > thickness
    ? bounds
    : null;
}

function position(
  element: HTMLElement,
  values: Record<string, number | string>,
) {
  for (const [property, value] of Object.entries(values)) {
    const next = typeof value === "number" ? `${value}px` : value;
    if (element.style.getPropertyValue(property) !== next)
      element.style.setProperty(property, next);
  }
}

export function OverlayScrollbars() {
  const rootRef = useRef<HTMLDivElement>(null);
  const xRef = useRef<HTMLDivElement>(null);
  const yRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current!;
    const rails = { x: xRef.current!, y: yRef.current! };
    const thumbs = {
      x: rails.x.firstElementChild as HTMLElement,
      y: rails.y.firstElementChild as HTMLElement,
    };
    let owner: ScrollOwner | null = null;
    let pointer: Point | null = null;
    let frame = 0;
    let metrics: Partial<Record<Axis, Metrics>> = {};
    let drag: {
      axis: Axis;
      pointerId: number;
      coordinate: number;
      scroll: number;
    } | null = null;

    const resizeObserver = new ResizeObserver(() => schedule());
    const mutationObserver = new MutationObserver(() => schedule());

    function hide() {
      owner = null;
      metrics = {};
      root.hidden = true;
      delete root.dataset.owner;
      delete root.dataset.ownerTestid;
      Reflect.set(root, "scrollOwner", null);
      for (const axis of ["x", "y"] as const) {
        rails[axis].hidden = true;
        delete rails[axis].dataset.owner;
        Reflect.set(rails[axis], "scrollOwner", null);
      }
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      finishDrag();
    }

    function underPointer(): ScrollOwner | null {
      if (!pointer) return null;
      const target = document
        .elementsFromPoint(pointer.x, pointer.y)
        .find((element) => !root.contains(element));
      return getOwner(target ?? null);
    }

    function setOwner(next: ScrollOwner | null) {
      if (!next) return hide();
      if (
        next.element !== owner?.element ||
        next.x !== owner.x ||
        next.y !== owner.y
      ) {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
        for (
          let current: HTMLElement | null = next.element;
          current;
          current = current.parentElement
        ) {
          resizeObserver.observe(current);
          mutationObserver.observe(current, {
            attributes: true,
            attributeFilter: ["class", "style", "hidden", "open"],
            childList: true,
          });
        }
        root.dataset.owner = `${next.element.tagName.toLowerCase()}.${[...next.element.classList].join(".")}`;
        root.dataset.ownerTestid =
          next.element.closest("[data-testid]")?.getAttribute("data-testid") ??
          "";
        Reflect.set(root, "scrollOwner", next.element);
      }
      owner = next;
    }

    function update() {
      frame = 0;
      if (!drag) setOwner(underPointer());
      if (!owner) return;
      if (!visibleBounds(owner.element)) return hide();
      root.hidden = false;
      for (const axis of ["x", "y"] as const) {
        const vertical = axis === "y";
        const element = owner[axis];
        const bounds = element ? visibleBounds(element) : null;
        const rail = rails[axis];
        rail.hidden = !element || !bounds;
        Reflect.set(rail, "scrollOwner", element);
        if (!element || !bounds) {
          delete rail.dataset.owner;
          delete metrics[axis];
          continue;
        }
        rail.dataset.owner = `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`;
        rail.dataset.size =
          element.dataset.scrollbarSize === "thin" ? "thin" : "normal";
        const start = (vertical ? bounds.top : bounds.left) + inset;
        const end =
          (vertical ? bounds.bottom : bounds.right) -
          inset -
          (vertical
            ? owner.x
              ? thickness + inset
              : 0
            : owner.y
              ? thickness + inset
              : 0);
        const length = Math.max(0, end - start);
        const viewport = vertical ? element.clientHeight : element.clientWidth;
        const content = vertical ? element.scrollHeight : element.scrollWidth;
        const maximum = content - viewport;
        if (maximum <= 1 || length <= 0) {
          rail.hidden = true;
          delete metrics[axis];
          continue;
        }
        const thumbLength = Math.min(
          length,
          Math.max(minimumThumb, (length * viewport) / content),
        );
        const scroll = vertical ? element.scrollTop : element.scrollLeft;
        const offset =
          Math.max(0, Math.min(1, scroll / maximum)) * (length - thumbLength);
        metrics[axis] = { start, length, thumbLength, maximum };
        position(rail, {
          left: vertical ? bounds.right - thickness - inset : start,
          top: vertical ? start : bounds.bottom - thickness - inset,
          width: vertical ? thickness : length,
          height: vertical ? length : thickness,
        });
        position(thumbs[axis], {
          width: vertical ? "100%" : thumbLength,
          height: vertical ? thumbLength : "100%",
          transform: vertical
            ? `translateY(${offset}px)`
            : `translateX(${offset}px)`,
        });
      }
      if (rails.x.hidden && rails.y.hidden) hide();
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }

    function finishDrag() {
      if (!drag) return;
      const rail = rails[drag.axis];
      if (rail.hasPointerCapture(drag.pointerId))
        rail.releasePointerCapture(drag.pointerId);
      drag = null;
      delete root.dataset.dragging;
    }

    function onPointerMove(event: PointerEvent) {
      if (event.pointerType === "touch") return;
      pointer = { x: event.clientX, y: event.clientY };
      if (drag && owner && event.pointerId === drag.pointerId) {
        const axis = drag.axis;
        const metric = metrics[axis];
        const element = owner[axis];
        if (!metric || !element) return hide();
        const travel = metric.length - metric.thumbLength;
        const coordinate = axis === "x" ? event.clientX : event.clientY;
        const next =
          drag.scroll +
          ((coordinate - drag.coordinate) * metric.maximum) /
            Math.max(1, travel);
        if (axis === "x") element.scrollLeft = next;
        else element.scrollTop = next;
      }
      schedule();
    }

    function onPointerDown(event: PointerEvent) {
      if (event.button !== 0 || !owner || !(event.target instanceof Element))
        return;
      const rail = event.target.closest<HTMLElement>("[data-axis]");
      const axis = rail?.dataset.axis as Axis | undefined;
      if (!axis || !root.contains(rail!)) return;
      event.preventDefault();
      const metric = metrics[axis];
      if (!metric) return;
      const element = owner[axis];
      if (!element) return;
      const coordinate = axis === "x" ? event.clientX : event.clientY;
      if (!thumbs[axis].contains(event.target)) {
        const fraction =
          (coordinate - metric.start - metric.thumbLength / 2) /
          Math.max(1, metric.length - metric.thumbLength);
        if (axis === "x") element.scrollLeft = fraction * metric.maximum;
        else element.scrollTop = fraction * metric.maximum;
      }
      drag = {
        axis,
        pointerId: event.pointerId,
        coordinate,
        scroll: axis === "x" ? element.scrollLeft : element.scrollTop,
      };
      root.dataset.dragging = axis;
      rails[axis].setPointerCapture(event.pointerId);
      schedule();
    }

    function onPointerUp(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      finishDrag();
      schedule();
    }

    function onWheel(event: WheelEvent) {
      if (!owner || event.ctrlKey || !(event.target instanceof Element)) return;
      const rail = event.target.closest<HTMLElement>("[data-axis]");
      if (!rail || !root.contains(rail)) return;
      const horizontalWheel =
        event.shiftKey || (rail.dataset.axis === "x" && !event.deltaX);
      const delta = {
        x: event.deltaX || (horizontalWheel ? event.deltaY : 0),
        y: horizontalWheel ? 0 : event.deltaY,
      };
      let consumed = false;
      for (const axis of ["x", "y"] as const) {
        const element = owner[axis];
        if (!element || !delta[axis]) continue;
        const scale =
          event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? parseFloat(getComputedStyle(element).lineHeight) || 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? axis === "x"
                ? element.clientWidth
                : element.clientHeight
              : 1;
        const before = axis === "x" ? element.scrollLeft : element.scrollTop;
        if (axis === "x") element.scrollLeft += delta[axis] * scale;
        else element.scrollTop += delta[axis] * scale;
        consumed ||=
          before !== (axis === "x" ? element.scrollLeft : element.scrollTop);
      }
      if (consumed) event.preventDefault();
      schedule();
    }

    function onPointerOut(event: PointerEvent) {
      if (event.relatedTarget !== null) return;
      pointer = null;
      if (!drag) hide();
    }

    function onBlur() {
      pointer = null;
      hide();
    }

    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("input", schedule, true);
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("lostpointercapture", onPointerUp);
    root.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", schedule);
    window.addEventListener("blur", onBlur);
    return () => {
      hide();
      cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("input", schedule, true);
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("lostpointercapture", onPointerUp);
      root.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return createPortal(
    <div
      ref={rootRef}
      className="overlay-scrollbars"
      data-testid="overlay-scrollbars"
      aria-hidden="true"
      hidden
    >
      <div ref={xRef} className="overlay-scrollbar-rail" data-axis="x" hidden>
        <div
          className="overlay-scrollbar-thumb"
          data-testid="overlay-scrollbar-thumb"
        />
      </div>
      <div ref={yRef} className="overlay-scrollbar-rail" data-axis="y" hidden>
        <div
          className="overlay-scrollbar-thumb"
          data-testid="overlay-scrollbar-thumb"
        />
      </div>
    </div>,
    document.body,
  );
}
