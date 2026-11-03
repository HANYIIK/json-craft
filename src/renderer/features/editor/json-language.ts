import { jsonLanguage as baseJsonLanguage } from "@codemirror/lang-json";
import { LanguageSupport, ParseContext } from "@codemirror/language";
import { StateField, Text, type Extension } from "@codemirror/state";
import { Tree, TreeFragment, type Input } from "@lezer/common";

const MIN_STRING_LENGTH = 16_384;
const baseParser = baseJsonLanguage.parser;
const stringType = baseParser.nodeSet.types.find(
  (type) => type.name === "String",
)!;
const keyType = baseParser.nodeSet.types.find(
  (type) => type.name === "PropertyName",
)!;

interface IndexedLine {
  from: number;
  to: number;
  fragments: readonly TreeFragment[];
}

interface StringIndex {
  lines: readonly IndexedLine[];
  fragments: readonly TreeFragment[];
}

interface Span {
  from: number;
  to: number;
}

const indexes = new WeakMap<Text, StringIndex>();

function mayContainLongString(text: string) {
  const quote = /[^\\](?:\\\\)*"/;
  for (let from = 0; from + 4_096 <= text.length; from += 4_096)
    if (!quote.test(text.slice(from, from + 4_096))) return true;
  return false;
}

function indexLine(text: string, from: number): IndexedLine | undefined {
  if (text.length < MIN_STRING_LENGTH || !mayContainLongString(text))
    return undefined;
  const fragments: TreeFragment[] = [];
  const closingQuote = /(?<!\\)(?:\\\\)*"/g;
  for (let offset = 0; offset < text.length;) {
    const start = text.indexOf('"', offset);
    if (start < 0) break;
    closingQuote.lastIndex = start + 1;
    const closing = closingQuote.exec(text);
    if (!closing) break;
    offset = closing.index + closing[0].length;
    if (offset - start < MIN_STRING_LENGTH) continue;
    const literal = text.slice(start, offset);
    if (
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        literal,
      )
    )
      continue;
    try {
      JSON.parse(literal);
    } catch {
      continue;
    }
    let next = offset;
    while (next < text.length && /[ \t\r\n]/.test(text[next])) next++;
    const type = text[next] === ":" ? keyType : stringType;
    const length = offset - start;
    const leaf = new Tree(type, [], [], length);
    const tree = new Tree(baseParser.topNode, [leaf], [0], length);
    fragments.push(
      new TreeFragment(from + start, from + offset, tree, -from - start),
    );
  }
  return fragments.length
    ? { from, to: from + text.length, fragments }
    : undefined;
}

function createIndex(lines: readonly IndexedLine[], doc: Text): StringIndex {
  const index = { lines, fragments: lines.flatMap((line) => line.fragments) };
  indexes.set(doc, index);
  return index;
}

function scanLines(doc: Text, from = 0, to = doc.length): IndexedLine[] {
  const lines: IndexedLine[] = [];
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  let offset = first.from;
  for (const text of doc.iterLines(first.number, last.number + 1)) {
    const line = indexLine(text, offset);
    if (line) lines.push(line);
    offset += text.length + 1;
  }
  return lines;
}

function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of spans.sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to + 1) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

const stringIndex = StateField.define<StringIndex>({
  create(state) {
    return (
      indexes.get(state.doc) ?? createIndex(scanLines(state.doc), state.doc)
    );
  },
  update(index, transaction) {
    if (!transaction.docChanged) return index;
    const previous: Span[] = [];
    const changed: Span[] = [];
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      previous.push({
        from: transaction.startState.doc.lineAt(fromA).from,
        to: transaction.startState.doc.lineAt(toA).to,
      });
      changed.push({
        from: transaction.newDoc.lineAt(fromB).from,
        to: transaction.newDoc.lineAt(toB).to,
      });
    });
    const oldRanges = mergeSpans(previous);
    const kept = index.lines
      .filter(
        (line) =>
          !oldRanges.some(
            (range) => line.from <= range.to && line.to >= range.from,
          ),
      )
      .map((line) => {
        const from = transaction.changes.mapPos(line.from, 1);
        const delta = from - line.from;
        if (!delta) return line;
        return {
          from,
          to: line.to + delta,
          fragments: line.fragments.map(
            (fragment) =>
              new TreeFragment(
                fragment.from + delta,
                fragment.to + delta,
                fragment.tree,
                fragment.offset - delta,
              ),
          ),
        };
      });
    for (const range of mergeSpans(changed))
      kept.push(...scanLines(transaction.newDoc, range.from, range.to));
    return createIndex(
      kept.sort((a, b) => a.from - b.from),
      transaction.newDoc,
    );
  },
});

function indexFor(input: Input): StringIndex {
  const context = ParseContext.get();
  if (context)
    return (
      context.state.field(stringIndex, false) ??
      indexes.get(context.state.doc) ??
      createIndex(scanLines(context.state.doc), context.state.doc)
    );
  const doc = Text.of(input.read(0, input.length).split("\n"));
  return createIndex(scanLines(doc), doc);
}

function reusableStrings(
  fragments: readonly TreeFragment[],
  additions: readonly TreeFragment[],
): readonly TreeFragment[] {
  if (!additions.length) return fragments;
  const combined: TreeFragment[] = [];
  for (const fragment of fragments) {
    let from = fragment.from;
    for (const addition of additions) {
      if (addition.to <= from) continue;
      if (addition.from >= fragment.to) break;
      if (addition.from > from)
        combined.push(
          new TreeFragment(
            from,
            addition.from,
            fragment.tree,
            fragment.offset,
            fragment.openStart || from !== fragment.from,
            true,
          ),
        );
      from = Math.max(from, addition.to);
      if (from >= fragment.to) break;
    }
    if (from < fragment.to)
      combined.push(
        new TreeFragment(
          from,
          fragment.to,
          fragment.tree,
          fragment.offset,
          fragment.openStart || from !== fragment.from,
          fragment.openEnd,
        ),
      );
  }
  return combined.concat(additions).sort((a, b) => a.from - b.from);
}

export const optimizedJsonLanguage = baseJsonLanguage.configure({
  wrap(inner, input, fragments, ranges) {
    if (input.length < MIN_STRING_LENGTH) return inner;
    const additions = indexFor(input).fragments.filter((fragment) =>
      ranges.some(
        (range) => range.from <= fragment.from && range.to >= fragment.to,
      ),
    );
    if (!additions.length) return inner;
    return baseParser.startParse(
      input,
      reusableStrings(fragments, additions),
      ranges,
    );
  },
});

export function json(): Extension {
  return [stringIndex, new LanguageSupport(optimizedJsonLanguage)];
}
