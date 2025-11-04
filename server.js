// server.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- Rutas de estáticos ---
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    // Evita que Render o el navegador cacheen demasiado el index
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

// --- Disco persistente (Render) ---
const UPLOAD_ROOT = path.join(PUBLIC_DIR, "uploads"); // /opt/render/project/src/public/uploads
const DATA_DIR    = path.join(UPLOAD_ROOT, "_data");

// Crea carpetas si no existen
for (const p of [UPLOAD_ROOT, DATA_DIR]) {
  fs.mkdirSync(p, { recursive: true });
}

// --- Utilidades JSON ---
function safeBranch(b) {
  return String(b || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}
function branchDir(b) {
  const dir = path.join(UPLOAD_ROOT, safeBranch(b));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function branchDbPath(b) {
  return path.join(DATA_DIR, `${safeBranch(b)}.json`);
}
function readDb(b) {
  const fp = branchDbPath(b);
  if (!fs.existsSync(fp)) return { productos: [] };
  try { return JSON.parse(fs.readFileSync(fp, "utf8")) || { productos: [] }; }
  catch { return { productos: [] }; }
}
function writeDb(b, data) {
  const fp = branchDbPath(b);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf8");
}

// --- Autenticación admin muy simple ---
const REQUIRED_ADMIN_KEY = process.env.ADMIN_KEY || null;
function requireAdmin(req, res, next) {
  const key = String(req.get("x-admin-key") || "");
  if (REQUIRED_ADMIN_KEY) {
    if (key === REQUIRED_ADMIN_KEY) return next();
  } else {
    if (key.trim() !== "") return next(); // si no definiste ADMIN_KEY, cualquier no-vacío vale
  }
  return res.status(401).send("Admin requerido");
}

// --- Multer (subidas de imágenes) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, branchDir(req.params.sucursal));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]+/gi, "_");
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error("Solo imágenes"));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

// --- Helpers de normalización ---
function normalizeBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v || "").toLowerCase();
  return ["1","true","sí","si","on","yes"].includes(s);
}
function publicImgUrl(fileFullPath) {
  // Devuelve el path público a servir por express.static
  const rel = path.relative(PUBLIC_DIR, fileFullPath).split(path.sep).join("/");
  return `/${rel}`;
}

// --- Endpoints ---

// Health
app.get("/healthz", (_req, res) => res.send("ok"));

// Obtener productos de una sucursal
app.get("/productos/:sucursal", (req, res) => {
  const data = readDb(req.params.sucursal);
  res.json({ productos: data.productos || [] });
});

// Subir producto nuevo (imagen obligatoria)
app.post("/upload/:sucursal", requireAdmin, upload.single("imagen"), (req, res) => {
  try {
    const suc = req.params.sucursal;
    const data = readDb(suc);

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const nuevo = {
      id,
      codigo: (req.body.codigo || "").trim(),
      nombre: (req.body.nombre || "").trim(),
      precio: (req.body.precio || "").trim(),
      categoria: (req.body.categoria || "dama").trim(),
      oferta: normalizeBool(req.body.oferta),
      precioPromo: (req.body.precioPromo || "").trim(),
      img: req.file ? publicImgUrl(req.file.path) : ""
    };

    if (!nuevo.codigo || !nuevo.nombre || !nuevo.precio || !nuevo.img) {
      return res.status(400).send("Faltan campos obligatorios");
    }

    data.productos = Array.isArray(data.productos) ? data.productos : [];
    data.productos.unshift(nuevo); // aparece arriba
    writeDb(suc, data);

    res.json({ ok: true, producto: nuevo });
  } catch (e) {
    console.error(e);
    res.status(500).send("Error al subir");
  }
});

// Editar producto (imagen opcional)
app.put("/producto/:sucursal/:id", requireAdmin, upload.single("imagen"), (req, res) => {
  const suc = req.params.sucursal;
  const id  = req.params.id;
  const data = readDb(suc);

  const i = (data.productos || []).findIndex(p => p.id === id);
  if (i === -1) return res.status(404).send("No encontrado");

  // Si viene imagen nueva, actualizamos ruta
  if (req.file) {
    data.productos[i].img = publicImgUrl(req.file.path);
  }
  const b = req.body || {};
  if (b.codigo)      data.productos[i].codigo = String(b.codigo).trim();
  if (b.nombre)      data.productos[i].nombre = String(b.nombre).trim();
  if (b.precio)      data.productos[i].precio = String(b.precio).trim();
  if (b.categoria)   data.productos[i].categoria = String(b.categoria).trim();
  if (typeof b.oferta !== "undefined") data.productos[i].oferta = normalizeBool(b.oferta);
  if (typeof b.precioPromo !== "undefined") data.productos[i].precioPromo = String(b.precioPromo).trim();

  writeDb(suc, data);
  res.json({ ok: true, producto: data.productos[i] });
});

// Eliminar producto
app.delete("/producto/:sucursal/:id", requireAdmin, (req, res) => {
  const suc = req.params.sucursal;
  const id  = req.params.id;
  const data = readDb(suc);

  const idx = (data.productos || []).findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).send("No encontrado");

  // (Opcional) podrías borrar la imagen física:
  // try { fs.unlinkSync(path.join(PUBLIC_DIR, data.productos[idx].img)); } catch {}

  data.productos.splice(idx, 1);
  writeDb(suc, data);
  res.json({ ok: true });
});

// Exportar CSV
app.get("/export/:sucursal.csv", (req, res) => {
  const suc = req.params.sucursal;
  const data = readDb(suc);
  const items = data.productos || [];

  const header = ["id","codigo","nombre","precio","oferta","precioPromo","categoria","img"];
  const lines = [
    header.join(","),
    ...items.map(p => header.map(k => {
      // Escapar comas y comillas
      const raw = (p[k] ?? "").toString();
      if (/[",\n]/.test(raw)) {
        return `"${raw.replace(/"/g, '""')}"`;
      }
      return raw;
    }).join(","))
  ];
  const csv = lines.join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safeBranch(suc)}.csv"`);
  res.send(csv);
});

// Fallback a index.html (single-page feel)
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// --- Lanzar servidor ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Óptica Yolanda backend en http://localhost:${PORT}`);
  console.log(`Uploads en ${UPLOAD_ROOT}`);
});
