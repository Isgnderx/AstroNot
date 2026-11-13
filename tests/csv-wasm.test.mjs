// Run with:  node --test tests/csv-wasm.test.mjs
//
// Parity of the Rust/WebAssembly CSV kernel (rust/crates/csv, tools/csv-kernel.js) with the JavaScript readers it can
// replace: parseCsv (tools/observation-csv.js, used by the cross-match), parseDelimited of tools/spectrum-csv.js and of
// tools/timeseries.js, and the number parsers of tools/xmatch.js, spectrum-csv.js and timeseries.js.
// All inputs are synthetic (hand-written edge cases and seeded random text). No archive data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const Wasm = require("../tools/wasm.js");
const Csv = require("../tools/csv-kernel.js");
const X = require("../tools/xmatch.js");
const S = require("../tools/spectrum-csv.js");
const T = require("../tools/timeseries.js");

const vmParse = vm.runInContext(readFileSync(join(root, "tools/observation-csv.js"), "utf8") + "\n({ parseCsv });", vm.createContext({})).parseCsv;
const parseCsv = (text) => Array.from(vmParse(text), (row) => Array.from(row));

const kernel = await Wasm.load("csv");
assert.ok(kernel, "tools/wasm/csv.wasm is missing: run node scripts/build-wasm.mjs csv");
Csv.use(kernel);

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const pick = (random, list) => list[Math.floor(random() * list.length)];

function rowsOf(table) {
  const rows = [];
  for (let i = 0; i < table.rowCount; i++) rows.push(table.row(i));
  return rows;
}

const pieces = [
  "a", "b", "0", "1", "12", "3.5", "-2", "1e5", " ", "  ", "\t", " ", ",", ",", ",", ",", ";", "\n", "\n", "\r\n", "\r", '"', '"', '""', '"x"', '"a,b"', '"a\nb"',
  "#", "#c", "é", "−", " ", " ", "﻿", "nan", "NA", "--", "-", "?", "null", "1,5", "x", "a b", "'", "=", "\\",
];
function fuzzText(random, count) {
  let text = "";
  for (let i = 0; i < count; i++) text += pick(random, pieces);
  return text;
}

// ---- Tokenizing ---------------------------------------------------------------------------------------------------------
const handCases = [
  "a,b,c\n1,2,3\n",
  "a,b,c\r\n1,2,3\r\n4,5,6",
  "a,b,c\r1,2,3\r4,5,6\r",
  '﻿a,b\n"x, y",3\n\n"say ""hi""","line\nbreak"\n',
  'a,b\n"unclosed,1\n',
  'a,b\n1,"',
  'a,b\n"""",2\n"" ,3\n""x"y"",4\n',
  "a,b\n\n   \n\t\n,\n ,\n1,2\n",
  "a,b\n1,2,\n,\n,,\n",
  "a\n1\n2\n",
  "",
  "\n\n\n",
  "x",
  "a,b\n1,2\n \n3,4\n ﻿\n",
  '"a","b"\n"1","2"\n',
  'a,b\n"  ",\n',
  'a,b\n"" ,"",\n""\n',
  'a,b\n1,2\n"a"b",3\n"a" "b",4\n',
];

test("record boundaries and cells equal parseCsv (observation-csv.js) on hand cases and 4000 random texts", () => {
  const random = lcg(12345);
  const inputs = handCases.slice();
  for (let i = 0; i < 4000; i++) inputs.push(fuzzText(random, 1 + Math.floor(random() * 60)));
  for (const raw of inputs) {
    const text = raw;
    let expected;
    let thrown = null;
    try { expected = parseCsv(text); } catch (error) { thrown = error; }
    const table = Csv.open(text, { delimiter: ",", skipBom: true }); // parseCsv drops one leading BOM itself
    try {
      if (thrown) {
        assert.equal(table.status, 1, JSON.stringify(text));
        assert.match(thrown.message, /quoted field/);
      } else {
        assert.equal(table.status, 0, JSON.stringify(text));
        assert.deepEqual(rowsOf(table), expected, JSON.stringify(text));
        assert.deepEqual(Array.from(table.fieldCounts), expected.map((cells) => cells.length));
      }
    } finally { table.dispose(); }
  }
});

