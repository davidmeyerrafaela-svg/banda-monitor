/**
 * server.js — Proxy Node.js/Express
 * Resuelve CORS para BCRA API y feeds RSS de noticias.
 * Sirve los archivos estáticos del dashboard.
 *
 * Uso: node server.js
 * Luego abrir: http://localhost:3000
 */

const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');
const xml2js  = require('xml2js');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Proxy BCRA API ─────────────────────────────────────────────────────────

/**
 * GET /api/bcra/variables
 * Lista todas las variables estadísticas del BCRA.
 */
app.get('/api/bcra/variables', async (req, res) => {
  const url = 'https://api.bcra.gob.ar/estadisticas/v2.0/principalesvariables';
  try {
    log(`BCRA variables: ${url}`);
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'TetraPak-Monitor/1.0' },
      timeout: 10000
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    log(`Error BCRA variables: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/bcra/serie/:id/:desde/:hasta
 * Descarga una serie histórica del BCRA.
 * Parámetros: id = idVariable, desde/hasta = YYYY-MM-DD
 */
app.get('/api/bcra/serie/:id/:desde/:hasta', async (req, res) => {
  const { id, desde, hasta } = req.params;
  const url = `https://api.bcra.gob.ar/estadisticas/v2.0/datosVariable/${id}/${desde}/${hasta}`;
  try {
    log(`BCRA serie ${id}: ${desde} → ${hasta}`);
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'TetraPak-Monitor/1.0' },
      timeout: 15000
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    log(`Error BCRA serie ${id}: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// ── Proxy Noticias RSS ─────────────────────────────────────────────────────

const NEWS_FEEDS = [
  { name: 'Ámbito Economía',   url: 'https://www.ambito.com/rss/economia.xml' },
  { name: 'Infobae Economía',  url: 'https://www.infobae.com/economia/rss/' },
  { name: 'La Nación Economía',url: 'https://www.lanacion.com.ar/rss/economia.xml' },
  { name: 'El Cronista',       url: 'https://www.cronista.com/rss/finanzas-mercados.xml' },
  { name: 'iProfesional',      url: 'https://www.iprofesional.com/rss/finanzas.xml' }
];

/**
 * GET /api/news
 * Intenta obtener noticias económicas de Argentina desde múltiples feeds RSS.
 */
app.get('/api/news', async (req, res) => {
  const results = [];
  const parser  = new xml2js.Parser({ explicitArray: false });

  for (const feed of NEWS_FEEDS) {
    try {
      const r = await fetch(feed.url, {
        headers: { 'User-Agent': 'TetraPak-Monitor/1.0' },
        timeout: 8000
      });
      if (!r.ok) continue;
      const xml  = await r.text();
      const parsed = await parser.parseStringPromise(xml);

      const channel = parsed?.rss?.channel || parsed?.feed;
      if (!channel) continue;

      const items = channel.item || channel.entry || [];
      const arr   = Array.isArray(items) ? items : [items];

      arr.slice(0, 20).forEach(item => {
        const title   = item.title?._ || item.title || '';
        const link    = item.link?._ || item.link || '';
        const pubDate = item.pubDate || item.updated || item['dc:date'] || '';
        const desc    = item.description?._ || item.description || item.summary || '';
        results.push({
          source:   feed.name,
          title:    String(title).trim(),
          link:     String(link).trim(),
          pubDate:  String(pubDate).trim(),
          summary:  String(desc).replace(/<[^>]+>/g, '').trim().slice(0, 300)
        });
      });
      log(`RSS OK: ${feed.name} (${arr.length} items)`);
    } catch (err) {
      log(`RSS error ${feed.name}: ${err.message}`);
    }
  }

  res.json({ results, fetchedAt: new Date().toISOString() });
});

// ── Catch-all → index.html ─────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`Tetra Pak Band Monitor corriendo en http://localhost:${PORT}`);
  log(`Presione Ctrl+C para detener.`);
});
