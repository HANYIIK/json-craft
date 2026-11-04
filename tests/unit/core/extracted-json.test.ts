import assert from "node:assert/strict";
import test from "node:test";
import { processJson } from "../../../src/core/json/json";
import {
  processExtractedJson,
  processStructuredJson,
} from "../../../src/core/json/extracted-json";
import { defaultOptions, type RepairStage } from "../../../src/shared/types";

const process = (value: unknown) =>
  processExtractedJson(JSON.stringify(value), defaultOptions);

function repairedText(stage: RepairStage) {
  let output = stage.before;
  for (const change of [...stage.changes].reverse()) {
    assert.equal(stage.before.slice(change.start, change.end), change.before);
    output =
      output.slice(0, change.start) + change.after + output.slice(change.end);
  }
  return output;
}

test("decodes structured JSON strings in arrays and object properties", () => {
  const input = [
    '{"id":42}',
    "[1,2]",
    "plain text",
    "123",
    "true",
    "null",
    "",
    3,
    false,
    null,
    { kept: '{"inside":true}' },
  ];
  const result = process(input);
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.output), [
    { id: 42 },
    [1, 2],
    ...input.slice(2, -1),
    { kept: { inside: true } },
  ]);
  assert.equal(result.decodedLayers, 0);
  assert.deepEqual(result.arrayDecoding, {
    decodedItems: 3,
    failedItems: 0,
    warnings: [],
    warningsTruncated: false,
  });
  assert.equal(result.changeCount, 0);
  assert.deepEqual(result.stages, []);
});

test("supports object roots while preserving the baseline key-search formatter", () => {
  const raw = JSON.stringify({ values: ['{"id":42}'] });
  assert.deepEqual(
    JSON.parse(processStructuredJson(raw, defaultOptions).output),
    { values: [{ id: 42 }] },
  );
  assert.deepEqual(JSON.parse(processJson(raw, defaultOptions).output), {
    values: ['{"id":42}'],
  });
  assert.equal(processExtractedJson, processStructuredJson);
  const wrapped = JSON.stringify('{"id":42}');
  assert.deepEqual(
    processStructuredJson(wrapped, defaultOptions),
    processJson(wrapped, defaultOptions),
  );
});

test("preserves Markdown links across a batch without undecoded warnings", () => {
  const link =
    "[查看简历](https://example.com/talent-resume?employeeCode=42&sceneId=18&entryType=link)";
  const rows = Array.from({ length: 60 }, () => ({ 详情链接: link }));
  for (const repair of [false, true]) {
    const result = processStructuredJson(JSON.stringify(rows), {
      ...defaultOptions,
      repair,
    });
    assert.equal(result.success, true);
    assert.deepEqual(JSON.parse(result.output), rows);
    assert.equal(result.arrayDecoding, undefined);
    assert.equal(result.changeCount, 0);
    assert.deepEqual(result.stages, []);
  }
});

test("keeps bracketed prose through nested objects, arrays, and encoded envelopes", () => {
  const texts = [
    '[查看 [完整] 简历](https://example.com/resume "详情")',
    String.raw`[查看\]简历](https://example.com/resume)`,
    "[查看简历][resume]",
    "[John's resume](https://example.com/resume)",
    "[https://example.com](https://example.com)",
    "[a /* b](https://example.com)",
    "[// text](https://example.com)",
    "[提示] 这是一段普通文字",
    "{template} is ordinary text",
  ];
  const wrapped = JSON.stringify(texts[0]);
  const escaped = JSON.stringify(texts[0]).slice(1, -1);
  const input = {
    nested: { texts: [...texts, wrapped, escaped] },
    payload: JSON.stringify({ text: texts[0], items: [texts[1]] }),
  };
  const result = process(input);
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.output), {
    ...input,
    payload: { text: texts[0], items: [texts[1]] },
  });
  assert.equal(result.arrayDecoding?.decodedItems, 1);
  assert.equal(result.arrayDecoding?.failedItems, 0);
  assert.deepEqual(result.arrayDecoding?.warnings, []);
  assert.deepEqual(result.stages, []);
});

