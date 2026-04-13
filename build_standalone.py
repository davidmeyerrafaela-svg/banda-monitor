"""
build_standalone.py — Genera banda_monitor.html (archivo único sin servidor)

Uso:
  python build_standalone.py

Genera: banda_monitor.html
  - Sin Node.js, sin Python en el destino, sin instalaciones.
  - Solo se abre en cualquier navegador moderno.
  - Datos embebidos hasta la fecha del último fetch_data.py.
  - Al abrir, intenta actualizar automáticamente desde la API del BCRA
    (requiere conexión a internet; si falla, usa datos embebidos).
  - Gráficos via Plotly CDN (requiere internet para la primera carga;
    luego el navegador los cachea).
"""

import json
import os
import datetime
import re

BASE = os.path.dirname(os.path.abspath(__file__))

def rf(name):
    """Lee un archivo relativo al directorio del script."""
    with open(os.path.join(BASE, name), encoding='utf-8') as f:
        return f.read()

# ── Cargar datos embebidos ─────────────────────────────────────────────────────

# Cargar datos BCRA
data_path = os.path.join(BASE, 'data', 'bcra_a3500.json')
with open(data_path, encoding='utf-8') as f:
    embedded_data = json.load(f)

last_date  = embedded_data[-1]['date'] if embedded_data else 'N/A'
built_at   = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
num_records = len(embedded_data)

print(f"Datos embebidos: {num_records} registros, ultimo: {last_date}")

# Cargar noticias si existen
embedded_news = {}
news_path = os.path.join(BASE, 'data', 'news.json')
if os.path.exists(news_path):
    try:
        with open(news_path, encoding='utf-8') as f:
            embedded_news = json.load(f)
        print(f"Noticias embebidas: {len(embedded_news.get('results', []))} items")
    except Exception as e:
        print(f"Advertencia: No se pudo cargar noticias: {e}")
else:
    print("Advertencia: news.json no encontrado. Las noticias se cargarán desde API.")

# ── Leer fuentes ──────────────────────────────────────────────────────────────

css         = rf('styles.css')
utils_js    = rf('utils.js')
rules_js    = rf('rulesEngine.js')
prob_js     = rf('probabilityEngine.js')
news_js     = rf('newsService.js')
charts_js   = rf('charts.js')
app_js      = rf('app.js')

# ── DataService standalone (sin proxy, sin servidor) ──────────────────────────
# Usa datos embebidos como base y trata de actualizar desde BCRA directamente.

