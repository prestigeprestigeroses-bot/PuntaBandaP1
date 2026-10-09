// server.js
// -------------------------------------------------------------
// Backend para Empaque — Rendimiento por bonchador (PRESTIGE P2)
// Formatos de escaneo:
//   • Bonchador + tallos: B16-T20
//   • Variedad + grado : V01-60
//   • Lámina           : L1, L2, L3 ...
//
// Guarda en DB:
//   worker, worker_name, tallos, variedad_id, grado_cm, lamina_id, lamina_nombre
//
// Requisito en DB:
//   ALTER TABLE public.scans
//   ADD COLUMN IF NOT EXISTS lamina_id character varying(20);
//   ADD COLUMN IF NOT EXISTS worker_name character varying(120);
//   ADD COLUMN IF NOT EXISTS lamina_nombre character varying(120);
//
// Incluye SSE para actualizaciones en tiempo real.
// -------------------------------------------------------------

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");
const ExcelJS = require("exceljs");

// FORZAR ZONA HORARIA COLOMBIA
process.env.TZ = "America/Bogota";

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// Conexión a Postgres
// -----------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// -----------------------------
// Configuración y estado
// -----------------------------
const WORKER_MIN = 1;
const WORKER_MAX = 13;
const REPORT_PASSWORD = process.env.REPORT_PASSWORD || "P1-INFORME-2026";
const GRADE_ESTIMATE_PERCENTAGES = [
  { grado: 40, porcentaje: 10 },
  { grado: 50, porcentaje: 25 },
  { grado: 60, porcentaje: 48 },
  { grado: 70, porcentaje: 10 },
  { grado: 80, porcentaje: 4 },
  { grado: 90, porcentaje: 3 },
];

// Caché de nombres persistidos en PostgreSQL (p.ej. { B01: "Juan" })
let workerNameMap = {};
let scansNameColumnsReady = false;
let workerNamesTableReady = false;

// Conjunto de clientes SSE conectados
const clients = new Set();

// Servir estáticos
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ==========================================================
   RUTAS DE API
   ========================================================== */

function buildWorkersList() {
  return Array.from({ length: WORKER_MAX - WORKER_MIN + 1 }, (_, index) => {
    const workerNumber = WORKER_MIN + index;
    const code = `B${String(workerNumber).padStart(2, "0")}`;
    return { code, name: workerNameMap[code] || code };
  });
}

// Lista de bonchadores con nombres persistidos
app.get("/api/workers", async (req, res) => {
  try {
    await loadWorkerNames();
    res.json(buildWorkersList());
  } catch (err) {
    console.error("GET /api/workers error:", err);
    res.status(500).json({ error: "Error cargando bonchadores" });
  }
});

// Guardar/actualizar nombre de bonchador de forma persistente
app.post("/api/workers", async (req, res) => {
  try {
    const { code, name } = req.body || {};
    const workerCode = String(code || "").trim().toUpperCase();

    if (!/^B(?:0[1-9]|1[0-3])$/.test(workerCode)) {
      return res.status(400).json({ error: "Código de bonchador inválido" });
    }

    const workerName = String(name || "").trim() || workerCode;
    await ensureWorkerNamesTable();
    await pool.query(
      `
      INSERT INTO public.worker_names (code, name, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (code)
      DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
      `,
      [workerCode, workerName]
    );
    workerNameMap[workerCode] = workerName;

    await updateTodayWorkerName(workerCode, workerName);
    broadcast({ kind: "workers", workers: buildWorkersList() });

    res.json({ ok: true, code: workerCode, name: workerName });
  } catch (err) {
    console.error("POST /api/workers error:", err);
    res.status(500).json({ error: "Error guardando bonchador" });
  }
});

