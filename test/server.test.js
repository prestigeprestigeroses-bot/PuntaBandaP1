const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildWorkerPerformance,
  calculateStemsPerHour,
  clockTimeToExcelValue,
  createSessionToken,
  formatLocalTimestampForDatabase,
  formatMinutesAsHHMM,
  isValidClientRecordId,
  minutesToExcelDuration,
  parseCookies,
  parseClientTimestamp,
  parseGrado,
  parseHistoricalTimestamp,
  parseWorker,
  verifySessionToken,
} = require("../server");

test("crea sesiones firmadas, rechaza alteraciones y respeta el vencimiento", () => {
  const createdAt = Date.UTC(2026, 10, 27, 8, 0, 0);
  const token = createSessionToken(createdAt);

  assert.equal(verifySessionToken(token, createdAt), true);
  assert.equal(verifySessionToken(`${token}alterado`, createdAt), false);
  assert.equal(verifySessionToken(token, createdAt + 23 * 60 * 60 * 1000), true);
  assert.equal(verifySessionToken(token, createdAt + 24 * 60 * 60 * 1000), false);
});

test("lee la sesión desde una cabecera de cookies sin exponer la contraseña", () => {
  assert.deepEqual(parseCookies("tema=oscuro; punta_banda_session=abc.def"), {
    tema: "oscuro",
    punta_banda_session: "abc.def",
  });

  const serverPath = path.join(__dirname, "..", "server.js");
  const source = fs.readFileSync(serverPath, "utf8");
  assert.match(source, /HttpOnly; SameSite=Lax/);
  assert.match(source, /APP_ACCESS_PASSWORD/);
  assert.match(source, /app\.post\("\/api\/auth\/logout"/);
});

test("muestra acceso por contraseña y botón para cerrar sesión", () => {
  const loginPath = path.join(__dirname, "..", "public", "login.html");
  const htmlPath = path.join(__dirname, "..", "public", "index.html");
  const login = fs.readFileSync(loginPath, "utf8");
  const html = fs.readFileSync(htmlPath, "utf8");

  assert.match(login, /type="password"/);
  assert.match(login, /\/api\/auth\/login/);
  assert.doesNotMatch(login, /type="text"[^>]*name="user/i);
  assert.match(html, /id="btnLogout"/);
  assert.match(html, /\/api\/auth\/logout/);
});

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

test("el ingreso histórico conserva literalmente la fecha y hora local seleccionadas", () => {
  const timestamp = parseHistoricalTimestamp("2026-11-25", "21:07:58");
  assert.equal(formatLocalTimestampForDatabase(timestamp), "2026-11-25 21:07:58.000");

  const serverPath = path.join(__dirname, "..", "server.js");
  const source = fs.readFileSync(serverPath, "utf8");
  assert.match(source, /\$1::timestamp without time zone/);
  assert.match(source, /AT TIME ZONE 'America\/Bogota'/);
  assert.doesNotMatch(source, /\$1::timestamptz \+ \(serie\.numero/);
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

test("la pantalla separa ramos confirmados de los pendientes offline", () => {
  const htmlPath = path.join(__dirname, "..", "public", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(html, /function getConfirmedFilteredScans\(\)/);
  assert.match(html, /function pendingCountsByWorker\(\)/);
  assert.match(html, /ramos confirmados en la base de datos/);
  assert.match(html, /pendientes de sincronizar/);
});

test("existe una auditoría agregada de registros activos y eliminados", () => {
  const serverPath = path.join(__dirname, "..", "server.js");
  const source = fs.readFileSync(serverPath, "utf8");
  assert.match(source, /app\.get\("\/api\/scans\/audit-summary"/);
  assert.match(source, /archivedDeletedCount/);
  assert.match(source, /totalRecordedIncludingDeleted/);
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

test("guarda horas y duraciones como valores numéricos reconocidos por Excel", () => {
  assert.equal(minutesToExcelDuration(450), 7.5 / 24);
  assert.equal(minutesToExcelDuration(26 * 60), 26 / 24);
  assert.equal(clockTimeToExcelValue("07:30:00"), 7.5 / 24);
  assert.equal(clockTimeToExcelValue("25:00:00"), null);
});

test("el Excel muestra el primer y último ramo en formato de 12 horas", () => {
  const serverPath = path.join(__dirname, "..", "server.js");
  const source = fs.readFileSync(serverPath, "utf8");
  assert.match(source, /Primer ramo \(formato 12 horas\)/);
  assert.match(source, /Último ramo \(formato 12 horas\)/);
  assert.match(source, /getCell\(4\)\.numFmt = "h:mm AM\/PM"/);
  assert.match(source, /getCell\(5\)\.numFmt = "h:mm AM\/PM"/);
});

test("el informe conserva la misma hora local que muestra el sistema", () => {
  const serverPath = path.join(__dirname, "..", "server.js");
  const source = fs.readFileSync(serverPath, "utf8");
  assert.match(source, /pg_typeof\(s\.ts\)::text = 'timestamp without time zone'/);
  assert.match(source, /THEN s\.ts::timestamp without time zone/);
  assert.doesNotMatch(source, /s\.ts AT TIME ZONE 'UTC'/);
  assert.match(source, /s\.ts AT TIME ZONE 'America\/Bogota'/);
});

test("el promedio general pondera los tallos por las horas efectivas totales", () => {
  const totalMinutes = 396 * 60 + 14;
  const result = calculateStemsPerHour(159146, totalMinutes);
  assert.ok(Math.abs(result - 401.65) < 0.01);
  assert.equal(calculateStemsPerHour(100, 0), null);
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
