// server.js
// Minimal stok API — Express + SQLite (tek dosyada çalışır)
// Özellikler: IN/OUT, TRANSFER, COUNT, ürün adı sorgusu, CORS, doğrulama, kalıcı SQLite

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || './data.db';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
const APPLY_COUNT = (process.env.APPLY_COUNT || 'false').toLowerCase()==='true';

app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl & same-origin
    if (ALLOWED_ORIGINS.length===0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked for origin: '+origin));
  },
  credentials: false
}));

let db;
async function initDb(){
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
CREATE TABLE IF NOT EXISTS products (
  barcode TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS stock_levels (
  barcode TEXT NOT NULL,
  location TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (barcode, location)
);
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK(action IN ('IN','OUT')),
  barcode TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK(qty>0),
  location TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK(qty>0),
  from_location TEXT NOT NULL,
  to_location TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS count_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id INTEGER NOT NULL,
  barcode TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK(qty>=0),
  FOREIGN KEY(count_id) REFERENCES counts(id) ON DELETE CASCADE
);
`);
}

// Helpers
function now(){ return Math.floor(Date.now()/1000); }
async function upsertStock(barcode, location, delta){
  const row = await db.get('SELECT qty FROM stock_levels WHERE barcode=? AND location=?', [barcode, location]);
  if (!row) {
    await db.run('INSERT INTO stock_levels (barcode, location, qty) VALUES (?,?,?)', [barcode, location, Math.max(0, delta)]);
  } else {
    const newQty = (row.qty||0) + delta;
    await db.run('UPDATE stock_levels SET qty=? WHERE barcode=? AND location=?', [newQty, barcode, location]);
  }
}

function requireFields(obj, fields){
  for (const f of fields){ if (obj[f]===undefined || obj[f]===null || (typeof obj[f]==='string' && obj[f].trim()==='')){
    const err = new Error(`Missing field: ${f}`); err.status=400; throw err; }
  }
}

// Health
app.get('/health', (req,res)=> res.json({ ok:true, time: new Date().toISOString() }));

// Product lookup (for UI name display)
app.get('/products/by-barcode', async (req,res)=>{
  try{
    const code = (req.query.code||'').toString().trim();
    if (!code) return res.status(400).json({ ok:false, error:'code required' });
    const row = await db.get('SELECT barcode, name, sku FROM products WHERE barcode=?', [code]);
    if (!row) return res.json({ ok:true, name:null });
    return res.json({ ok:true, name: row.name, sku: row.sku });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// Optional seed endpoint
app.post('/products', async (req,res)=>{
  try{
    const { barcode, name, sku } = req.body||{};
    requireFields({ barcode, name }, ['barcode','name']);
    await db.run('INSERT OR REPLACE INTO products (barcode,name,sku,created_at) VALUES (?,?,?,?)', [barcode, name, sku||null, now()]);
    res.json({ ok:true });
  }catch(e){ res.status(e.status||500).json({ ok:false, error:e.message }); }
});

// IN / OUT
app.post('/stock/move', async (req,res)=>{
  try{
    const { action, barcode, qty, location } = req.body||{};
    requireFields({ action, barcode, qty, location }, ['action','barcode','qty','location']);
    if (!['IN','OUT'].includes(action)) throw Object.assign(new Error('action must be IN or OUT'), {status:400});
    const nQty = Number(qty); if (!Number.isInteger(nQty) || nQty<=0) throw Object.assign(new Error('qty must be positive integer'),{status:400});
    const delta = action==='IN' ? nQty : -nQty;

    await db.run('BEGIN');
    await db.run('INSERT INTO movements (action,barcode,qty,location,ts) VALUES (?,?,?,?,?)', [action, barcode, nQty, location, now()]);
    await upsertStock(barcode, location, delta);
    await db.run('COMMIT');

    const level = await db.get('SELECT qty FROM stock_levels WHERE barcode=? AND location=?', [barcode, location]);
    res.json({ ok:true, level: level?.qty ?? 0 });
  }catch(e){ await db.run('ROLLBACK'); res.status(e.status||500).json({ ok:false, error:e.message }); }
});

// TRANSFER
app.post('/stock/transfer', async (req,res)=>{
  try{
    const { barcode, qty, fromLocation, toLocation } = req.body||{};
    requireFields({ barcode, qty, fromLocation, toLocation }, ['barcode','qty','fromLocation','toLocation']);
    if (fromLocation===toLocation) throw Object.assign(new Error('fromLocation must differ from toLocation'), {status:400});
    const nQty = Number(qty); if (!Number.isInteger(nQty) || nQty<=0) throw Object.assign(new Error('qty must be positive integer'),{status:400});

    await db.run('BEGIN');
    await db.run('INSERT INTO transfers (barcode,qty,from_location,to_location,ts) VALUES (?,?,?,?,?)', [barcode, nQty, fromLocation, toLocation, now()]);
    await upsertStock(barcode, fromLocation, -nQty);
    await upsertStock(barcode, toLocation, +nQty);
    await db.run('COMMIT');

    const from = await db.get('SELECT qty FROM stock_levels WHERE barcode=? AND location=?', [barcode, fromLocation]);
    const to = await db.get('SELECT qty FROM stock_levels WHERE barcode=? AND location=?', [barcode, toLocation]);
    res.json({ ok:true, fromLevel: from?.qty ?? 0, toLevel: to?.qty ?? 0 });
  }catch(e){ await db.run('ROLLBACK'); res.status(e.status||500).json({ ok:false, error:e.message }); }
});

// COUNT (inventory count)
app.post('/stock/count', async (req,res)=>{
  try{
    const { location, lines } = req.body||{};
    requireFields({ location, lines }, ['location','lines']);
    if (!Array.isArray(lines) || lines.length===0) throw Object.assign(new Error('lines must be non-empty array'), {status:400});

    await db.run('BEGIN');
    const result = await db.run('INSERT INTO counts (location, ts) VALUES (?,?)', [location, now()]);
    const countId = result.lastID;
    const stmt = await db.prepare('INSERT INTO count_lines (count_id, barcode, qty) VALUES (?,?,?)');
    for (const ln of lines){
      const b = (ln.barcode||'').toString().trim();
      const q = Number(ln.qty);
      if (!b || !Number.isInteger(q) || q<0) throw Object.assign(new Error('invalid line item'), {status:400});
      await stmt.run(countId, b, q);
      if (APPLY_COUNT){
        // Sayımı direkt stoğa uygula: mevcut qty yerine sayım qty
        const row = await db.get('SELECT qty FROM stock_levels WHERE barcode=? AND location=?',[b, location]);
        const cur = row? row.qty : 0;
        const delta = q - cur;
        await upsertStock(b, location, delta);
      }
    }
    await stmt.finalize();
    await db.run('COMMIT');

    res.json({ ok:true, countId });
  }catch(e){ await db.run('ROLLBACK'); res.status(e.status||500).json({ ok:false, error:e.message }); }
});

// Basit raporlar (opsiyonel)
app.get('/stock/levels', async (req,res)=>{
  try{ const rows = await db.all('SELECT barcode, location, qty FROM stock_levels ORDER BY location, barcode'); res.json({ ok:true, rows }); }
  catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/stock/movements', async (req,res)=>{
  try{ const rows = await db.all('SELECT * FROM movements ORDER BY ts DESC LIMIT 100'); res.json({ ok:true, rows }); }
  catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

app.listen(PORT, async ()=>{
  await initDb();
  console.log(`API ready on http://localhost:${PORT}`);
  console.log('Allowed origins:', ALLOWED_ORIGINS.length? ALLOWED_ORIGINS : '(ALL)');
});