// Traer escaneos recientes (con nombre de variedad por JOIN y nombre de lámina por JOIN)
app.get("/api/scans", async (req, res) => {
  try {
    await ensureScansNameColumns();

    const limit = parseInt(req.query.limit, 10) || 200;
    const day = String(req.query.day || "").trim().toLowerCase();
    const date = String(req.query.date || "").trim();
    const params = [];
    let whereSql = "";

    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [year, month, dayNum] = date.split("-").map(Number);
      const start = new Date(year, month - 1, dayNum, 0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      params.push(start, end);
      whereSql = `WHERE s.ts >= $1 AND s.ts < $2`;
    } else if (day === "today") {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      params.push(start, end);
      whereSql = `WHERE s.ts >= $1 AND s.ts < $2`;
    }

    params.push(limit);
    const limitParam = params.length;

    const query = `
      SELECT 
        s.id,
        s.ts, 
        s.worker, 
        COALESCE(s.worker_name, s.worker) AS worker_name,
        s.tallos, 
        s.variedad_id, 
        s.grado_cm,
        s.lamina_id,
        s.raw_a,
        s.raw_b,
        COALESCE(NULLIF(s.variedad_nombre, ''), v.nombre, s.variedad_id) AS variedad_nombre,
        COALESCE(s.lamina_nombre, l.nombre, s.lamina_id) AS lamina_nombre,
        s.finca
      FROM scans s
      LEFT JOIN variedades v ON s.variedad_id = v.id
      LEFT JOIN lamina l ON s.lamina_id = l.id
      ${whereSql}
      ORDER BY s.ts DESC 
      LIMIT $${limitParam}
    `;

    const result = await pool.query(query, params);

    const finalData = result.rows.map((row) => ({
      ...row,
      worker_name: row.worker_name || (row.worker ? (workerNameMap[row.worker] || row.worker) : null),
    }));

    res.json(finalData);
  } catch (err) {
    console.error("GET /api/scans error:", err);
    res.status(500).json({ error: "Error en DB" });
  }
});

// Pendientes (si aún no llevas estado de pendientes, devolvemos vacío)
app.get("/api/pendingAll", (req, res) => {
  res.json({});
});

/* ==========================================================
   LÓGICA DE PARSEOS
   ========================================================== */

// Bonchador: B16-T20
function parseWorker(code) {
  const up = String(code || "").trim().toUpperCase();
  const m = up.match(/^B(\d{1,2})-T(\d{1,3})$/);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  const tallos = parseInt(m[2], 10);

  if (!(n >= WORKER_MIN && n <= WORKER_MAX)) return null;
  if (!Number.isFinite(tallos) || tallos <= 0) return null;

  return {
    code: `B${String(n).padStart(2, "0")}`, // B01, B02... B13
    tallos,
    raw: up,
  };
}

// Producto: V01-60
// Variedad: V01, V02, V12...
function parseVariedad(code) {
  const up = String(code || "").trim().toUpperCase();
  const m = up.match(/^V(\d{1,2})$/);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  return {
    variedad_id: `V${String(n).padStart(2, "0")}`,
    raw: up,
  };
}

// Grado: G40, G50, G60...
function parseGrado(code) {
  const original = String(code || "").trim().toUpperCase();
  const up = original.replace(/_/g, " ").replace(/\s+/g, " ");
  const gradoTexto = up === "NACIONAL-GRANEL" || up === "NACIONALGRANEL"
    ? "NACIONAL GRANEL"
    : up;

  // Grados numéricos: G60 o 60
  const mNum = gradoTexto.match(/^G?(\d{1,3})$/);
  if (mNum) {
    const grado_cm = parseInt(mNum[1], 10);

    if (!Number.isFinite(grado_cm) || grado_cm <= 0) return null;

    return {
      grado_cm: String(grado_cm),
      raw: `G${grado_cm}`,
    };
  }

  // Grados de texto permitidos
  const textosPermitidos = ["NACIONAL", "NACIONAL GRANEL", "ELITE", "BAJAS"];

  if (textosPermitidos.includes(gradoTexto)) {
    return {
      grado_cm: gradoTexto,
      raw: gradoTexto,
    };
  }

  return null;
}

// Lámina: L1, L2, L3...
function parseLamina(code) {
  const up = String(code || "").trim().toUpperCase();
  if (up === "PVC") {
    return {
      id: "PVC",
      raw: "PVC",
    };
  }
  const m = up.match(/^L(\d{1,3})$/);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  return {
    id: `L${n}`,
    raw: up,
  };
}

/* ==========================================================
   VALIDACIONES DE CATÁLOGOS
   ========================================================== */

async function getVariedadById(variedadId) {
  const result = await pool.query(
    `
    SELECT id, nombre
    FROM variedades
    WHERE id = $1
    LIMIT 1
    `,
    [variedadId]
  );

  return result.rows[0] || null;
}