test("still decodes and repairs JSON beside Markdown without masking genuine failures", () => {
  const link = "[查看简历](https://example.com/resume)";
  const result = process({
    link,
    array: JSON.stringify([link, { text: "] } (" }]),
    repaired: "{name:'Craft } after', items:[1,2,],}",
    commented: "[1,2,] /* trailing ] } */",
    unquoted: "[first,second]",
    comments: "[/* ] */ {a:'}'} // ]\n]",
    scalarComments: "[1 /* ] */ ,true // }\n,null]",
    trailingComma: "{ready:True},",
    documents: "{a:1}\n{b:2}",
    broken: "{[}",
  });
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.output), {
    link,
    array: [link, { text: "] } (" }],
    repaired: { name: "Craft } after", items: [1, 2] },
    commented: [1, 2],
    unquoted: ["first", "second"],
    comments: [{ a: "}" }],
    scalarComments: [1, true, null],
    trailingComma: { ready: true },
    documents: [{ a: 1 }, { b: 2 }],
    broken: "{[}",
  });
  assert.equal(result.arrayDecoding?.decodedItems, 8);
  assert.equal(result.arrayDecoding?.failedItems, 1);
  assert.equal(result.arrayDecoding?.warnings[0].path, "$.broken");
  assert.ok(result.stages.every((stage) => stage.path !== "$.link"));
});

test("retains bracketed placeholders in nested fields, lists and encoded JSON without repair diagnostics", () => {
  const texts = [
    "[REDACTED]",
    "[MASKED]",
    "[hidden]",
    "[text]",
    "[not available]",
    "[token-id]",
    "[null-value]",
    "[true-story]",
    "[123-456]",
    String.raw`[\x]`,
    " [REDACTED] ",
  ];
  const values = texts.flatMap((text) => [
    text,
    JSON.stringify(text),
    JSON.stringify(JSON.stringify(text)),
  ]);
  const input = {
    rows: values.map((value) => ({ value, values: [value] })),
    metadata: {
      id: { $oid: "0123456789abcdef01234567" },
      created: { $date: 1234567890 },
    },
  };
  for (const repair of [false, true]) {
    const options = { ...defaultOptions, repair };
    const unchanged = processStructuredJson(JSON.stringify(input), options);
    assert.equal(unchanged.success, true);
    assert.deepEqual(JSON.parse(unchanged.output), input);
    assert.equal(unchanged.changeCount, 0);
    assert.deepEqual(unchanged.stages, []);
    assert.equal(unchanged.arrayDecoding, undefined);

    const encoded = processStructuredJson(
      JSON.stringify({ payload: JSON.stringify(input) }),
      options,
    );
    assert.equal(encoded.success, true);
    assert.deepEqual(JSON.parse(encoded.output), { payload: input });
    assert.equal(encoded.arrayDecoding?.decodedItems, 1);
    assert.equal(encoded.arrayDecoding?.failedItems, 0);
    assert.deepEqual(encoded.arrayDecoding?.warnings, []);
    assert.deepEqual(encoded.stages, []);
    assert.equal(encoded.changeCount, 0);
  }
});

test("still recognizes empty and typed JSON arrays beside ordinary bracketed text", () => {
  const input = {
    label: "[REDACTED]",
    quoted: '["REDACTED"]',
    escaped: String.raw`[\"REDACTED\"]`,
    singleQuoted: "['already quoted']",
    empty: "[]",
    scalar: "[1,true,false,null]",
    repaired: "[True,False,null,]",
    numeric: "[1,2,]",
  };
  const result = process(input);
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.output), {
    label: input.label,
    quoted: ["REDACTED"],
    escaped: ["REDACTED"],
    singleQuoted: ["already quoted"],
    empty: [],
    scalar: [1, true, false, null],
    repaired: [true, false, null],
    numeric: [1, 2],
  });
  assert.equal(result.arrayDecoding?.decodedItems, 7);
  assert.equal(result.arrayDecoding?.failedItems, 0);
  assert.ok(result.stages.every((stage) => stage.path !== "$.label"));
});

test("automatic unescaping disables all member transformations and diagnostics", () => {
  const raw = JSON.stringify(['{"id":42}', "{[}", '{"ready":true,}']);
  const options = { ...defaultOptions, autoUnescape: false };
  assert.deepEqual(
    processExtractedJson(raw, options),
    processJson(raw, options),
  );
});

