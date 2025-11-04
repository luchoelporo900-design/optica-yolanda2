import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === CONFIG ===
const DATA_DIR = path.join(__dirname, "data");
const UP_DIR = path.join(__dirname, "public", "uploads");
const SUCURSALES = new Set(["central", "fernando", "caacupe"]);
const ADMIN_KEY = process.env.ADMIN_KEY || "yolanda2025";

// Static
app.use(express.static(path.join(__dirname, "public")));

// Asegurar carpetas y JSON
for (const s of SUCURSALES) {
  fs.mkdirSync(path.join(UP_DIR, s), { recursive: true });
  const jf = path.join(DATA_DIR, `${s}.json`);
  if (!fs.existsSync(jf)) fs.writeFileSync(jf, JSON.stringify({ productos: [] }, null, 2), "utf-8");
}

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(UP_DIR, req.params.sucursal)),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage });

// Helpers
const jf = (s) => path.join(DATA_DIR, `${s}.json`);
const readJson = (s) => JSON.parse(fs.readFileSync(jf(s), "utf-8"));
const writeJson = (s, d) => fs.writeFileSync(jf(s), JSON.stringify(d, null, 2), "utf-8");
const absFromRel = (rel) => path.join(__dirname, "public", rel.replace(/^\//, ""));

function checkAdmin(req, res, next) {
  const k = req.headers["x-admin-key"];
  if (!k || k !== ADMIN_KEY) return res.status(401).send("Admin requerido");
  next();
}

// === RUTAS ===

// Listado por sucursal
app.get("/productos/:sucursal", (req, res) => {
  const suc = req.params.sucursal;
  if (!SUCURSALES.has(suc)) return res.status(400).json({ error: "Sucursal inválida" });
  res.json(readJson(suc));
});

// Alta (con código) — solo admin
app.post("/upload/:sucursal", checkAdmin, upload.single("imagen"), (req, res) => {
  const suc = req.params.sucursal;
  if (!SUCURSALES.has(suc)) return res.status(400).json({ error: "Sucursal inválida" });
  if (!req.file) return res.status(400).json({ error: "Falta imagen" });

  const { nombre, precio, categoria, codigo } = req.body;
  if (!nombre || !precio || !categoria || !codigo) {
    return res.status(400).json({ error: "Faltan datos (nombre, precio, categoría, código)" });
  }

  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const relPath = `/uploads/${suc}/${req.file.filename}`;

  const data = readJson(suc);
  // evitar códigos duplicados en la misma sucursal
  if (data.productos.some(p => (p.codigo || "").toLowerCase() === codigo.toLowerCase())) {
    // eliminar imagen subida si hay conflicto
    try { fs.unlinkSync(absFromRel(relPath)); } catch {}
    return res.status(409).json({ error: "Código ya existente en esta sucursal" });
  }

  const prod = { id, codigo, nombre, precio, categoria, img: relPath, ts: Date.now() };
  data.productos.push(prod);
  writeJson(suc, data);
  res.json({ ok: true, producto: prod });
});

// Edición (con o sin nueva imagen) — solo admin
app.put("/producto/:sucursal/:id", checkAdmin, upload.single("imagen"), (req, res) => {
  const { sucursal, id } = req.params;
  if (!SUCURSALES.has(sucursal)) return res.status(400).json({ error: "Sucursal inválida" });

  const data = readJson(sucursal);
  const idx = data.productos.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: "Producto no encontrado" });

  const p = data.productos[idx];
  const { nombre, precio, categoria, codigo } = req.body;

  // Validar código duplicado si lo cambian
  if (codigo && codigo !== p.codigo) {
    if (data.productos.some(x => x.id !== id && (x.codigo || "").toLowerCase() === codigo.toLowerCase())) {
      return res.status(409).json({ error: "Código ya existente" });
    }
    p.codigo = codigo;
  }
  if (nombre) p.nombre = nombre;
  if (precio) p.precio = precio;
  if (categoria) p.categoria = categoria;

  if (req.file) {
    // borrar imagen vieja
    try { fs.unlinkSync(absFromRel(p.img)); } catch {}
    p.img = `/uploads/${sucursal}/${req.file.filename}`;
  }

  p.ts = Date.now();
  data.productos[idx] = p;
  writeJson(sucursal, data);
  res.json({ ok: true, producto: p });
});

// Borrado — solo admin
app.delete("/producto/:sucursal/:id", checkAdmin, (req, res) => {
  const { sucursal, id } = req.params;
  if (!SUCURSALES.has(sucursal)) return res.status(400).json({ error: "Sucursal inválida" });

  const data = readJson(sucursal);
  const idx = data.productos.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: "Producto no encontrado" });

  // borrar imagen del disco
  try { fs.unlinkSync(absFromRel(data.productos[idx].img)); } catch {}
  const [removed] = data.productos.splice(idx, 1);
  writeJson(sucursal, data);
  res.json({ ok: true, removed });
});

// SPA
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Óptica Yolanda on http://localhost:${PORT}`));