async function getLaminaActiva(laminaId) {
  const id = String(laminaId || "").toUpperCase();
  if (id === "L9") {
    return {
      id: "L9",
      nombre: "Lámina Amarilla",
      activo: true
    };
  }
  const esLaminaTexto = id === "PVC";
  let result;
  try {
    result = await pool.query(
      esLaminaTexto
        ? `
          SELECT id, nombre, activo
          FROM lamina
          WHERE UPPER(id) = $1
             OR UPPER(nombre) LIKE $2
          ORDER BY CASE WHEN UPPER(id) = $1 THEN 0 ELSE 1 END
          LIMIT 1
        `
        : `
          SELECT id, nombre, activo
          FROM lamina
          WHERE UPPER(id) = $1
          LIMIT 1
        `,
      esLaminaTexto ? [id, "%PVC%"] : [id]
    );
  } catch (err) {
    if (id === "L9") {
      return {
        id: "L9",
        nombre: "Lámina Amarilla",
        activo: true
      };
    }
    throw err;
  }

  if (!result.rows[0] && id === "L9") {
    return {
      id: "L9",
      nombre: "Lámina Amarilla",
      activo: true
    };
  }
  if (!result.rows[0]) return null;
  if (!result.rows[0].activo) return { ...result.rows[0], invalida: true };

  if (id === "L9" && (!result.rows[0].nombre || String(result.rows[0].nombre).trim().toUpperCase() === "L9")) {
    return { ...result.rows[0], nombre: "Lámina Amarilla" };
  }

  return result.rows[0];
}

app.get("/api/variedades", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, nombre
      FROM variedades
      ORDER BY id
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/variedades error:", err);
    res.status(500).json({ error: "Error cargando variedades" });
  }
});

app.get("/api/variedades/:id", async (req, res) => {
  try {
    const vObj = parseVariedad(req.params.id);
    if (!vObj) {
      return res.status(400).json({ error: "Variedad inválida" });
    }

    const variedad = await getVariedadById(vObj.variedad_id);
    if (!variedad) {
      return res.status(404).json({ error: "Variedad no encontrada" });
    }

    res.json(variedad);
  } catch (err) {
    console.error("GET /api/variedades/:id error:", err);
    res.status(500).json({ error: "Error en DB" });
  }
});

app.get("/api/laminas/:id", async (req, res) => {
  try {
    const lObj = parseLamina(req.params.id);
    if (!lObj) {
      return res.status(400).json({ error: "Lámina inválida" });
    }

    const lamina = await getLaminaActiva(lObj.id);
    if (!lamina) {
      return res.status(404).json({ error: "Lámina no encontrada" });
    }

    if (lamina.invalida) {
      return res.status(400).json({ error: "Lámina inactiva" });
    }

    res.json({
      id: lamina.id,
      nombre: lamina.nombre,
      activo: lamina.activo
    });
  } catch (err) {
    console.error("GET /api/laminas/:id error:", err);
    res.status(500).json({ error: "Error en DB" });
  }
});

/* ==========================================================
   GUARDADO EN DB
   ========================================================== */

async function ensureScansNameColumns() {
  if (scansNameColumnsReady) return;

  await pool.query(`
    ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS worker_name character varying(120),
    ADD COLUMN IF NOT EXISTS lamina_nombre character varying(120),
    ADD COLUMN IF NOT EXISTS finca character varying(10),
    ALTER COLUMN variedad_id DROP NOT NULL,
    ALTER COLUMN variedad_nombre DROP NOT NULL
  `);

  await pool.query(`
    UPDATE public.scans
    SET worker_name = worker
    WHERE (worker_name IS NULL OR worker_name = '')
      AND worker IS NOT NULL
  `);

  await pool.query(`
    UPDATE public.scans s
    SET lamina_nombre = COALESCE(l.nombre, s.lamina_id)
    FROM public.lamina l
    WHERE UPPER(l.id) = UPPER(s.lamina_id)
      AND (s.lamina_nombre IS NULL OR s.lamina_nombre = '')
  `);

  await pool.query(`
    UPDATE public.scans
    SET lamina_nombre = lamina_id
    WHERE (lamina_nombre IS NULL OR lamina_nombre = '')
      AND lamina_id IS NOT NULL
  `);

  scansNameColumnsReady = true;
}