test("timeseries parseDelimited with a tab, semicolon and comma delimiter equals the kernel", () => {
  const random = lcg(777);
  for (const delimiter of [",", "\t", ";", "|"]) {
    for (let i = 0; i < 1500; i++) {
      const text = fuzzText(random, 1 + Math.floor(random() * 50)).replace(/,/g, () => (random() < 0.5 ? delimiter : ","));
      let expected;
      let thrown = null;
      try { expected = T.parseDelimited(text, delimiter); } catch (error) { thrown = error; }
      const table = Csv.open(text, { delimiter, skipBom: false });
      try {
        if (thrown) assert.equal(table.status, 1, JSON.stringify(text));
        else assert.deepEqual(rowsOf(table), expected, JSON.stringify(text));
      } finally { table.dispose(); }
    }
  }
});

test("spectrum parseDelimited: records, start line numbers, comments, unclosed quote line and the row limit equal the kernel", () => {
  const random = lcg(4242);
  const inputs = handCases.map((text) => text.replace(/^﻿/, ""));
  inputs.push("# a comment\n#another\na,b\n1,2\n# in the middle\n3,4\n  # not a comment\n5,6", "#only comment", "a,b\n\n\n1,2\n\"x\n\ny\",3\n4,5\r\n6,7\r8,9\n#c\r\n10,11");
  for (let i = 0; i < 4000; i++) inputs.push(fuzzText(random, 1 + Math.floor(random() * 60)));
  for (const text of inputs) {
    for (const delimiter of [",", ";"]) {
      const source = delimiter === "," ? text : text.replace(/,/g, ";");
      let expected;
      let thrown = null;
      try { expected = S.parseDelimited(source, delimiter); } catch (error) { thrown = error; }
      const table = Csv.open(source, { delimiter, comments: true, trackLines: true, skipBom: false });
      try {
        if (thrown) {
          assert.equal(table.status, 1, JSON.stringify(source));
          assert.equal(thrown.code, "bad-csv");
          assert.equal(thrown.message, "The file ends inside a quoted field that starts on line " + table.errorLine + ". Check the quotation marks.", JSON.stringify(source));
        } else {
          assert.equal(table.status, 0, JSON.stringify(source));
          assert.deepEqual(rowsOf(table), expected.records.map((record) => record.cells), JSON.stringify(source));
          assert.deepEqual(Array.from(table.lines), expected.records.map((record) => record.line), JSON.stringify(source));
          assert.equal(table.comments, expected.comments, JSON.stringify(source));
        }
      } finally { table.dispose(); }
    }
  }
  // Row limit: stops as soon as more than maxRecords records exist.
  const many = "h1,h2\n" + "1,2\n".repeat(50);
  const limited = Csv.open(many, { delimiter: ",", maxRecords: 11 });
  assert.equal(limited.status, 2);
  limited.dispose();
  const exact = Csv.open(many, { delimiter: ",", maxRecords: 51 });
  assert.equal(exact.status, 0);
  assert.equal(exact.rowCount, 51);
  exact.dispose();
});

test("a UTF-8 byte order mark is skipped and bytes from a Buffer give the same table as the string", () => {
  const text = "a,b\n1,é\n";
  const bytes = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text)]);
  const table = Csv.open(new Uint8Array(bytes));
  assert.deepEqual(rowsOf(table), [["a", "b"], ["1", "é"]]);
  table.dispose();
});

