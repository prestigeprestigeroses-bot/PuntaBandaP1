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
const WORKER_MAX = 12;

// Mapa en memoria de nombres de bonchadores (p.ej. { B16: "Juan" })
let workerNameMap = {};
let scansNameColumnsReady = false;

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

// Lista de bonchadores con nombres
app.get("/api/workers", (req, res) => {
  const workers = [];
  for (let i = WORKER_MIN; i <= WORKER_MAX; i++) {
    const code = `B${String(i).padStart(2, "0")}`;
    workers.push({ code, name: workerNameMap[code] || code });
  }
  res.json(workers);
});

// Guardar/actualizar nombre de bonchador (en memoria)
app.post("/api/workers", async (req, res) => {
  try {
    const { code, name } = req.body || {};
    const workerCode = String(code || "").trim().toUpperCase();

    if (!workerCode) {
      return res.status(400).json({ error: "Falta el código del bonchador" });
    }

    const workerName = String(name || "").trim() || workerCode;
    workerNameMap[workerCode] = workerName;

    await updateTodayWorkerName(workerCode, workerName);

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
        COALESCE(s.lamina_nombre, l.nombre, s.lamina_id) AS lamina_nombre
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
    code: `B${String(n).padStart(2, "0")}`, // B01, B02... B12
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
  const up = String(code || "").trim().toUpperCase();

  // Grados numéricos: G60 o 60
  const mNum = up.match(/^G?(\d{1,3})$/);
  if (mNum) {
    const grado_cm = parseInt(mNum[1], 10);

    if (!Number.isFinite(grado_cm) || grado_cm <= 0) return null;

    return {
      grado_cm: String(grado_cm),
      raw: `G${grado_cm}`,
    };
  }

  // Grados de texto permitidos
  const textosPermitidos = ["NACIONAL", "BAJAS"];

  if (textosPermitidos.includes(up)) {
    return {
      grado_cm: up,
      raw: up,
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
  const result = await pool.query(
    id === "PVC"
      ? `
        SELECT id, nombre, activo
        FROM lamina
        WHERE UPPER(id) = $1
           OR UPPER(nombre) LIKE '%PVC%'
        ORDER BY CASE WHEN UPPER(id) = $1 THEN 0 ELSE 1 END
        LIMIT 1
      `
      : `
        SELECT id, nombre, activo
        FROM lamina
        WHERE UPPER(id) = $1
        LIMIT 1
      `,
    [id]
  );

  if (!result.rows[0]) return null;
  if (!result.rows[0].activo) return { ...result.rows[0], invalida: true };

  return result.rows[0];
}

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
    ADD COLUMN IF NOT EXISTS lamina_nombre character varying(120)
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

async function saveScan(wObj, vObj, gObj, lObj, variedadNombre, workerName, laminaNombre) {
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
        lamina_nombre
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;

    const values = [
      localTimestamp,
      wObj.code,           // B01
      workerName,
      wObj.tallos,         // 20
      vObj.variedad_id,    // V01
      variedadNombre,
      gObj.grado_cm,       // 60
      wObj.raw,            // B01-T20
      `${vObj.raw}-${gObj.raw}`, // V01-G60
      lObj.id,             // L1
      laminaNombre
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
    const { worker, variedad, grado, lamina } = req.body || {};

    const wObj = parseWorker(worker);
    const vObj = parseVariedad(variedad);
    const gObj = parseGrado(grado);
    const lObj = parseLamina(lamina);

    if (!wObj) {
      return res.status(400).json({
        error: "Bonchador inválido. Formato esperado: B01-T20",
      });
    }

    if (!vObj) {
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
        error: "Lámina inválida. Formato esperado: L1, L2, L3...",
      });
    }

    const variedadDb = await getVariedadById(vObj.variedad_id);

    if (!variedadDb) {
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

    const workerName = workerNameMap[wObj.code] || wObj.code;
    const laminaNombre = laminaDb.nombre || lObj.id;

    const savedReg = await saveScan(
      wObj,
      vObj,
      gObj,
      lObj,
      variedadDb.nombre,
      workerName,
      laminaNombre
    );

    const broadcastData = {
      ...savedReg,
      variedad_nombre: variedadDb.nombre || vObj.variedad_id,
      worker_name: savedReg.worker_name || workerName,
      lamina_nombre: savedReg.lamina_nombre || laminaNombre,
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
});