standalone_ds = r"""
/**
 * dataService.js — Modo standalone (sin servidor proxy)
 * Fuente primaria: STANDALONE_DATA embebido en este archivo.
 * Actualización: API BCRA directa (si CORS lo permite).
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

  // ── 1. Datos embebidos ────────────────────────────────────────────────────

  function getEmbeddedData() {
    const d = window.STANDALONE_DATA || [];
    if (d.length > 0) {
      addLog(`Datos embebidos: ${d.length} registros (hasta ${d[d.length-1].date})`);
    }
    return d;
  }

  // ── 2. Actualizar desde BCRA API directamente ─────────────────────────────

  async function fetchDayBCRA(fecha) {
    const r = await fetch(`${BCRA_API}?fecha=${fecha}`, {
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(8000)
    });
    if (!r.ok) return null;
    const json = await r.json();
    const det  = json?.results?.detalle || [];
    let bna = null, ref = null;
    for (const item of det) {
      if (item.codigoMoneda === 'USD' && item.tipoCotizacion > 0) bna = item.tipoCotizacion;
      if (item.codigoMoneda === 'REF' && item.tipoCotizacion > 0) ref = item.tipoCotizacion;
    }
    if (!bna) return null;
    const rec = { date: fecha, value: Utils.roundTo(bna, 4) };
    if (ref)  rec.ref = Utils.roundTo(ref, 4);
    return rec;
  }

  async function updateFromBCRA(base) {
    if (!base || base.length === 0) return base;

    const lastDate = base[base.length - 1].date;
    const today    = Utils.formatDate(new Date());
    if (lastDate >= today) return base;

    // Generar días hábiles candidatos (hasta hoy)
    const missing = [];
    const d = Utils.toDate(lastDate);
    d.setDate(d.getDate() + 1);
    const end = new Date(today);
    while (d <= end) {
      if (d.getDay() !== 0 && d.getDay() !== 6) missing.push(Utils.formatDate(new Date(d)));
      d.setDate(d.getDate() + 1);
    }

    if (missing.length === 0) return base;
    if (missing.length > 30) {
      addLog(`${missing.length} días faltantes (> 30). Usá fetch_data.py para actualizar.`, 'warn');
      return base;
    }

    addLog(`Consultando ${missing.length} día(s) faltante(s) en BCRA...`);
    const cache = new Map(base.map(x => [x.date, x]));
    let fetched  = 0;

    const results = await Promise.allSettled(missing.map(f => fetchDayBCRA(f)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        cache.set(r.value.date, r.value);
        fetched++;
      }
    }

    if (fetched > 0) addLog(`Actualizados ${fetched} día(s) nuevos desde BCRA.`);
    else addLog('Sin datos nuevos desde BCRA (puede ser CORS o días sin operatoria).', 'warn');

    return Array.from(cache.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  // ── Carga principal ───────────────────────────────────────────────────────

  async function loadData(forceRefresh = false) {
    addLog('Cargando datos (modo standalone)...');

    // Cache reciente y no demo → usar directamente
    const meta = Utils.loadFromLocalStorage(CACHE_KEY_META, {});
    if (!forceRefresh && meta.lastFetch && !meta.isDemo) {
      const hrs = (Date.now() - new Date(meta.lastFetch).getTime()) / 3600000;
      if (hrs < CACHE_TTL_HOURS) {
        const cached = Utils.loadFromLocalStorage(CACHE_KEY_DATA, []);
        if (cached.length > 10) {
          addLog(`Cache reciente (${hrs.toFixed(1)}h). Usando cache local.`);
          _data = cached; _lastFetch = meta.lastFetch;
          return cached;
        }
      }
    }

    // Partir de datos embebidos
    let data = getEmbeddedData();

    // Intentar actualizar (puede fallar por CORS — es graceful)
    try {
      data = await updateFromBCRA(data);
    } catch (e) {
      addLog(`Actualización directa no disponible: ${e.message}`, 'warn');
    }

    if (data.length > 10) {
      _data = data;
      _lastFetch = new Date().toISOString();
      Utils.saveToLocalStorage(CACHE_KEY_DATA, data);
      Utils.saveToLocalStorage(CACHE_KEY_META, {
        lastFetch: _lastFetch, count: data.length, isDemo: false, source: 'standalone'
      });
      return data;
    }

    addLog('Sin datos reales. Usando demo.', 'error');
    return [];
  }

  function loadFromCache() {
    const cached = Utils.loadFromLocalStorage(CACHE_KEY_DATA, []);
    if (cached.length > 0) { _data = cached; return cached; }
    return [];
  }

  function getData()              { return _data; }
  function getLastFetch()         { return _lastFetch; }
  function getLogs()              { return _log; }
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
    addLog('Generando datos de demostracion', 'warn');
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
    _data = data; _lastFetch = new Date().toISOString() + ' (DEMO)';
    Utils.saveToLocalStorage(CACHE_KEY_DATA, data);
    Utils.saveToLocalStorage(CACHE_KEY_META, { lastFetch: _lastFetch, count: data.length, isDemo: true });
    return data;
  }
  function isDemo() { return !!(Utils.loadFromLocalStorage(CACHE_KEY_META, {}).isDemo); }

  return {
    loadData, getData, getLastFetch, getLogs, clearCache,
    getLastNValidDays, getDataRange, getDataInRange,
    getLatestValue, generateDemoData, isDemo, addLog
  };
})();
window.DataService = DataService;
"""

# ── Adaptar index.html para standalone ────────────────────────────────────────

index_html = rf('index.html')

