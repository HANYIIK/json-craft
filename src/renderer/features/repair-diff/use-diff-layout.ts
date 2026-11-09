import { useLayoutEffect, useState, type RefObject } from "react";
import type { DiffProjectionLayout } from "./diff-text-projection";

export function useDiffLayout(
  host: RefObject<HTMLDivElement | null>,
  sourceLines: number,
) {
  const [layout, setLayout] = useState<DiffProjectionLayout>();
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fingerprint = "";
    let disposed = false;
    const update = () => {
      timer = undefined;
      if (disposed || element.clientWidth <= 0) return;
      const probe = document.createElement("span");
      probe.className = "cm-scroller";
      probe.style.cssText =
        "position:absolute;visibility:hidden;font-size:12px";
      element.append(probe);
      const style = getComputedStyle(probe);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      probe.remove();
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = font;
      const measure = (text: string) =>
        context.measureText(text === "\t" ? "    " : text).width;
      const gutter = Math.max(
        35,
        measure("9".repeat(String(sourceLines).length)) + 13,
      );
      const width = Math.max(
        24,
        Math.floor((element.clientWidth - 10) / 2 - gutter - 18 - 20 - 12),
      );
      const ceiling = document.createElement("div");
      ceiling.style.cssText =
        "position:fixed;visibility:hidden;pointer-events:none;left:-100px;top:0;width:1px;height:100000000px";
      document.body.append(ceiling);
      const maxDOMHeight = Math.floor(
        ceiling.getBoundingClientRect().height * 0.9,
      );
      ceiling.remove();
      const next = `${width}:${font}:${measure("0中😀")}:${maxDOMHeight}`;
      if (next !== fingerprint) {
        fingerprint = next;
        setLayout({ width, measure, maxDOMHeight });
      }
    };
    const schedule = () => {
      if (disposed) return;
      clearTimeout(timer);
      timer = setTimeout(update, 90);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", schedule);
    void document.fonts.ready.then(schedule);
    update();
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", schedule);
    };
  }, [host, sourceLines]);
  return layout;
}
