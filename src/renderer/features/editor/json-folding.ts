import {
  forceParsing,
  syntaxTree,
  syntaxTreeAvailable,
} from "@codemirror/language";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

class CompleteJsonFolding {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idle: number | undefined;
  private generation = 0;
  private stopped = false;

  constructor(private view: EditorView) {
    this.schedule();
  }

  private cancel() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.idle !== undefined) cancelIdleCallback(this.idle);
    this.idle = undefined;
  }

  private schedule(delay = 30) {
    if (
      this.stopped ||
      this.timer !== undefined ||
      this.idle !== undefined ||
      (syntaxTreeAvailable(this.view.state, this.view.state.doc.length) &&
        syntaxTree(this.view.state).length === this.view.state.doc.length)
    )
      return;
    const generation = this.generation;
    const doc = this.view.state.doc;
    const run = (deadline?: IdleDeadline) => {
      this.idle = undefined;
      if (
        this.stopped ||
        generation !== this.generation ||
        doc !== this.view.state.doc ||
        !this.view.inView ||
        this.view.compositionStarted
      )
        return;
      const budget =
        deadline && !deadline.didTimeout
          ? Math.max(1, Math.min(8, deadline.timeRemaining() - 1))
          : 8;
      const done = forceParsing(this.view, doc.length, budget);
      if (
        !done &&
        generation === this.generation &&
        doc === this.view.state.doc
      )
        this.schedule();
    };
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (typeof requestIdleCallback === "function")
        this.idle = requestIdleCallback(run, { timeout: 250 });
      else run();
    }, delay);
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      this.cancel();
      this.schedule(120);
    } else if (
      update.viewportChanged ||
      update.geometryChanged ||
      update.focusChanged
    ) {
      this.schedule();
    }
  }

  resume() {
    this.schedule();
  }

  destroy() {
    this.stopped = true;
    this.cancel();
  }
}

export const completeJsonFolding = ViewPlugin.fromClass(CompleteJsonFolding, {
  eventHandlers: {
    scroll() {
      this.resume();
    },
    compositionend() {
      this.resume();
    },
  },
});