async function ensureWorkerNamesTable() {
  if (workerNamesTableReady) return;

  await ensureScansNameColumns();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.worker_names (
      code character varying(10) PRIMARY KEY,
      name character varying(120) NOT NULL,
      updated_at timestamp with time zone NOT NULL DEFAULT NOW()
    )
  `);

  // Conserva los nombres que ya estaban escritos en registros anteriores.
  await pool.query(`
    INSERT INTO public.worker_names (code, name)
    SELECT DISTINCT ON (UPPER(worker))
      UPPER(worker),
      TRIM(worker_name)
    FROM public.scans
    WHERE worker IS NOT NULL
      AND worker_name IS NOT NULL
      AND TRIM(worker_name) <> ''
      AND UPPER(TRIM(worker_name)) <> UPPER(TRIM(worker))
    ORDER BY UPPER(worker), ts DESC
    ON CONFLICT (code) DO NOTHING
  `);

  workerNamesTableReady = true;
}

async function loadWorkerNames() {
  await ensureWorkerNamesTable();
  const result = await pool.query(`
    SELECT code, name
    FROM public.worker_names
    ORDER BY code
  `);

  const persistedNames = {};
  for (const row of result.rows) {
    const code = String(row.code || "").trim().toUpperCase();
    const name = String(row.name || "").trim();
    if (code) persistedNames[code] = name || code;
  }
  workerNameMap = persistedNames;
  return workerNameMap;
}

async function getPersistedWorkerName(workerCode) {
  const code = String(workerCode || "").trim().toUpperCase();
  await ensureWorkerNamesTable();
  const result = await pool.query(
    `SELECT name FROM public.worker_names WHERE code = $1 LIMIT 1`,
    [code]
  );
  const name = String(result.rows[0]?.name || "").trim() || code;
  workerNameMap[code] = name;
  return name;
}

async function updateTodayWorkerName(workerCode, workerName) {
  await ensureScansNameColumns();

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  await pool.query(
    `
    UPDATE public.scans
    SET worker_name = $2
    WHERE UPPER(worker) = $1
      AND ts >= $3
      AND ts < $4
    `,
    [String(workerCode || "").toUpperCase(), workerName || workerCode, start, end]
  );
}

async function saveScan(wObj, vObj, gObj, lObj, variedadNombre, workerName, laminaNombre, finca = null) {
  await ensureScansNameColumns();

  const client = await pool.connect();

  try {
    const localTimestamp = new Date();

    const query = `
      INSERT INTO scans (
        ts,
        worker,
        worker_name,
        tallos,
        variedad_id,
        variedad_nombre,
        grado_cm,
        raw_a,
        raw_b,
        lamina_id,
        lamina_nombre,
        finca
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;

    const values = [
      localTimestamp,
      wObj.code,           // B01
      workerName,
      wObj.tallos,         // 20
      vObj?.variedad_id || null, // V01 o vacía para QR sin variedad
      variedadNombre,
      gObj.grado_cm,       // 60
      wObj.raw,            // B01-T20
      vObj ? `${vObj.raw}-${gObj.raw}` : gObj.raw,
      lObj.id,             // L1
      laminaNombre,
      finca
    ];

    const result = await client.query(query, values);
    return result.rows[0];

  } finally {
    client.release();
  }
}

/* ==========================================================
   ESCANEO PRINCIPAL
   Espera:
   {
     "worker": "B16-T20",
     "barcode": "V01-60",
     "lamina": "L1"
   }
   ========================================================== */