test("walks nested arrays and objects including object string fields", () => {
  const input = [
    ['{"nested":true}'],
    { text: '{"kept":1}', rows: ['{"converted":2}'] },
  ];
  const result = process(input);
  assert.deepEqual(JSON.parse(result.output), [
    [{ nested: true }],
    { text: { kept: 1 }, rows: [{ converted: 2 }] },
  ]);
  assert.equal(result.arrayDecoding?.decodedItems, 3);
  assert.equal(
    result.output,
    JSON.stringify(JSON.parse(result.output), null, 2),
  );
});

test("decodes multiple wrappers and JSON arrays introduced by decoded strings", () => {
  const input = [
    JSON.stringify('{"deep":true}'),
    JSON.stringify(['{"inner":[1,2]}']),
  ];
  const result = process(input);
  assert.deepEqual(JSON.parse(result.output), [
    { deep: true },
    [{ inner: [1, 2] }],
  ]);
  assert.equal(result.arrayDecoding?.decodedItems, 3);
  assert.equal(result.decodedLayers, 0);
});

test("keeps root wrapper layers separate from member decoding counts", () => {
  const list = JSON.stringify(['{"a":1}']);
  const result = processExtractedJson(JSON.stringify(list), defaultOptions);
  assert.equal(result.decodedLayers, 1);
  assert.equal(result.arrayDecoding?.decodedItems, 1);
  assert.deepEqual(JSON.parse(result.output), [{ a: 1 }]);
});

test("independently controls recursive decoding after unwrapping object and array roots", () => {
  const object = {
    payload: '{"ready":true}',
    nested: { items: ["[1,2]", "ordinary text", "123"] },
  };
  const decoded = {
    payload: { ready: true },
    nested: { items: [[1, 2], "ordinary text", "123"] },
  };
  for (const [input, expected] of [
    [object, decoded],
    [
      [object, '{"id":1}'],
      [decoded, { id: 1 }],
    ],
  ]) {
    const raw = JSON.stringify(JSON.stringify(input));
    for (const autoUnescape of [false, true]) {
      const options = Object.freeze({ ...defaultOptions, autoUnescape });
      for (const recursiveUnescape of [false, true]) {
        const result = processStructuredJson(raw, options, recursiveUnescape);
        assert.equal(result.success, true);
        assert.equal(result.decodedLayers, autoUnescape ? 1 : 0);
        assert.deepEqual(
          JSON.parse(result.output),
          !autoUnescape
            ? JSON.stringify(input)
            : recursiveUnescape
              ? expected
              : input,
        );
        if (!autoUnescape || !recursiveUnescape) {
          assert.deepEqual(result, processJson(raw, options));
          assert.equal(result.arrayDecoding, undefined);
        }
      }
      assert.deepEqual(options, { ...defaultOptions, autoUnescape });
    }
    assert.deepEqual(
      processStructuredJson(raw, defaultOptions),
      processStructuredJson(raw, defaultOptions, true),
    );
    assert.deepEqual(
      processExtractedJson(raw, defaultOptions, false),
      processJson(raw, defaultOptions),
    );
  }
});

test("disabling recursion preserves duplicate keys, number literals, and string tokens", () => {
  const inner = String.raw`{"id":9007199254740993,"id":1.2300e+04,"negative":-0,"text":"\u0041\/\n","payload":"{\"ready\":true}","items":["[1,2]","{[}"]}`;
  for (const raw of [inner, JSON.stringify(inner)]) {
    const result = processStructuredJson(raw, defaultOptions, false);
    assert.deepEqual(result, processJson(raw, defaultOptions));
    assert.equal(result.success, true);
    assert.equal((result.output.match(/"id":/g) ?? []).length, 2);
    assert.ok(result.output.includes('"id": 9007199254740993'));
    assert.ok(result.output.includes('"id": 1.2300e+04'));
    assert.ok(result.output.includes('"negative": -0'));
    assert.ok(result.output.includes(String.raw`"text": "\u0041\/\n"`));
    assert.ok(
      result.output.includes(String.raw`"payload": "{\"ready\":true}"`),
    );
    assert.deepEqual(JSON.parse(result.output).items, ["[1,2]", "{[}"]);
    assert.equal(result.arrayDecoding, undefined);
    assert.deepEqual(result.stages, []);
  }
});

