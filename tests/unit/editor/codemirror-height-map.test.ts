import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@codemirror/state";
import * as codeMirrorView from "@codemirror/view";

interface Oracle {
  lineHeight: number;
  lineLength: number;
  setDoc(doc: Text): Oracle;
  heightForLine(length: number): number;
}

interface Block {
  from: number;
  to: number;
  height: number;
}

interface Measurement {
  from: number;
  heights: number[];
}

interface HeightMap {
  height: number;
  applyChanges(
    decorations: readonly unknown[],
    oldDoc: Text,
    oracle: Oracle,
    changes: readonly unknown[],
  ): HeightMap;
  updateHeight(
    oracle: Oracle,
    offset: number,
    force: boolean,
    measured: Measurement,
  ): HeightMap;
  lineAt(
    position: number,
    type: number,
    oracle: Oracle,
    top: number,
    offset: number,
  ): Block;
}

const { HeightMap, HeightOracle, MeasuredHeights, QueryType, ChangedRange } = (
  codeMirrorView as unknown as {
    __test: {
      HeightMap: { empty(): HeightMap };
      HeightOracle: new (wrapping: boolean) => Oracle;
      MeasuredHeights: new (from: number, heights: number[]) => Measurement;
      QueryType: { ByPos: number };
      ChangedRange: new (
        fromA: number,
        toA: number,
        fromB: number,
        toB: number,
      ) => unknown;
    };
  }
).__test;

const doc = Text.of([
  "{",
  `  "payload": "${"x".repeat(19_500_000)}",`,
  '  "enabled": true,',
  '  "selection": true',
  "}",
]);
const primary = doc.line(2);
const selection = doc.line(4);
const primaryHeight = 7_000_000;
const selectionHeight = 46;

function freshMap() {
  const oracle = new HeightOracle(true).setDoc(doc);
  oracle.lineHeight = 23;
  oracle.lineLength = 80;
  const map = HeightMap.empty().applyChanges([], Text.empty, oracle, [
    new ChangedRange(0, 0, 0, doc.length),
  ]);
  return { map, oracle };
}

function heightAt(map: HeightMap, oracle: Oracle, position: number) {
  return map.lineAt(position, QueryType.ByPos, oracle, 0, 0).height;
}

test("native forced refresh replaces a measured long line while measuring an extra selection viewport", () => {
  let { map, oracle } = freshMap();
  map = map.updateHeight(
    oracle,
    0,
    true,
    new MeasuredHeights(primary.from, [primaryHeight]),
  );
  assert.equal(heightAt(map, oracle, primary.from), primaryHeight);
  map = map.updateHeight(
    oracle,
    0,
    true,
    new MeasuredHeights(selection.from, [selectionHeight]),
  );
  assert.equal(
    heightAt(map, oracle, primary.from),
    oracle.heightForLine(primary.length),
  );
  assert.notEqual(heightAt(map, oracle, primary.from), primaryHeight);
  assert.equal(heightAt(map, oracle, selection.from), selectionHeight);
});

test("fresh diff viewport measurements retain both real heights regardless of viewport order", () => {
  const viewports = [
    { from: primary.from, height: primaryHeight },
    { from: selection.from, height: selectionHeight },
  ];
  for (const order of [viewports, [...viewports].reverse()]) {
    let { map, oracle } = freshMap();
    for (const viewport of order)
      map = map.updateHeight(
        oracle,
        0,
        false,
        new MeasuredHeights(viewport.from, [viewport.height]),
      );
    assert.equal(heightAt(map, oracle, primary.from), primaryHeight);
    assert.equal(heightAt(map, oracle, selection.from), selectionHeight);
    assert.ok(map.height >= primaryHeight + selectionHeight);
  }
});
