import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { DiffTextProjection } from "./diff-text-projection";

type TokenKind = "key" | "string" | "number" | "punctuation";

const OUTSIDE = 0;
const STRING = 1;
const KEY = 2;
const NUMBER = 3;
const KEY_GAP = 4;
const LITERAL = 5;
const ESCAPED = 8;

const marks = Object.fromEntries(
  ["key", "string", "number", "punctuation"].map((kind) => [
    kind,
    Decoration.mark({ class: `cm-projected-json-${kind}` }),
  ]),
);

function numberCharacter(character: number) {
  return (
    (character >= 48 && character <= 57) ||
    character === 46 ||
    character === 101 ||
    character === 69 ||
    character === 43 ||
    character === 45
  );
}

function whitespace(character: number) {
  return (
    character === 32 ||
    character === 9 ||
    character === 10 ||
    character === 13 ||
    (character > 127 && /\s/.test(String.fromCharCode(character)))
  );
}

function literalLength(source: string, position: number) {
  const character = source.charCodeAt(position);
  if (character === 116 && source.startsWith("true", position)) return 4;
  if (character === 102 && source.startsWith("false", position)) return 5;
  if (character === 110 && source.startsWith("null", position)) return 4;
  return 0;
}

function punctuation(character: number) {
  return (
    character === 123 ||
    character === 125 ||
    character === 91 ||
    character === 93 ||
    character === 58 ||
    character === 44
  );
}

export class ProjectedJsonIndex {
  readonly rowStarts: Uint32Array;
  readonly states: Uint8Array;

  constructor(readonly projection: DiffTextProjection) {
    const { source, breaks, doc } = projection;
    this.rowStarts = new Uint32Array(doc.lines);
    this.states = new Uint8Array(doc.lines);
    let displayFrom = 0,
      removed = 0,
      row = 0;
    for (const line of doc.iterLines()) {
      while (removed < breaks.length && breaks[removed] + removed < displayFrom)
        removed++;
      this.rowStarts[row++] = displayFrom - removed;
      displayFrom += line.length + 1;
    }
    row = 0;
    const remember = (position: number, state: number) => {
      while (row < this.rowStarts.length && this.rowStarts[row] <= position)
        this.states[row++] = state;
    };
    for (let position = 0; position < source.length;) {
      remember(position, OUTSIDE);
      const from = position;
      const character = source.charCodeAt(position++);
      if (character === 34) {
        const firstRow = row;
        let escaped = false;
        while (position < source.length) {
          remember(position, STRING | (escaped ? ESCAPED : 0));
          const next = source.charCodeAt(position++);
          if (escaped) escaped = false;
          else if (next === 92) escaped = true;
          else if (next === 34) break;
        }
        let after = position;
        while (after < source.length && whitespace(source.charCodeAt(after)))
          after++;
        if (source.charCodeAt(after) === 58) {
          for (let index = firstRow; index < row; index++)
            this.states[index] = KEY | (this.states[index] & ESCAPED);
          remember(after, KEY_GAP);
        }
      } else if (character === 45 || (character >= 48 && character <= 57)) {
        while (
          position < source.length &&
          numberCharacter(source.charCodeAt(position))
        )
          position++;
        remember(position - 1, NUMBER);
      } else {
        const length = literalLength(source, from);
        if (length) {
          position = from + length;
          remember(position - 1, LITERAL);
        }
      }
    }
  }

  highlight(
    from: number,
    to: number,
    add: (from: number, to: number, kind: TokenKind) => void,
  ) {
    const { source, doc } = this.projection;
    const first = doc.lineAt(from).number - 1;
    const last = doc.lineAt(to).number - 1;
    for (let row = first; row <= last; row++) {
      const line = doc.line(row + 1);
      const rowFrom = this.rowStarts[row];
      const end = rowFrom + line.length;
      let position = rowFrom;
      let state = this.states[row] & 7;
      let escaped = Boolean(this.states[row] & ESCAPED);
      const emit = (start: number, end: number, kind: TokenKind) => {
        const startDisplay = Math.max(from, line.from + start - rowFrom);
        const endDisplay = Math.min(to, line.from + end - rowFrom);
        if (startDisplay < endDisplay) add(startDisplay, endDisplay, kind);
      };
      while (position < end) {
        const start = position;
        if (state === STRING || state === KEY) {
          while (position < end) {
            const character = source.charCodeAt(position++);
            if (escaped) escaped = false;
            else if (character === 92) escaped = true;
            else if (character === 34) break;
          }
          emit(start, position, state === KEY ? "key" : "string");
          state = OUTSIDE;
        } else if (state === NUMBER || state === LITERAL) {
          while (position < end) {
            const character = source.charCodeAt(position);
            if (
              state === NUMBER
                ? !numberCharacter(character)
                : character < 97 || character > 122
            )
              break;
            position++;
          }
          emit(start, position, "number");
          state = OUTSIDE;
        } else {
          const character = source.charCodeAt(position++);
          if (character === 34) {
            let closed = false;
            escaped = false;
            while (position < end) {
              const next = source.charCodeAt(position++);
              if (escaped) escaped = false;
              else if (next === 92) escaped = true;
              else if (next === 34) {
                closed = true;
                break;
              }
            }
            let after = position;
            while (after < end && whitespace(source.charCodeAt(after))) after++;
            const following = this.states[row + 1] & 7;
            const key = closed
              ? after < end
                ? source.charCodeAt(after) === 58
                : following === KEY_GAP
              : following === KEY;
            emit(start, position, key ? "key" : "string");
          } else if (character === 45 || (character >= 48 && character <= 57)) {
            while (
              position < end &&
              numberCharacter(source.charCodeAt(position))
            )
              position++;
            emit(start, position, "number");
          } else if (punctuation(character)) {
            emit(start, position, "punctuation");
          } else {
            const length = literalLength(source, start);
            if (length) {
              position = Math.min(end, start + length);
              emit(start, position, "number");
            }
          }
        }
      }
    }
  }
}

export function projectedJson(projection: DiffTextProjection): Extension {
  const index = new ProjectedJsonIndex(projection);
  return [
    EditorView.clipboardOutputFilter.of((_text, state) => {
      const selected = state.selection.ranges.filter((range) => !range.empty);
      if (selected.length)
        return selected
          .map((range) =>
            projection.source.slice(
              projection.toSource(range.from),
              projection.toSource(range.to),
            ),
          )
          .join(state.lineBreak);
      const lines = new Set<number>();
      return state.selection.ranges
        .flatMap((range) => {
          const line = projection.sourceDoc.lineAt(
            projection.toSource(range.from),
          );
          if (lines.has(line.number)) return [];
          lines.add(line.number);
          return [line.text];
        })
        .join(state.lineBreak);
    }),
    ViewPlugin.fromClass(
      class {
        decorations;
        constructor(view: EditorView) {
          this.decorations = this.highlight(view);
        }
        update(update: ViewUpdate) {
          if (update.viewportChanged || update.docChanged)
            this.decorations = this.highlight(update.view);
        }
        highlight(view: EditorView) {
          const builder = new RangeSetBuilder<Decoration>();
          for (const range of view.visibleRanges) {
            index.highlight(range.from, range.to, (from, to, kind) =>
              builder.add(from, to, marks[kind]),
            );
          }
          return builder.finish();
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
  ];
}