test("retains exact number literals, duplicate keys, and legal escapes", () => {
  const inner = String.raw`{"id":9007199254740993,"id":1.2300e+04,"negative":-0,"text":"\u0041\/\n\""}`;
  const ordinary = String.raw`"line\nnext"`;
  const raw = `[${JSON.stringify(inner)},${ordinary},9007199254740993,1e+09,-0]`;
  const result = processExtractedJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.match(result.output, /"id": 9007199254740993/);
  assert.match(result.output, /"id": 1\.2300e\+04/);
  assert.match(result.output, /"negative": -0/);
  assert.ok(result.output.includes(String.raw`"text": "\u0041\/\n\""`));
  assert.ok(result.output.includes(ordinary));
  assert.ok(result.output.includes("1e+09"));
  assert.equal((result.output.match(/9007199254740993/g) ?? []).length, 2);
});

test("uses each configured indentation without altering plain string tokens", () => {
  const raw = String.raw`["{\"a\":{\"b\":[1,2]}}","\u0041\/\n"]`;
  for (const indent of ["2", "4", "tab"] as const) {
    const result = processExtractedJson(raw, { ...defaultOptions, indent });
    const indentation = indent === "tab" ? "\t" : Number(indent);
    assert.equal(
      result.output,
      JSON.stringify([{ a: { b: [1, 2] } }, "A/\n"], null, indentation).replace(
        '"A/\\n"',
        String.raw`"\u0041\/\n"`,
      ),
    );
  }
});

test("repairs members independently with unique reversible diffs and paths", () => {
  const result = process([
    '{"a":True,}',
    "[1,2,]",
    { rows: ["{name:'Craft'}"] },
  ]);
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.output), [
    { a: true },
    [1, 2],
    { rows: [{ name: "Craft" }] },
  ]);
  assert.deepEqual(
    result.stages.map((stage) => stage.path),
    ["$[0]", "$[1]", "$[2].rows[0]"],
  );
  const ids = new Set<string>();
  for (const stage of result.stages) {
    assert.equal(repairedText(stage), stage.after);
    assert.ok(stage.layer >= 1);
    assert.equal(ids.has(stage.id), false);
    ids.add(stage.id);
    for (const change of stage.changes) {
      assert.equal(change.path, stage.path);
      assert.equal(change.layer, stage.layer);
      assert.equal(change.stageId, stage.id);
      assert.equal(ids.has(change.id), false);
      ids.add(change.id);
    }
  }
  assert.equal(
    result.changeCount,
    result.stages.reduce((sum, stage) => sum + stage.changes.length, 0),
  );
});

test("keeps failed candidates and ordinary text while processing healthy siblings", () => {
  const result = process(["{[}", '{"ready":true}', "plain text"]);
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.output), [
    "{[}",
    { ready: true },
    "plain text",
  ]);
  assert.equal(result.arrayDecoding?.decodedItems, 1);
  assert.equal(result.arrayDecoding?.failedItems, 1);
  assert.equal(result.arrayDecoding?.warnings[0].path, "$[0]");
  assert.match(result.arrayDecoding!.warnings[0].message, /无法修复/);
});

test("honors disabled repair without blocking healthy siblings", () => {
  const result = processExtractedJson(
    JSON.stringify(['{"a":true,}', '{"b":2}']),
    { ...defaultOptions, repair: false },
  );
  assert.deepEqual(JSON.parse(result.output), ['{"a":true,}', { b: 2 }]);
  assert.equal(result.arrayDecoding?.failedItems, 1);
  assert.equal(result.stages.length, 0);
});

test("combines outer repairs with member repairs without ID collisions", () => {
  const raw = `[${JSON.stringify('{"value":True}')},]`;
  const result = processExtractedJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.equal(result.stages[0].path, undefined);
  assert.equal(result.stages[0].layer, 0);
  assert.equal(result.stages[1].path, "$[0]");
  assert.equal(
    new Set(result.stages.map((stage) => stage.id)).size,
    result.stages.length,
  );
  assert.deepEqual(JSON.parse(result.output), [{ value: true }]);
});

