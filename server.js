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

// Static
app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = path.join(__dirname, "data");
const UP_DIR = path.join(__dirname, "public", "uploads");
const SUCURSALES = new Set(["central","fernando","caacupe"]);

// Ensure folders exist
for (const s of SUCURSALES) {
  fs.mkdirSync(path.join(UP_DIR, s), { recursive: true });
  const jf = path.join(DATA_DIR, `${s}.json`);
  if (!fs.existsSync(jf)) fs.writeFileSync(jf, JSON.stringify({ productos: [] }, null, 2), "utf-8");
}

// Multer storage per sucursal (in req params)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const suc = req.params.sucursal;
    cb(null, path.join(UP_DIR, suc));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || ".jpg";
    const name = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage });

// Helpers
function readJson(sucursal) {
  const p = path.join(DATA_DIR, `${sucursal}.json`);
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { productos: [] };
  }
}
function writeJson(sucursal, data) {
  const p = path.join(DATA_DIR, `${sucursal}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

// Routes
app.get("/productos/:sucursal", (req, res) => {
  const suc = req.params.sucursal;
  if (!SUCURSALES.has(suc)) return res.status(400).json({ error: "Sucursal inválida" });
  res.json(readJson(suc));
});

app.post("/upload/:sucursal", upload.single("imagen"), (req, res) => {
  const suc = req.params.sucursal;
  if (!SUCURSALES.has(suc)) return res.status(400).json({ error: "Sucursal inválida" });
  if (!req.file) return res.status(400).json({ error: "Falta imagen" });

  const { nombre, precio } = req.body;
  if (!nombre || !precio) return res.status(400).json({ error: "Falta nombre o precio" });

  const relPath = `/uploads/${suc}/${req.file.filename}`;
  const data = readJson(suc);
  data.productos.push({ nombre, precio, img: relPath });
  writeJson(suc, data);
  res.json({ ok: true, producto: { nombre, precio, img: relPath } });
});

// Fallback to SPA
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Óptica Yolanda app on http://localhost:${PORT}`));