// ---- Numbers --------------------------------------------------------------------------------------------------------------
const numberWords = [
  "0", "-0", "+0", "1", "-1", "12.5", ".5", "5.", "-.5e3", "1e5", "1E5", "1e+5", "1e-5", "1e", "e5", ".", "+", "-", "--", "", " ", "  3  ", " 7 ",
  "nan", "NaN", "NAN", "null", "None", "NA", "n/a", "N/A", "nil", "masked", "?", "inf", "-Infinity", "+INF", "Infinity", "1,5", "1,5e3", "-1,5", ",5", "1,", "1,5,6", "1.5,5",
  "0x10", "1_0", "1d3", "1D-3", "1d", "−5", "1e−5", "−", "+−5", "12345678901234567890", "123456789012345678", "0.1", "0.30000000000000004", "9007199254740993", "9007199254740992",
  "1e22", "1e23", "1e-22", "1e-23", "4.9e-324", "2.5e-324", "1.7976931348623157e308", "1.7976931348623159e308", "1e309", "-1e999", "1e-999", "00012", "0.000000000000000000000000001234",
  "3.141592653589793238462643383279", "123456.789e-3", "5e0", "  1.5 ﻿", "1 5", "1..5", "+-1", "1e5e5", "Ee", "٣",
];
function randomNumberText(random) {
  const digits = (n) => Array.from({ length: n }, () => Math.floor(random() * 10)).join("");
  const sign = pick(random, ["", "", "-", "+"]);
  const intPart = random() < 0.1 ? "" : digits(1 + Math.floor(random() * 20));
  const frac = random() < 0.4 ? "" : "." + digits(Math.floor(random() * 22));
  const exp = random() < 0.4 ? "" : pick(random, ["e", "E"]) + pick(random, ["", "+", "-"]) + digits(1 + Math.floor(random() * 3));
  return sign + intPart + frac + exp;
}

function mapXmatch(status, value, text) {
  const parsed = X.parseAngle(text, "ra");
  // Compare through parseDecimal / isMissing, the two primitives parseAngle uses.
  const raw = text.trim();
  if (X.isMissing(raw)) return ["missing", null];
  const decimal = X.parseDecimal(raw);
  return Number.isFinite(decimal) ? ["ok", decimal] : ["invalid", null];
}
const kernelXmatch = (status, value) => {
  if (status === Csv.status.empty || status === Csv.status.missing || status === Csv.status.nan) return ["missing", null];
  return status === Csv.status.ok ? ["ok", value] : ["invalid", null];
};

const same = (a, b) => Object.is(a, b);

test("xmatch number syntax (isMissing + parseDecimal): same classification and bitwise equal values on 40000 texts", () => {
  const random = lcg(99);
  const texts = numberWords.slice();
  for (let i = 0; i < 40000; i++) texts.push(randomNumberText(random));
  for (const text of texts) {
    const parsed = Csv.parseNumber(text, "xmatch");
    const [kind, value] = kernelXmatch(parsed.status, parsed.value);
    const [expectedKind, expectedValue] = mapXmatch(parsed.status, parsed.value, text);
    assert.equal(kind, expectedKind, JSON.stringify(text));
    if (kind === "ok") assert.ok(same(value, expectedValue), JSON.stringify(text) + " " + value + " vs " + expectedValue);
  }
});

test("spectrum number syntax (parseNumber, with and without decimal comma): same result kind and bitwise equal values", () => {
  const random = lcg(2024);
  const texts = numberWords.slice();
  for (let i = 0; i < 40000; i++) texts.push(randomNumberText(random));
  for (const [profile, comma] of [["spectrum", false], ["spectrumComma", true]]) {
    for (const text of texts) {
      const expected = S.parseNumber(text, comma);
      const got = Csv.parseNumber(text, profile);
      const label = JSON.stringify(text) + " " + profile;
      if (expected.value !== undefined) {
        assert.equal(got.status, Csv.status.ok, label);
        assert.ok(same(got.value, expected.value), label + " " + got.value + " vs " + expected.value);
      } else if (expected.missing) {
        assert.equal(got.status, expected.nan ? Csv.status.nan : text.trim() === "" ? Csv.status.empty : Csv.status.missing, label);
      } else if (expected.reason === "is infinite") {
        assert.equal(got.status, Csv.status.inf, label);
      } else if (expected.reason === "is too large to read") {
        assert.equal(got.status, Csv.status.overflow, label);
      } else {
        assert.equal(got.status, Csv.status.invalid, label);
      }
    }
  }
});

