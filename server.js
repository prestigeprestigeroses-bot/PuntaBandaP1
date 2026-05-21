// server.js
// -------------------------------------------------------------
// Backend para Empaque — Rendimiento por bonchador (PRESTIGE P2)
// Formatos de escaneo:
//   • Bonchador + tallos: B16-T20
//   • Variedad + grado : V01-60
//   • Lámina           : L1, L2, L3 ...
//
// Guarda en DB:
//   worker, tallos, variedad_id, grado_cm, lamina_id
//
// Requisito en DB:
//   ALTER TABLE public.scans
//   ADD COLUMN IF NOT EXISTS lamina_id character varying(20);
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
app.post("/api/workers", (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  workerNameMap[String(code).toUpperCase()] = String(name).trim();
  res.json({ ok: true });
});

// Traer escaneos recientes (con nombre de variedad por JOIN y nombre de lámina por JOIN)
app.get("/api/scans", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 200;

    const query = `
      SELECT 
        s.id,
        s.ts, 
        s.worker, 
        s.tallos, 
        s.variedad_id, 
        s.grado_cm,
        s.lamina_id,
        s.raw_a,
        s.raw_b,
        COALESCE(v.nombre, s.variedad_id) AS variedad_nombre,
        COALESCE(l.nombre, s.lamina_id) AS lamina_nombre
      FROM scans s
      LEFT JOIN variedades v ON s.variedad_id = v.id
      LEFT JOIN lamina l ON s.lamina_id = l.id
      ORDER BY s.ts DESC 
      LIMIT $1
    `;

    const result = await pool.query(query, [limit]);

    const finalData = result.rows.map((row) => ({
      ...row,
      worker_name: row.worker ? (workerNameMap[row.worker] || row.worker) : null,
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

  // Acepta G60 o 60
  const m = up.match(/^G?(\d{1,3})$/);
  if (!m) return null;

  const grado_cm = parseInt(m[1], 10);
  if (!Number.isFinite(grado_cm) || grado_cm <= 0) return null;

  return {
    grado_cm,
    raw: `G${grado_cm}`,
  };
}

// Lámina: L1, L2, L3...
function parseLamina(code) {
  const up = String(code || "").trim().toUpperCase();
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
  const result = await pool.query(
    `
    SELECT id, nombre, activo
    FROM lamina
    WHERE UPPER(id) = $1
    LIMIT 1
    `,
    [String(laminaId || "").toUpperCase()]
  );

  if (!result.rows[0]) return null;
  if (!result.rows[0].activo) return { ...result.rows[0], invalida: true };

  return result.rows[0];
}

/* ==========================================================
   GUARDADO EN DB
   ========================================================== */

async function saveScan(wObj, vObj, gObj, lObj) {
  const client = await pool.connect();

  try {
    const localTimestamp = new Date();

    const query = `
      INSERT INTO scans (
        ts,
        worker,
        tallos,
        variedad_id,
        grado_cm,
        raw_a,
        raw_b,
        lamina_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;

    const values = [
      localTimestamp,
      wObj.code,           // B01
      wObj.tallos,         // 20
      vObj.variedad_id,    // V01
      gObj.grado_cm,       // 60
      wObj.raw,            // B01-T20
      `${vObj.raw}-${gObj.raw}`, // V01-G60
      lObj.id              // L1
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
        error: "Grado inválido. Formato esperado: G60",
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

    const savedReg = await saveScan(wObj, vObj, gObj, lObj);

    const broadcastData = {
      ...savedReg,
      variedad_nombre: variedadDb.nombre || vObj.variedad_id,
      worker_name: workerNameMap[savedReg.worker] || savedReg.worker,
      lamina_nombre: laminaDb.nombre || lObj.id,
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