# Quitar referencia a npm start en el banner demo
index_html = index_html.replace(
    'Para datos reales, iniciá el servidor proxy (<code>npm start</code>) con conexión a internet.',
    'Para datos actualizados regenerá el archivo con <code>build_standalone.py</code>.'
)

# ── Serializar datos embebidos (compacto, sin indent) ─────────────────────────

data_json = json.dumps(embedded_data, ensure_ascii=False, separators=(',', ':'))
news_json = json.dumps(embedded_news, ensure_ascii=False, separators=(',', ':'))

# ── Construir HTML final ──────────────────────────────────────────────────────

# Extraer solo el <body> y secciones relevantes del index.html
# para reconstruir el HTML completo con estilos y scripts inline.

# Obtener el contenido entre <body> y </body>
body_match = re.search(r'<body>(.*?)</body>', index_html, re.DOTALL)
body_content = body_match.group(1) if body_match else index_html

# Quitar <link> de Google Fonts del head y usar la versión inline
# (Se mantiene la CDN de Google Fonts para que cargue la fuente Inter)

html_out = f"""<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Banda Cambiaria ARS/USD | Tetra Pak Argentina</title>

  <!-- Google Fonts (requiere internet) -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

  <!-- Plotly.js (requiere internet; se cachea en el navegador) -->
  <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>

  <!-- ── Estilos inline ─────────────────────────── -->
  <style>
{css}
  </style>

  <!-- ── Datos embebidos ────────────────────────── -->
  <!-- Generado: {built_at} | Registros: {num_records} | Ultimo: {last_date} -->
  <script>
    window.STANDALONE_DATA = {data_json};
    window.STANDALONE_BUILD = {{ date: '{built_at}', records: {num_records}, lastDataDate: '{last_date}' }};
    window.EMBEDDED_NEWS = {news_json};
  </script>
</head>
<body>

<!-- Indicador de version standalone -->
<div id="standalone-badge" style="
  position:fixed; bottom:10px; right:10px; z-index:9998;
  background:#1e293b; color:#94a3b8; font-size:.68rem;
  padding:4px 10px; border-radius:20px; font-family:monospace;
  opacity:.75; pointer-events:none;
">
  Datos al {last_date} &middot; {num_records} reg.
</div>

{body_content}

<!-- ── Scripts inline (orden importante) ────────── -->
<script>
/* ===== utils.js ===== */
{utils_js}
</script>
<script>
/* ===== dataService.js (standalone) ===== */
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
  // Esperar Plotly y arrancar
  function waitForPlotly(cb, retries = 30) {{
    if (typeof Plotly !== 'undefined') {{ cb(); return; }}
    if (retries <= 0) {{ console.error('Plotly no disponible'); cb(); return; }}
    setTimeout(() => waitForPlotly(cb, retries - 1), 200);
  }}
</script>

</body>
</html>"""

# ── Quitar las etiquetas <script src="..."> del body (ya están inline) ─────────

html_out = re.sub(r'<script src="(?:utils|dataService|rulesEngine|probabilityEngine|newsService|charts|app)\.js"></script>\s*', '', html_out)

# Quitar el bloque waitForPlotly duplicado del body original
html_out = re.sub(
    r'<!-- Esperar a Plotly.*?</script>\s*',
    '',
    html_out,
    flags=re.DOTALL
)

# ── Guardar ────────────────────────────────────────────────────────────────────

out_path = os.path.join(BASE, 'banda_monitor.html')
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(html_out)

size_kb = os.path.getsize(out_path) / 1024
print(f"Generado: {out_path}")
print(f"  Tamanio: {size_kb:.0f} KB")
print(f"  Datos embebidos: {num_records} registros BNA (hasta {last_date})")
print(f"  Abrir directamente en el navegador (sin servidor).")
print()
print("Workflow recomendado:")
print("  1. python fetch_data.py --update   # actualiza el JSON")
print("  2. python build_standalone.py       # regenera banda_monitor.html")
print("  3. Compartir banda_monitor.html     # abrirlo en cualquier PC")