app.post("/api/scan", async (req, res) => {
  try {
    const { worker, variedad, grado, lamina, finca, qrSinVariedad } = req.body || {};

    const wObj = parseWorker(worker);
    const vObj = parseVariedad(variedad);
    const gObj = parseGrado(grado);
    const lObj = parseLamina(lamina);
    const variedadIngresada = String(variedad || "").trim();
    const permiteVariedadVacia = qrSinVariedad === true && !variedadIngresada;

    if (!wObj) {
      return res.status(400).json({
        error: "Bonchador inválido. Formato esperado: B01-T20",
      });
    }

    if (!vObj && !permiteVariedadVacia) {
      return res.status(400).json({
        error: "Variedad inválida. Formato esperado: V01",
      });
    }

    if (!gObj) {
      return res.status(400).json({
        error: "Grado inválido. Formato esperado: G60, 60, NACIONAL o BAJAS",
      });
    }

    if (!lObj) {
      return res.status(400).json({
        error: "Lámina inválida. Formato esperado: L1, L2, L3 o PVC",
      });
    }

    const variedadDb = vObj ? await getVariedadById(vObj.variedad_id) : null;

    if (vObj && !variedadDb) {
      return res.status(400).json({
        error: `La variedad ${vObj.variedad_id} no existe en la tabla variedades`,
      });
    }

    const laminaDb = await getLaminaActiva(lObj.id);

    if (!laminaDb) {
      return res.status(400).json({
        error: `La lámina ${lObj.id} no existe en la tabla lamina`,
      });
    }

    if (laminaDb.invalida) {
      return res.status(400).json({
        error: `La lámina ${lObj.id} está inactiva`,
      });
    }

    lObj.id = laminaDb.id || lObj.id;

    const workerName = await getPersistedWorkerName(wObj.code);
    const laminaNombre = laminaDb.nombre || lObj.id;
    const fincaValue = (() => {
      const value = String(finca || "").trim().toUpperCase();
      return /^(P1|P2)$/.test(value) ? value : null;
    })();

    const savedReg = await saveScan(
      wObj,
      vObj,
      gObj,
      lObj,
      variedadDb?.nombre || null,
      workerName,
      laminaNombre,
      fincaValue
    );

    const broadcastData = {
      ...savedReg,
      variedad_nombre: variedadDb?.nombre || vObj?.variedad_id || null,
      worker_name: savedReg.worker_name || workerName,
      lamina_nombre: savedReg.lamina_nombre || laminaNombre,
      finca: savedReg.finca || fincaValue,
    };

    broadcast({ kind: "scan", reg: broadcastData });

    return res.json({
      ok: true,
      reg: broadcastData,
    });

  } catch (err) {
    console.error("POST /api/scan error:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

function secureTextEquals(value, expected) {
  const left = Buffer.from(String(value || ""), "utf8");
  const right = Buffer.from(String(expected || ""), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function distributeIntegerTotal(total) {
  const safeTotal = Math.max(0, Math.trunc(Number(total) || 0));
  const result = GRADE_ESTIMATE_PERCENTAGES.map((item, index) => {
    const exact = safeTotal * item.porcentaje / 100;
    return {
      ...item,
      index,
      cantidad: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });

  let pending = safeTotal - result.reduce((sum, item) => sum + item.cantidad, 0);
  const priority = [...result].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < pending; i += 1) priority[i % priority.length].cantidad += 1;

  return result.sort((a, b) => a.index - b.index);
}

function styleReportHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.height = 22;
}

app.post("/api/reports/grade-estimate", async (req, res) => {
  try {
    const dateFrom = String(req.body?.dateFrom || "").trim();
    const dateTo = String(req.body?.dateTo || "").trim();
    const password = req.body?.password;

    if (!secureTextEquals(password, REPORT_PASSWORD)) {
      return res.status(401).json({ error: "Contraseña incorrecta" });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return res.status(400).json({ error: "Rango de fechas inválido" });
    }

    const parseLocalDate = (value) => {
      const [year, month, day] = value.split("-").map(Number);
      const parsed = new Date(year, month - 1, day, 0, 0, 0, 0);
      return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
        ? parsed
        : null;
    };
    const start = parseLocalDate(dateFrom);
    const lastDay = parseLocalDate(dateTo);
    if (!start || !lastDay) {
      return res.status(400).json({ error: "Rango de fechas inválido" });
    }
    if (start > lastDay) {
      return res.status(400).json({ error: "La fecha inicial no puede ser posterior a la fecha final" });
    }

    await ensureScansNameColumns();

    const end = new Date(lastDay);
    end.setDate(end.getDate() + 1);

    const result = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(s.variedad_id, ''), 'SIN CÓDIGO') AS variedad_id,
        COALESCE(NULLIF(s.variedad_nombre, ''), v.nombre, s.variedad_id, 'SIN VARIEDAD') AS variedad_nombre,
        COALESCE(NULLIF(s.finca, ''), 'SIN FINCA') AS finca,
        COUNT(*)::integer AS ramos,
        COALESCE(SUM(s.tallos), 0)::integer AS tallos
      FROM scans s
      LEFT JOIN variedades v ON s.variedad_id = v.id
      WHERE s.ts >= $1
        AND s.ts < $2
        AND CASE
          WHEN TRIM(s.grado_cm::text) ~ '^\d+$' THEN TRIM(s.grado_cm::text)::integer
          ELSE NULL
        END BETWEEN 40 AND 100
      GROUP BY
        COALESCE(NULLIF(s.variedad_id, ''), 'SIN CÓDIGO'),
        COALESCE(NULLIF(s.variedad_nombre, ''), v.nombre, s.variedad_id, 'SIN VARIEDAD'),
        COALESCE(NULLIF(s.finca, ''), 'SIN FINCA')
      ORDER BY variedad_nombre, finca
      `,
      [start, end]
    );

    const totalRamos = result.rows.reduce((sum, row) => sum + Number(row.ramos || 0), 0);
    const totalTallos = result.rows.reduce((sum, row) => sum + Number(row.tallos || 0), 0);
    const ramosEstimados = distributeIntegerTotal(totalRamos);
    const tallosEstimados = distributeIntegerTotal(totalTallos);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Punta de Banda P1";
    workbook.created = new Date();

    const summary = workbook.addWorksheet("Resumen estimado", {
      views: [{ state: "frozen", ySplit: 8 }]
    });
    summary.columns = [
      { key: "grado", width: 24 },
      { key: "porcentaje", width: 18 },
      { key: "ramos", width: 22 },
      { key: "tallos", width: 22 },
    ];
    summary.mergeCells("A1:D1");
    summary.getCell("A1").value = "INFORME ESTIMADO DE GRADOS DE PROCESO";
    summary.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
    summary.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
    summary.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
    summary.getRow(1).height = 30;
    summary.addRow(["Fecha inicial", dateFrom]);
    summary.addRow(["Fecha final", dateTo]);
    summary.addRow(["Ramos normales procesados", totalRamos]);
    summary.addRow(["Tallos normales procesados", totalTallos]);
    summary.addRow(["Excluidos", "NACIONAL, BAJAS y NACIONAL GRANEL"]);
    summary.addRow([]);
    const header = summary.addRow(["Grado estimado", "Porcentaje", "Ramos estimados", "Tallos estimados"]);
    styleReportHeader(header);

    ramosEstimados.forEach((item, index) => {
      const row = summary.addRow([
        `Grado ${item.grado}`,
        item.porcentaje / 100,
        item.cantidad,
        tallosEstimados[index].cantidad,
      ]);
      row.getCell(2).numFmt = "0%";
      if (index % 2 === 0) {
        row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6FF" } };
      }
    });
    const totalRow = summary.addRow(["TOTAL", 1, totalRamos, totalTallos]);
    totalRow.font = { bold: true };
    totalRow.getCell(2).numFmt = "0%";
    totalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD1FAE5" } };
    summary.addRow([]);
    summary.addRow(["Nota", "Estimación informativa; no modifica los grados de envío guardados."]);

    const detail = workbook.addWorksheet("Base por variedad", {
      views: [{ state: "frozen", ySplit: 1 }]
    });
    detail.columns = [
      { header: "Código variedad", key: "variedad_id", width: 18 },
      { header: "Variedad", key: "variedad_nombre", width: 30 },
      { header: "Finca", key: "finca", width: 14 },
      { header: "Ramos incluidos", key: "ramos", width: 20 },
      { header: "Tallos incluidos", key: "tallos", width: 20 },
    ];
    styleReportHeader(detail.getRow(1));
    result.rows.forEach((row) => detail.addRow({
      variedad_id: row.variedad_id,
      variedad_nombre: row.variedad_nombre,
      finca: row.finca,
      ramos: Number(row.ramos || 0),
      tallos: Number(row.tallos || 0),
    }));
    detail.autoFilter = "A1:E1";

    [summary, detail].forEach((sheet) => {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          cell.border = {
            top: { style: "thin", color: { argb: "FFD6E0EF" } },
            left: { style: "thin", color: { argb: "FFD6E0EF" } },
            bottom: { style: "thin", color: { argb: "FFD6E0EF" } },
            right: { style: "thin", color: { argb: "FFD6E0EF" } },
          };
        });
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `informe_grados_estimados_${dateFrom}_a_${dateTo}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("POST /api/reports/grade-estimate error:", err);
    return res.status(500).json({ error: "No se pudo generar el informe" });
  }
});

app.delete("/api/scans/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "ID inválido"
      });
    }

    const result = await pool.query(
      `
      DELETE FROM scans
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Registro no encontrado"
      });
    }

    broadcast({
      kind: "delete",
      id
    });

    return res.json({
      ok: true,
      id
    });

  } catch (err) {
    console.error("DELETE /api/scans/:id error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error eliminando registro"
    });
  }
});

/* ==========================================================
   SSE (Server-Sent Events) en /api/stream
   ========================================================== */

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => res.write(msg));
}

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
    try {
      res.end();
    } catch {}
  });
});

/* ==========================================================
   ARRANQUE DEL SERVIDOR
   ========================================================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor en puerto ${PORT} (Formatos: Bxx-Tyy, Vxx-gg y Lx)`);
  loadWorkerNames()
    .then(() => console.log(`Nombres persistentes cargados: ${Object.keys(workerNameMap).length}`))
    .catch((err) => console.error("No se pudieron precargar los nombres de bonchadores:", err));
});
