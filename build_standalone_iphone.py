"""
build_standalone_iphone.py — Optimizado para Safari en iPhone

Estrategia:
- Divide datos en chunks pequeños (< 50KB cada uno)
- Usa flag "data ready" para esperar carga
- Mejor logging para debug
"""

import json
import os
import datetime
import re
import math

BASE = os.path.dirname(os.path.abspath(__file__))

def rf(name):
    with open(os.path.join(BASE, name), encoding='utf-8') as f:
        return f.read()

# ── Cargar datos ──────────────────────────────────────────────────────────────

data_path = os.path.join(BASE, 'data', 'bcra_a3500.json')
with open(data_path, encoding='utf-8') as f:
    embedded_data = json.load(f)

last_date  = embedded_data[-1]['date'] if embedded_data else 'N/A'
built_at   = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
num_records = len(embedded_data)

print(f"Datos: {num_records} registros, ultimo: {last_date}")

# ── Dividir en chunks ─────────────────────────────────────────────────────────

chunk_size = 500  # ~50KB por chunk
chunks = []
for i in range(0, len(embedded_data), chunk_size):
    chunk = embedded_data[i:i+chunk_size]
    chunks.append(chunk)

print(f"Dividido en {len(chunks)} chunks de ~{chunk_size} registros cada uno")

# Generar código para inicializar chunks
chunks_code = "window.STANDALONE_DATA_CHUNKS = [\n"
for i, chunk in enumerate(chunks):
    chunk_json = json.dumps(chunk, ensure_ascii=False, separators=(',', ':'))
    chunks_code += f"  {chunk_json},\n"
chunks_code += "];\n"
chunks_code += f"window.STANDALONE_DATA = [].concat(...window.STANDALONE_DATA_CHUNKS);\n"
chunks_code += f"window.STANDALONE_DATA_READY = true;\n"

# ── Leer fuentes ──────────────────────────────────────────────────────────────

css         = rf('styles.css')
utils_js    = rf('utils.js')
rules_js    = rf('rulesEngine.js')
prob_js     = rf('probabilityEngine.js')
news_js     = rf('newsService.js')
charts_js   = rf('charts.js')
app_js      = rf('app.js')

# ── DataService mejorado para iPhone ──────────────────────────────────────────

standalone_ds = r"""
/**
 * dataService.js — Standalone para iPhone
 */
'use strict';

const DataService = (() => {

  const CACHE_KEY_DATA  = 'tp_band_data';
  const CACHE_KEY_META  = 'tp_band_meta';
  const CACHE_TTL_HOURS = 4;
  const BCRA_API        = 'https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones';

  let _data      = [];
  let _lastFetch = null;
  let _log       = [];

  function addLog(msg, level = 'info') {
    const entry = { ts: new Date().toISOString(), msg, level };
    _log.push(entry);
    if (_log.length > 200) _log.shift();
    const el = document.getElementById('log-output');
    if (el) {
      const line = document.createElement('div');
      line.className = `log-${level}`;
      line.textContent = `[${entry.ts.slice(11,19)}] ${msg}`;
      el.prepend(line);
      while (el.children.length > 50) el.removeChild(el.lastChild);
    }
    console[level === 'error' ? 'error' : 'log'](`[DataService] ${msg}`);
  }

  function getEmbeddedData() {
    try {
      if (window.STANDALONE_DATA_READY && window.STANDALONE_DATA && window.STANDALONE_DATA.length > 0) {
        addLog(`Datos embebidos: ${window.STANDALONE_DATA.length} registros cargados`);
        return window.STANDALONE_DATA;
      } else {
        addLog('ERROR: Datos embebidos no disponibles o incompletos', 'error');
        console.warn('STANDALONE_DATA_READY:', window.STANDALONE_DATA_READY);
        console.warn('STANDALONE_DATA length:', window.STANDALONE_DATA ? window.STANDALONE_DATA.length : 'undefined');
        return [];
      }
    } catch (e) {
      addLog(`ERROR cargando datos: ${e.message}`, 'error');
      console.error(e);
      return [];
    }
  }

  async function fetchDayBCRA(fecha) {
    try {
      const r = await fetch(`${BCRA_API}?fecha=${fecha}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      if (!r.ok) return null;
      const json = await r.json();
      const det = json?.results?.detalle || [];
      let bna = null;
      for (const item of det) {
        if (item.codigoMoneda === 'USD' && item.tipoCotizacion > 0) {
          bna = item.tipoCotizacion;
          break;
        }
      }
      if (!bna) return null;
      return { date: fecha, value: Utils.roundTo(bna, 4) };
    } catch (e) {
      return null;
    }
  }

  async function updateFromBCRA(base) {
    if (!base || base.length === 0) return base;
    const lastDate = base[base.length - 1].date;
    const today = Utils.formatDate(new Date());
    if (lastDate >= today) return base;

    const missing = [];
    const d = Utils.toDate(lastDate);
    d.setDate(d.getDate() + 1);
    const end = new Date(today);
    while (d <= end) {
      if (d.getDay() !== 0 && d.getDay() !== 6) missing.push(Utils.formatDate(new Date(d)));
      d.setDate(d.getDate() + 1);
    }

    if (missing.length === 0 || missing.length > 30) return base;

    addLog(`Actualizando ${missing.length} dia(s)...`);
    const cache = new Map(base.map(x => [x.date, x]));
    let fetched = 0;

    const results = await Promise.allSettled(missing.map(f => fetchDayBCRA(f)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        cache.set(r.value.date, r.value);
        fetched++;
      }
    }
    if (fetched > 0) addLog(`+${fetched} nuevos.`);
    return Array.from(cache.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  async function loadData(forceRefresh = false) {
    addLog('Cargando datos...');

    let data = getEmbeddedData();
    if (data.length === 0) {
      addLog('ERROR: Sin datos embebidos', 'error');
      return [];
    }

    if (forceRefresh) {
      try {
        data = await updateFromBCRA(data);
      } catch (e) {
        addLog(`Actualizacion no disponible`, 'warn');
      }
    }

    _data = data;
    _lastFetch = new Date().toISOString();
    Utils.saveToLocalStorage(CACHE_KEY_DATA, data);
    Utils.saveToLocalStorage(CACHE_KEY_META, {
      lastFetch: _lastFetch, count: data.length, isDemo: false, source: 'standalone'
    });
    return data;
  }

  function getData() { return _data; }
  function getLastFetch() { return _lastFetch; }
  function getLogs() { return _log; }
  function clearCache() {
    Utils.removeFromLocalStorage(CACHE_KEY_DATA);
    Utils.removeFromLocalStorage(CACHE_KEY_META);
    _data = [];
    addLog('Cache limpiada.');
  }
  function getLastNValidDays(n, upToDate = null) {
    let arr = _data;
    if (upToDate) arr = arr.filter(d => d.date <= upToDate);
    return arr.slice(-n);
  }
  function getDataRange() {
    if (_data.length === 0) return { from: null, to: null };
    return { from: _data[0].date, to: _data[_data.length-1].date };
  }
  function getDataInRange(from, to) {
    return _data.filter(d => d.date >= from && d.date <= to);
  }
  function getLatestValue() {
    return _data.length ? _data[_data.length-1] : null;
  }
  function generateDemoData() {
    const data = []; let price = 800;
    const start = new Date(2022, 0, 3), end = new Date();
    let d = new Date(start);
    const drift = 0.0012, vol = 0.003;
    while (d <= end) {
      if (Utils.isValidTradingDay(d)) {
        price = price * (1 + drift + (Math.random() - 0.48) * vol * 2);
        data.push({ date: Utils.formatDate(d), value: Utils.roundTo(price, 2) });
      }
      d.setDate(d.getDate() + 1);
    }
    _data = data;
    return data;
  }
  function isDemo() { return false; }

  return { loadData, getData, getLastFetch, getLogs, clearCache, getLastNValidDays, getDataRange, getDataInRange, getLatestValue, generateDemoData, isDemo, addLog };
})();
window.DataService = DataService;
"""

