// server.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { v2 as cloudinary } from "cloudinary";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

// ─── Cloudinary ─────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Sube un Buffer a Cloudinary y devuelve el resultado
function subirACloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: "optica-yolanda-catalogo", resource_type: "image" },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);
    readable.pipe(uploadStream);
  });
}

// ─── Estáticos ──────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

// ─── Base de datos JSON (persistente en Render si hay disco montado) ─────────
const DATA_DIR = path.join(__dirname, "public", "uploads", "_data");
fs.mkdirSync(DATA_DIR, { recursive: true });

function safeBranch(b) {
  return String(b || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}
function dbPath(b) {
  return path.join(DATA_DIR, `${safeBranch(b)}.json`);
}
function readDb(b) {
  const fp = dbPath(b);
  if (!fs.existsSync(fp)) return { productos: [] };
  try { return JSON.parse(fs.readFileSync(fp, "utf8")) || { productos: [] }; }
  catch { return { productos: [] }; }
}
function writeDb(b, data) {
  fs.writeFileSync(dbPath(b), JSON.stringify(data, null, 2), "utf8");
}

// ─── Autenticación admin ─────────────────────────────────────────────────────
const REQUIRED_ADMIN_KEY = process.env.ADMIN_KEY || null;
function requireAdmin(req, res, next) {
  const key = String(req.get("x-admin-key") || "");
  if (REQUIRED_ADMIN_KEY) {
    if (key === REQUIRED_ADMIN_KEY) return next();
  } else {
    if (key.trim() !== "") return next();
  }
  return res.status(401).send("Admin requerido");
}

// ─── Multer: memoria (NO disco — Cloudinary recibe el buffer) ────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error("Solo se permiten imágenes"));
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normalizeBool(v) {
  if (typeof v === "boolean") return v;
  return ["1", "true", "sí", "si", "on", "yes"].includes(String(v || "").toLowerCase());
}

// ─── Rutas ───────────────────────────────────────────────────────────────────

app.get("/healthz", (_req, res) => res.send("ok"));

// GET productos de una sucursal
app.get("/productos/:sucursal", (req, res) => {
  const data = readDb(req.params.sucursal);
  res.json({ productos: data.productos || [] });
});

// POST nuevo producto — imagen OBLIGATORIA → sube a Cloudinary
app.post("/upload/:sucursal", requireAdmin, upload.single("imagen"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("Imagen obligatoria");
    }

    console.log("[Cloudinary] Subiendo imagen nueva...");
    const cloudResult = await subirACloudinary(req.file.buffer);
    console.log("[Cloudinary] URL:", cloudResult.secure_url);

    const suc  = req.params.sucursal;
    const data = readDb(suc);
    const id   = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    const nuevo = {
      id,
      codigo:      (req.body.codigo      || "").trim(),
      nombre:      (req.body.nombre      || "").trim(),
      precio:      (req.body.precio      || "").trim(),
      categoria:   (req.body.categoria   || "dama").trim(),
      oferta:      normalizeBool(req.body.oferta),
      precioPromo: (req.body.precioPromo || "").trim(),
      img:         cloudResult.secure_url,
    };

    if (!nuevo.codigo || !nuevo.nombre || !nuevo.precio) {
      return res.status(400).send("Faltan campos obligatorios (codigo, nombre, precio)");
    }

    data.productos = Array.isArray(data.productos) ? data.productos : [];
    data.productos.unshift(nuevo);
    writeDb(suc, data);

    res.json({ ok: true, producto: nuevo });
  } catch (err) {
    console.error("[Cloudinary ERROR en POST]", err);
    res.status(500).send("Error al subir imagen");
  }
});

// PUT editar producto — imagen OPCIONAL (si no viene, conserva la anterior)
app.put("/producto/:sucursal/:id", requireAdmin, upload.single("imagen"), async (req, res) => {
  try {
    const suc  = req.params.sucursal;
    const id   = req.params.id;
    const data = readDb(suc);

    const idx = (data.productos || []).findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).send("Producto no encontrado");

    if (req.file) {
      console.log("[Cloudinary] Actualizando imagen...");
      const cloudResult = await subirACloudinary(req.file.buffer);
      data.productos[idx].img = cloudResult.secure_url;
      console.log("[Cloudinary] Nueva URL:", cloudResult.secure_url);
    }
    // Sin imagen nueva → img se conserva intacta

    const b = req.body || {};
    if (b.codigo      !== undefined) data.productos[idx].codigo      = String(b.codigo).trim();
    if (b.nombre      !== undefined) data.productos[idx].nombre      = String(b.nombre).trim();
    if (b.precio      !== undefined) data.productos[idx].precio      = String(b.precio).trim();
    if (b.categoria   !== undefined) data.productos[idx].categoria   = String(b.categoria).trim();
    if (b.oferta      !== undefined) data.productos[idx].oferta      = normalizeBool(b.oferta);
    if (b.precioPromo !== undefined) data.productos[idx].precioPromo = String(b.precioPromo).trim();

    writeDb(suc, data);
    res.json({ ok: true, producto: data.productos[idx] });
  } catch (err) {
    console.error("[Cloudinary ERROR en PUT]", err);
    res.status(500).send("Error al editar producto");
  }
});

// DELETE producto — solo borra de la DB (imagen queda en Cloudinary sin romper nada)
app.delete("/producto/:sucursal/:id", requireAdmin, (req, res) => {
  const suc  = req.params.sucursal;
  const id   = req.params.id;
  const data = readDb(suc);

  const idx = (data.productos || []).findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).send("Producto no encontrado");

  data.productos.splice(idx, 1);
  writeDb(suc, data);
  res.json({ ok: true });
});

// Exportar CSV
app.get("/export/:sucursal.csv", (req, res) => {
  const suc   = req.params.sucursal;
  const items = readDb(suc).productos || [];
  const cols  = ["id", "codigo", "nombre", "precio", "oferta", "precioPromo", "categoria", "img"];

  const lines = [
    cols.join(","),
    ...items.map(p =>
      cols.map(k => {
        const raw = String(p[k] ?? "");
        return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
      }).join(",")
    ),
  ];

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safeBranch(suc)}.csv"`);
  res.send(lines.join("\n"));
});

// Fallback SPA
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ─── Inicio ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || "⚠ NO CONFIGURADO";
  console.log(`Óptica Yolanda escuchando en puerto ${PORT}`);
  console.log(`Cloudinary cloud_name: ${cloudName}`);
  console.log(`Base de datos JSON en: ${DATA_DIR}`);
  console.log("Almacenamiento de imágenes: Cloudinary (sin disco local)");
});