test("bounds warnings and repair attempts while preserving all item positions", () => {
  const result = process(Array(150).fill("{[}"));
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.output), Array(150).fill("{[}"));
  assert.equal(result.arrayDecoding?.failedItems, 150);
  assert.equal(result.arrayDecoding?.warnings.length, 64);
  assert.equal(result.arrayDecoding?.warningsTruncated, true);
});

test("repairs common batches and bounds repair work for larger batches", () => {
  const common = process(Array(50).fill('{"ready":true,}'));
  assert.equal(common.arrayDecoding?.decodedItems, 50);
  assert.equal(common.arrayDecoding?.failedItems, 0);
  const large = process(Array(140).fill('{"ready":true,}'));
  assert.ok(large.arrayDecoding!.decodedItems <= 128);
  assert.ok(large.arrayDecoding!.decodedItems > 8);
  assert.ok(large.arrayDecoding!.failedItems >= 12);
  assert.ok(
    large.arrayDecoding!.warnings.every((warning) =>
      warning.message.includes("修复预算"),
    ),
  );
  assert.equal(JSON.parse(large.output).length, 140);
});

test("checks indentation expansion before allocating an oversized replacement", () => {
  const inner = "[" + "0,".repeat(50_000) + "0]";
  const raw =
    "[" +
    '{"nested":'.repeat(430) +
    "[" +
    JSON.stringify(inner) +
    "]" +
    "}".repeat(430) +
    "]";
  const result = processExtractedJson(raw, { ...defaultOptions, indent: "4" });
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.output), JSON.parse(raw));
  assert.equal(result.arrayDecoding?.decodedItems, 0);
  assert.equal(result.arrayDecoding?.failedItems, 1);
  assert.match(result.arrayDecoding!.warnings[0].message, /输出大小限制/);
  assert.ok(result.output.length < 2 * 1024 * 1024);
});

test("bounds the number of decoded candidates while retaining later literals", () => {
  const result = process(Array(100_002).fill("{}"));
  const output = JSON.parse(result.output);
  assert.equal(result.success, true);
  assert.equal(result.arrayDecoding?.decodedItems, 100_000);
  assert.equal(result.arrayDecoding?.failedItems, 2);
  assert.deepEqual(output[99_999], {});
  assert.equal(output[100_000], "{}");
  assert.equal(output[100_001], "{}");
  assert.ok(
    result.arrayDecoding!.warnings.every((warning) =>
      warning.message.includes("处理预算"),
    ),
  );
});

test("limits chained decoded arrays and retains the remaining encoded value", () => {
  let value = "{}";
  for (let index = 0; index < 9; index++) value = JSON.stringify([value]);
  const result = process([value]);
  assert.equal(result.success, true);
  assert.equal(result.arrayDecoding?.decodedItems, 8);
  assert.equal(result.arrayDecoding?.failedItems, 1);
  assert.match(result.arrayDecoding!.warnings[0].message, /超过 8 层/);
  assert.doesNotThrow(() => JSON.parse(result.output));
});

test("skips excessive structural nesting without throwing or changing values", () => {
  const raw =
    "[".repeat(520) + JSON.stringify('{"inside":1}') + "]".repeat(520);
  const result = processExtractedJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.output), JSON.parse(raw));
  assert.equal(result.arrayDecoding?.decodedItems, 0);
  assert.equal(result.arrayDecoding?.failedItems, 1);
  assert.match(result.arrayDecoding!.warnings[0].message, /嵌套过深/);
});

test("recurses through JSON object strings that introduce more objects and lists", () => {
  const input = {
    payload: JSON.stringify({
      nested: JSON.stringify({
        rows: [
          JSON.stringify({ value: JSON.stringify({ done: true }) }),
          "plain text",
        ],
      }),
    }),
    text: "ordinary text",
    numberText: "123",
    booleanText: "false",
    nullText: "null",
  };
  const result = process(input);
  assert.deepEqual(JSON.parse(result.output), {
    payload: { nested: { rows: [{ value: { done: true } }, "plain text"] } },
    text: "ordinary text",
    numberText: "123",
    booleanText: "false",
    nullText: "null",
  });
  assert.equal(result.arrayDecoding?.decodedItems, 4);
  assert.equal(result.arrayDecoding?.failedItems, 0);
  assert.equal(
    result.output,
    JSON.stringify(JSON.parse(result.output), null, 2),
  );
});

