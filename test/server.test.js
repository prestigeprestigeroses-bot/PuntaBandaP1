const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  isValidClientRecordId,
  parseClientTimestamp,
  parseHistoricalTimestamp,
  parseWorker,
} = require("../server");

test("acepta identificadores UUID estables y rechaza valores manipulados", () => {
  assert.equal(isValidClientRecordId("f15987d9-50c8-42bf-9a5e-5b52c7f5cc67"), true);
  assert.equal(isValidClientRecordId("F15987D9-50C8-42BF-9A5E-5B52C7F5CC67"), true);
  assert.equal(isValidClientRecordId("registro-1"), false);
  assert.equal(isValidClientRecordId(""), false);
});

test("valida bonchadores y evita códigos fuera del rango operativo", () => {
  assert.deepEqual(parseWorker("b1-t25"), {
    code: "B01",
    tallos: 25,
    raw: "B1-T25",
  });
  assert.equal(parseWorker("B14-T25"), null);
  assert.equal(parseWorker("B01-T0"), null);
});

test("las fechas históricas inválidas no se normalizan silenciosamente", () => {
  assert.ok(parseHistoricalTimestamp("2026-10-30", "14:25:10") instanceof Date);
  assert.equal(parseHistoricalTimestamp("2026-02-30", "14:25:10"), null);
  assert.equal(parseHistoricalTimestamp("2026-10-30", "25:00:00"), null);
});

test("conserva la fecha original de un escaneo offline", () => {
  const capturedAt = "2026-10-29T23:58:12.000-05:00";
  assert.equal(parseClientTimestamp(capturedAt)?.toISOString(), "2026-10-30T04:58:12.000Z");
  assert.equal(parseClientTimestamp("fecha-invalida"), null);
  assert.ok(parseClientTimestamp("") instanceof Date);
});

test("el JavaScript incrustado del cliente conserva sintaxis válida", () => {
  const htmlPath = path.join(__dirname, "..", "public", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const start = html.indexOf("<script>");
  const end = html.lastIndexOf("</script>");
  assert.ok(start >= 0 && end > start, "No se encontró el script principal");
  assert.doesNotThrow(() => new Function(html.slice(start + 8, end)));
});

test("la cola offline impide sincronizaciones simultáneas", () => {
  const htmlPath = path.join(__dirname, "..", "public", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(html, /if \(offlineSyncPromise\) return offlineSyncPromise;/);
  assert.match(html, /offlineSyncPromise = performOfflineSync\(\)/);
});

test("los registros manuales múltiples reciben identificadores independientes", () => {
  const htmlPath = path.join(__dirname, "..", "public", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(html, /sendToServer\(\{ \.\.\.payload \}\)/);
});
