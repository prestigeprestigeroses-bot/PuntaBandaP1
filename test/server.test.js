const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildWorkerPerformance,
  formatMinutesAsHHMM,
  isValidClientRecordId,
  parseClientTimestamp,
  parseGrado,
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
  assert.deepEqual(parseWorker("B20-T25"), {
    code: "B20",
    tallos: 25,
    raw: "B20-T25",
  });
  assert.equal(parseWorker("B21-T25"), null);
  assert.equal(parseWorker("B01-T0"), null);
});

test("acepta BAJAS GRANEL como grado independiente", () => {
  const expected = { grado_cm: "BAJAS GRANEL", raw: "BAJAS GRANEL" };
  assert.deepEqual(parseGrado("BAJAS GRANEL"), expected);
  assert.deepEqual(parseGrado("BAJAS-GRANEL"), expected);
  assert.deepEqual(parseGrado("BAJAS_GRANEL"), expected);
  assert.deepEqual(parseGrado("BAJASGRANEL"), expected);
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

test("la captura principal usa código completo y no conserva el flujo manual por pasos", () => {
  const htmlPath = path.join(__dirname, "..", "public", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.doesNotMatch(html, /id="scanProgressBox"/);
  assert.doesNotMatch(html, /id="manualScan"/);
  assert.doesNotMatch(html, /function trySendCombo\(/);
  assert.doesNotMatch(html, /pendingWorker/);
  assert.doesNotMatch(html, /x6/i);
  assert.doesNotMatch(html, /ficha x6/i);
  assert.match(html, /INCOMPLETO: escanee la etiqueta completa/);
});

test("presenta los minutos calculados en formato HH:MM", () => {
  assert.equal(formatMinutesAsHHMM(450), "07:30");
  assert.equal(formatMinutesAsHHMM(960), "16:00");
});

test("calcula rendimiento desde el primer ramo hasta el último y descuenta comida por día", () => {
  const rows = [
    { work_date: "2026-11-20", worker: "B01", worker_name: "Pareja 1", ramos: 10, tallos: 250, raw_minutes: 480 },
    { work_date: "2026-11-21", worker: "B01", worker_name: "Pareja 1", ramos: 8, tallos: 200, raw_minutes: 420 },
    { work_date: "2026-11-20", worker: "B02", worker_name: "Pareja 2", ramos: 12, tallos: 300, raw_minutes: 330 },
  ];

  const result = buildWorkerPerformance(rows, 30);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    worker: "B01",
    workerName: "Pareja 1",
    activeDays: 2,
    ramos: 18,
    tallos: 450,
    recordedTotalMinutes: 900,
    lunchTotalMinutes: 60,
    effectiveTotalMinutes: 840,
    stemsPerHour: 450 / 14,
    over400: true,
  });
  assert.equal(result[1].effectiveTotalMinutes, 300);
  assert.equal(result[1].stemsPerHour, 60);
  assert.equal(result[1].over400, false);
});

test("no inventa rendimiento cuando solo existe un ramo registrado en el día", () => {
  const [result] = buildWorkerPerformance([
    { worker: "B03", worker_name: "Pareja 3", ramos: 1, tallos: 25, raw_minutes: 0 },
  ], 30);

  assert.equal(result.recordedTotalMinutes, 0);
  assert.equal(result.effectiveTotalMinutes, 0);
  assert.equal(result.stemsPerHour, null);
});

test("el formulario calcula las horas automáticamente entre dos fechas fijas", () => {
  const htmlPath = path.join(__dirname, "..", "public", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(html, /id="gradeReportDateFrom"/);
  assert.match(html, /id="gradeReportDateTo"/);
  assert.doesNotMatch(html, /id="gradeReportWorkedTime"/);
  assert.match(html, /\/api\/reports\/worker-performance/);
  assert.match(html, /primer ramo registrado hasta el último/i);
  assert.match(html, /Más de 400 tallos/);
});