# ── Obtener body de index.html ────────────────────────────────────────────────

index_html = rf('index.html')
body_match = re.search(r'<body>(.*?)</body>', index_html, re.DOTALL)
body_content = body_match.group(1) if body_match else index_html

# ── HTML final ────────────────────────────────────────────────────────────────

html_out = f"""<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Banda Monitor" />
  <title>Banda Cambiaria ARS/USD | Tetra Pak Argentina</title>

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

  <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>

  <style>
{css}
  </style>

  <!-- Datos embebidos en chunks -->
  <!-- Generado: {built_at} | Registros: {num_records} | Ultimo: {last_date} | Chunks: {len(chunks)} -->
  <script>
    window.STANDALONE_DATA_CHUNKS = [];
    window.STANDALONE_DATA = [];
    window.STANDALONE_DATA_READY = false;
    window.STANDALONE_BUILD = {{ date: '{built_at}', records: {num_records}, lastDataDate: '{last_date}' }};
  </script>

  <script>
{chunks_code}
  </script>

</head>
<body>

<div id="standalone-badge" style="
  position:fixed; bottom:10px; right:10px; z-index:9998;
  background:#1e293b; color:#94a3b8; font-size:.65rem;
  padding:4px 8px; border-radius:20px; font-family:monospace;
  opacity:.75; pointer-events:none;
">
  {last_date} | {num_records} reg
</div>

{body_content}

<!-- Scripts inline -->
<script>
/* ===== utils.js ===== */
{utils_js}
</script>
<script>
/* ===== dataService.js ===== */
{standalone_ds}
</script>
<script>
/* ===== rulesEngine.js ===== */
{rules_js}
</script>
<script>
/* ===== probabilityEngine.js ===== */
{prob_js}
</script>
<script>
/* ===== newsService.js ===== */
{news_js}
</script>
<script>
/* ===== charts.js ===== */
{charts_js}
</script>
<script>
/* ===== app.js ===== */
{app_js}
</script>

<script>
  console.log('STANDALONE_DATA_READY:', window.STANDALONE_DATA_READY);
  console.log('STANDALONE_DATA length:', window.STANDALONE_DATA.length);

  function waitForLibs(cb, retries = 50) {{
    if (typeof Plotly !== 'undefined' && window.STANDALONE_DATA_READY && window.STANDALONE_DATA.length > 0) {{
      cb();
      return;
    }}
    if (retries <= 0) {{
      console.error('Timeout esperando librerías o datos');
      cb();
      return;
    }}
    setTimeout(() => waitForLibs(cb, retries - 1), 100);
  }}
</script>

</body>
</html>"""

# Limpiar
html_out = re.sub(r'<script src="(?:utils|dataService|rulesEngine|probabilityEngine|newsService|charts|app)\.js"></script>\s*', '', html_out)
html_out = re.sub(r'<!-- Esperar a Plotly.*?</script>\s*', '', html_out, flags=re.DOTALL)

# ── Guardar ───────────────────────────────────────────────────────────────────

out_path = os.path.join(BASE, 'banda_monitor.html')
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(html_out)

size_kb = os.path.getsize(out_path) / 1024
print(f"Generado: banda_monitor.html")
print(f"  Tamanio: {size_kb:.0f} KB")
print(f"  Chunks: {len(chunks)}")
print(f"  Compatible: iPhone, Android, desktop")
print()
print("OK Listo. Abre en Safari del iPhone.")
