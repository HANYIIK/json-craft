import { useCallback, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import "./sidebar-motion.css";

interface SidebarTransition {
  ready: Promise<void>;
  finished: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition(): void;
}

interface PendingSidebarTransition {
  apply(): void;
  discard(): void;
  transition?: SidebarTransition;
}

const motionAttribute = "data-json-sidebar-motion";

export function useSidebarMotion() {
  const pending = useRef<PendingSidebarTransition | null>(null);

  const finish = useCallback((entry: PendingSidebarTransition) => {
    if (pending.current !== entry) return;
    pending.current = null;
    document.documentElement.removeAttribute(motionAttribute);
  }, []);

  const cancel = useCallback(() => {
    const entry = pending.current;
    if (!entry) return;
    try {
      entry.apply();
    } finally {
      entry.transition?.skipTransition();
      finish(entry);
    }
  }, [finish]);

  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const reduceMotion = () => {
      if (preference.matches) cancel();
    };
    const visibilityChanged = () => {
      if (document.visibilityState !== "visible") cancel();
    };
    preference.addEventListener("change", reduceMotion);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      preference.removeEventListener("change", reduceMotion);
      document.removeEventListener("visibilitychange", visibilityChanged);
      const entry = pending.current;
      if (!entry) return;
      entry.discard();
      entry.transition?.skipTransition();
      finish(entry);
    };
  }, [cancel, finish]);

  return useCallback(
    (update: () => void) => {
      cancel();
      let applied = false;
      const entry: PendingSidebarTransition = {
        apply() {
          if (applied) return;
          applied = true;
          flushSync(update);
        },
        discard() {
          applied = true;
        },
      };
      if (
        typeof document.startViewTransition !== "function" ||
        document.visibilityState !== "visible" ||
        matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        entry.apply();
        return;
      }
      pending.current = entry;
      document.documentElement.setAttribute(
        motionAttribute,
        document.querySelector('.application[data-sidebar-collapsed="true"]')
          ? "expanding"
          : "collapsing",
      );
      try {
        const transition = document.startViewTransition(entry.apply);
        entry.transition = transition;
        void transition.ready.catch(() => {});
        void transition.updateCallbackDone.catch(() => {});
        void transition.finished
          .then(
            () => finish(entry),
            () => {
              try {
                entry.apply();
              } finally {
                finish(entry);
              }
            },
          )
          .catch(() => finish(entry));
      } catch {
        try {
          entry.apply();
        } finally {
          finish(entry);
        }
      }
    },
    [cancel, finish],
  );
}