test("timeseries number syntax (parseNumber with D exponents): same state and bitwise equal values", () => {
  const random = lcg(31337);
  const texts = numberWords.slice();
  for (let i = 0; i < 40000; i++) texts.push(randomNumberText(random));
  for (const text of texts) {
    const expected = T.parseNumber(text);
    const got = Csv.parseNumber(text, "timeseries");
    const label = JSON.stringify(text);
    if (expected.state === "ok") {
      assert.equal(got.status, Csv.status.ok, label);
      assert.ok(same(got.value, expected.value), label + " " + got.value + " vs " + expected.value);
    } else if (expected.state === "empty") assert.equal(got.status, Csv.status.empty, label);
    else if (expected.state === "missing") assert.ok(got.status === Csv.status.missing || got.status === Csv.status.nan, label);
    else assert.ok(got.status === Csv.status.invalid || got.status === Csv.status.overflow, label);
  }
});

test("numeric() parses chosen columns of a whole table in one pass, with absent columns and quoting", () => {
  const text = 'id,ra,dec,flag\r\n1,10.5,"-20.25",x\r\n2,,"1e2"\r\n"3","  7  ",nan,y\r\n4,"1,5",3,z\n5,abc,3.5,w,extra\n';
  const table = Csv.open(text, { delimiter: "," });
  const [ra, dec, flag] = table.numeric([{ col: 1, profile: "xmatch" }, { col: 2, profile: "xmatch" }, { col: 3, profile: "xmatch" }]);
  assert.equal(table.rowCount, 6);
  assert.deepEqual(Array.from(ra.status), [Csv.status.invalid, 0, Csv.status.empty, 0, Csv.status.invalid, Csv.status.invalid]);
  assert.deepEqual([ra.values[1], ra.values[3], dec.values[1], dec.values[2]], [10.5, 7, -20.25, 100]);
  assert.equal(dec.status[3], Csv.status.nan); // "nan" is a missing word for xmatch
  assert.equal(dec.status[4], Csv.status.ok);
  assert.equal(flag.status[2], Csv.status.absent); // the row "2,,"1e2"" has only three fields
  assert.equal(table.cell(1, 2), "-20.25");
  assert.equal(table.cell(2, 3), null);
  assert.equal(table.cell(5, 4), "extra");
  table.dispose();
});

test("id statistics, shapes and first non-space", () => {
  const table = Csv.open("id,x\nA,1\nB,2\nA,3\n,4\n  ,5\nC\n 1234 ,6\n1234,7\n", { delimiter: "," });
  const stats = table.idStats(0);
  assert.deepEqual(stats, { duplicate: 4, empty: 2 });
  assert.equal(table.anyShape(0, "####"), true);
  assert.equal(table.anyShape(0, "#####"), false);
  assert.equal(table.anyShape(0, "A"), true);
  table.dispose();
  const allwise = Csv.open("designation,x\nJ102422.40-413840.8,1\n", { delimiter: "," });
  assert.equal(allwise.anyShape(0, "J######.##S######.#"), true);
  allwise.dispose();
  assert.equal(Csv.firstNonSpace(new TextEncoder().encode("   \n x"), 0), 8);
  assert.equal(Csv.firstNonSpace(new TextEncoder().encode(" \n\t "), 0), 4);
});

test("large generated file: 200000 rows tokenize and parse like the JavaScript reader", () => {
  const random = lcg(5);
  const lines = ["source_id,ra,dec,label"];
  for (let i = 0; i < 200000; i++) {
    const label = random() < 0.01 ? '"has, comma ""q"""' : random() < 0.01 ? "" : "n" + i;
    lines.push([String(1000000000000000000n + BigInt(i)), (random() * 360).toFixed(8), (random() * 180 - 90).toFixed(8), label].join(","));
  }
  const text = lines.join(random() < 2 ? "\r\n" : "\n") + "\r\n";
  const expected = parseCsv(text);
  const table = Csv.open(text, { delimiter: "," });
  assert.equal(table.rowCount, expected.length);
  const [ra, dec] = table.numeric([{ col: 1, profile: "xmatch" }, { col: 2, profile: "xmatch" }]);
  for (let i = 1; i < expected.length; i += 7) {
    assert.deepEqual(table.row(i), expected[i]);
    assert.ok(same(ra.values[i], Number(expected[i][1])) && same(dec.values[i], Number(expected[i][2])));
  }
  assert.equal(table.cell(5, 0), expected[5][0]); // 19 digits stay text
  table.dispose();
});
