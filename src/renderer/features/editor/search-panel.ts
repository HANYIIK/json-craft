import {
  SearchQuery,
  SearchCursor,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import {
  EditorView,
  runScopeHandlers,
  type Command,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import { EditorState, Facet } from "@codemirror/state";
import { translate } from "../../i18n/i18n";

export const searchPanelLanguage = Facet.define<"zh-CN" | "en", "zh-CN" | "en">(
  {
    combine: (values) => values[0] ?? "zh-CN",
  },
);

const numberFormatters = {
  "zh-CN": new Intl.NumberFormat("zh-CN"),
  en: new Intl.NumberFormat("en"),
};

class MatchIndex {
  private chunks: Uint32Array[] = [];
  size = 0;

  add(from: number, to: number) {
    const offset = (this.size % 2048) * 2;
    if (offset === 0) this.chunks.push(new Uint32Array(4096));
    const chunk = this.chunks[this.chunks.length - 1];
    chunk[offset] = from;
    chunk[offset + 1] = to;
    this.size++;
  }

  ordinal(from: number, to: number) {
    let low = 0;
    let high = this.size;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const chunk = this.chunks[Math.floor(middle / 2048)];
      const offset = (middle % 2048) * 2;
      if (chunk[offset] < from) low = middle + 1;
      else high = middle;
    }
    if (low === this.size) return 0;
    const chunk = this.chunks[Math.floor(low / 2048)];
    const offset = (low % 2048) * 2;
    return chunk[offset] === from && chunk[offset + 1] === to ? low + 1 : 0;
  }
}

function sameSearch(left: SearchQuery, right: SearchQuery) {
  return (
    left.search === right.search &&
    left.caseSensitive === right.caseSensitive &&
    left.literal === right.literal &&
    left.regexp === right.regexp &&
    left.wholeWord === right.wholeWord &&
    left.test === right.test
  );
}

class JsonSearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  readonly pos = 80;
  private query: SearchQuery;
  private searchField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private caseField: HTMLInputElement;
  private regexpField: HTMLInputElement;
  private wordField: HTMLInputElement;
  private count: HTMLElement;
  private localizers: (() => void)[] = [];
  private replacement?: HTMLElement;
  private replaceToggle?: HTMLButtonElement;
  private matches = new MatchIndex();
  private counting = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private view: EditorView) {
    const document = view.dom.ownerDocument;
    const phrase = (key: string) => view.state.phrase(key);
    this.query = getSearchQuery(view.state);
    const field = (name: string, label: string, checkbox = false) => {
      const input = document.createElement("input");
      input.name = name;
      input.type = checkbox ? "checkbox" : "text";
      input.setAttribute("form", "");
      if (!checkbox) {
        input.className = "cm-textfield";
        this.localizers.push(() => {
          input.placeholder = phrase(label);
          input.setAttribute("aria-label", phrase(label));
        });
        input.spellcheck = false;
        input.autocomplete = "off";
        input.addEventListener("input", () => this.commit());
      }
      input.addEventListener("change", () => this.commit());
      return input;
    };
    const button = (name: string, label: string, command: Command) => {
      const element = document.createElement("button");
      element.type = "button";
      element.name = name;
      element.className = "cm-button";
      this.localizers.push(() => {
        element.textContent = name === "close" ? "×" : phrase(label);
        element.setAttribute("aria-label", phrase(label));
      });
      element.addEventListener("click", () => command(view));
      return element;
    };
    const option = (input: HTMLInputElement, label: string) => {
      const element = document.createElement("label");
      const text = document.createTextNode("");
      this.localizers.push(() => {
        text.nodeValue = phrase(label);
      });
      element.append(input, text);
      return element;
    };
    this.searchField = field("search", "Find");
    this.searchField.setAttribute("main-field", "true");
    this.replaceField = field("replace", "Replace");
    this.caseField = field("case", "", true);
    this.regexpField = field("re", "", true);
    this.wordField = field("word", "", true);
    this.count = document.createElement("span");
    this.count.className = "cm-search-count";
    this.count.setAttribute("role", "status");
    this.count.setAttribute("aria-live", "polite");
    this.count.setAttribute("aria-atomic", "true");
    const find = document.createElement("div");
    find.className = "cm-search-field";
    find.append(this.searchField, this.count);
    this.dom = document.createElement("div");
    this.dom.className = "cm-search";
    this.dom.append(
      find,
      button("next", "next", findNext),
      button("prev", "previous", findPrevious),
      button("select", "all", selectMatches),
      option(this.caseField, "match case"),
      option(this.regexpField, "regexp"),
      option(this.wordField, "by word"),
    );
    if (!view.state.readOnly) {
      const replacement = document.createElement("div");
      replacement.id = `cm-search-replace-${crypto.randomUUID()}`;
      replacement.className = "cm-search-replace";
      this.replacement = replacement;
      replacement.hidden = true;
      replacement.setAttribute("role", "group");
      replacement.append(
        this.replaceField,
        button("replace", "replace", replaceNext),
        button("replaceAll", "replace all", replaceAll),
      );
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.name = "toggleReplace";
      toggle.className = "cm-search-toggle";
      this.replaceToggle = toggle;
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-controls", replacement.id);
      const arrow = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      arrow.setAttribute("viewBox", "0 0 24 24");
      arrow.setAttribute("width", "14");
      arrow.setAttribute("height", "14");
      arrow.setAttribute("fill", "none");
      arrow.setAttribute("stroke", "currentColor");
      arrow.setAttribute("stroke-linecap", "round");
      arrow.setAttribute("stroke-linejoin", "round");
      arrow.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute("d", "m9 6 6 6-6 6");
      arrow.append(path);
      toggle.append(arrow);
      toggle.addEventListener("click", () => {
        const expanded = replacement.hidden;
        const restoreFocus =
          !expanded && replacement.contains(view.root.activeElement);
        if (restoreFocus) toggle.focus({ preventScroll: true });
        replacement.hidden = !expanded;
        toggle.setAttribute("aria-expanded", String(expanded));
        this.localizeReplacement();
        view.requestMeasure();
      });
      find.prepend(toggle);
      this.dom.append(replacement);
    }
    const close = button("close", "close", closeSearchPanel);
    this.dom.append(close);
    this.dom.addEventListener("keydown", (event) => {
      if (runScopeHandlers(view, event, "search-panel")) event.preventDefault();
      else if (event.key === "Enter" && !event.isComposing) {
        if (event.target === this.searchField) {
          event.preventDefault();
          (event.shiftKey ? findPrevious : findNext)(view);
        } else if (event.target === this.replaceField) {
          event.preventDefault();
          replaceNext(view);
        }
      }
    });
    this.syncFields();
    this.localize();
    this.recount();
  }

  private localizeReplacement() {
    if (!this.replacement || !this.replaceToggle) return;
    this.replacement.setAttribute("aria-label", translate("替换"));
    const label = translate(this.replacement.hidden ? "展开替换" : "收起替换");
    this.replaceToggle.setAttribute("aria-label", label);
    this.replaceToggle.title = label;
  }

  private localize() {
    for (const localize of this.localizers) localize();
    this.count.setAttribute("aria-label", translate("查找匹配进度"));
    this.localizeReplacement();
    this.renderCount();
  }

  private commit() {
    const query = new SearchQuery({
      ...this.query,
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.regexpField.checked,
      wholeWord: this.wordField.checked,
    });
    if (!query.eq(this.query)) {
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  }

  private syncFields() {
    if (this.searchField.value !== this.query.search)
      this.searchField.value = this.query.search;
    if (this.replaceField.value !== this.query.replace)
      this.replaceField.value = this.query.replace;
    this.caseField.checked = this.query.caseSensitive;
    this.regexpField.checked = this.query.regexp;
    this.wordField.checked = this.query.wholeWord;
    this.searchField.setAttribute(
      "aria-invalid",
      String(Boolean(this.query.search) && !this.query.valid),
    );
  }

  private recount() {
    clearTimeout(this.timer);
    this.matches = new MatchIndex();
    this.counting = this.query.valid;
    this.renderCount();
    if (!this.counting) return;
    const cursor = this.query.getCursor(this.view.state);
    const index = this.matches;
    const scan = () => {
      const start = performance.now();
      do {
        for (let step = 0; step < 256; step++) {
          const match =
            cursor instanceof SearchCursor
              ? cursor.nextOverlapping()
              : cursor.next();
          if (match.done) {
            this.counting = false;
            this.timer = undefined;
            this.renderCount();
            return;
          }
          index.add(match.value.from, match.value.to);
        }
      } while (performance.now() - start < 8);
      this.timer = setTimeout(scan, 0);
    };
    this.timer = setTimeout(scan, 0);
  }

  private renderCount() {
    const { from, to } = this.view.state.selection.main;
    const ordinal = this.matches.ordinal(from, to);
    const invalid = Boolean(this.query.search) && !this.query.valid;
    const formatter =
      numberFormatters[this.view.state.facet(searchPanelLanguage)];
    const current = formatter.format(ordinal);
    const total = formatter.format(this.matches.size);
    this.count.textContent = this.counting
      ? translate("统计中…")
      : `${current} / ${total}`;
    this.count.title = this.counting
      ? translate("正在统计全文匹配")
      : invalid
        ? translate("正则表达式无效")
        : this.query.search && this.matches.size === 0
          ? translate("未找到匹配项")
          : ordinal
            ? translate("当前第 {{current}} 个，共 {{total}} 处匹配", {
                current,
                total,
              })
            : translate("共 {{total}} 处匹配，尚未选中匹配项", { total });
    this.count.setAttribute("aria-busy", String(this.counting));
    this.count.classList.toggle(
      "cm-search-count-empty",
      Boolean(this.query.search) && !this.counting && this.matches.size === 0,
    );
  }

  update(update: ViewUpdate) {
    const query = getSearchQuery(update.state);
    const changed = !sameSearch(query, this.query);
    this.query = query;
    this.syncFields();
    if (
      update.state.facet(searchPanelLanguage) !==
        update.startState.facet(searchPanelLanguage) ||
      update.state.facet(EditorState.phrases) !==
        update.startState.facet(EditorState.phrases)
    )
      this.localize();
    if (update.docChanged || changed) this.recount();
    else if (update.selectionSet) this.renderCount();
  }

  mount() {
    this.searchField.select();
  }

  destroy() {
    clearTimeout(this.timer);
  }
}

export const jsonSearch = search({
  top: true,
  createPanel: (view) => new JsonSearchPanel(view),
});