test("does not decode property names and retains escaped ordinary object values", () => {
  const jsonKey = '{"key":"value"}';
  const input = {
    [jsonKey]: JSON.stringify({ leaf: ['{"ready":true}'] }),
    text: "line\nnext",
    quoted: '"ordinary"',
  };
  const result = process(input);
  assert.deepEqual(JSON.parse(result.output), {
    [jsonKey]: { leaf: [{ ready: true }] },
    text: "line\nnext",
    quoted: '"ordinary"',
  });
  assert.equal(result.arrayDecoding?.decodedItems, 2);
  const raw = String.raw`{"text":"\u0041\/\n","payload":"{\"ready\":true}"}`;
  const preserved = processStructuredJson(raw, defaultOptions);
  assert.ok(preserved.output.includes(String.raw`"text": "\u0041\/\n"`));
  assert.match(preserved.output, /"payload": \{/);
});

test("reports object-property repairs and failures at their nested paths", () => {
  const result = process({
    payload: JSON.stringify({
      bad: '{"ready":True}',
      kept: "{[}",
      valid: '{"ok":1}',
    }),
  });
  assert.deepEqual(JSON.parse(result.output), {
    payload: { bad: { ready: true }, kept: "{[}", valid: { ok: 1 } },
  });
  assert.equal(result.arrayDecoding?.decodedItems, 3);
  assert.equal(result.arrayDecoding?.failedItems, 1);
  assert.equal(result.arrayDecoding?.warnings[0].path, "$.payload.kept");
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0].path, "$.payload.bad");
  assert.equal(result.stages[0].layer, 2);
  assert.equal(repairedText(result.stages[0]), result.stages[0].after);
  assert.ok(
    result.stages[0].changes.every((change) => change.path === "$.payload.bad"),
  );
});

test("keeps duplicate object properties and exact number literals while decoding their values", () => {
  const inner = String.raw`{"id":9007199254740993,"id":1.2300e+04,"negative":-0}`;
  const raw = `{"payload":${JSON.stringify(inner)},"payload":${JSON.stringify('{"second":true}')},"id":9007199254740993}`;
  const result = processStructuredJson(raw, defaultOptions);
  assert.equal((result.output.match(/"payload":/g) ?? []).length, 2);
  assert.equal((result.output.match(/9007199254740993/g) ?? []).length, 2);
  assert.ok(result.output.includes('"id": 1.2300e+04'));
  assert.ok(result.output.includes('"negative": -0'));
  assert.ok(result.output.includes('"second": true'));
  assert.equal(result.arrayDecoding?.decodedItems, 2);
});

test("disabling automatic unescaping also keeps nested object fields untouched", () => {
  const raw = JSON.stringify({
    payload: JSON.stringify({ inner: '{"ready":true}' }),
    items: ['{"nested":1}'],
  });
  const options = { ...defaultOptions, autoUnescape: false };
  assert.deepEqual(
    processStructuredJson(raw, options),
    processJson(raw, options),
  );
  assert.deepEqual(
    JSON.parse(processStructuredJson(raw, options).output),
    JSON.parse(raw),
  );
});

test("recognizes Unicode whitespace and escaped structural prefixes without decoding ordinary text", () => {
  const raw =
    '{"unicode":"\\u007B\\\"ready\\\":true}","spaced":' +
    JSON.stringify('\uFEFF\u00A0 {"nested":2}') +
    ',"plain":"ordinary text","number":"123","emoji":"😀 text"}';
  const result = processStructuredJson(raw, defaultOptions);
  assert.deepEqual(JSON.parse(result.output), {
    unicode: { ready: true },
    spaced: { nested: 2 },
    plain: "ordinary text",
    number: "123",
    emoji: "😀 text",
  });
  assert.equal(result.arrayDecoding?.decodedItems, 2);
});
