/**
 * dataService.js — Servicio de datos
 * Descarga, normaliza y cachea el tipo de cambio mayorista BCRA (COM A 3500).
 * Fuente primaria: API BCRA v2 (via proxy local).
 * Fallback: caché localStorage.
 */

'use strict';

const DataService = (() => {

  // ── Configuración ─────────────────────────────────────────────────────────

  const BCRA_VARIABLE_ID  = 4;          // Tipo de Cambio de Referencia COM A 3500
  const CACHE_KEY_DATA    = 'tp_band_data';
  const CACHE_KEY_META    = 'tp_band_meta';
  const CACHE_TTL_HOURS   = 4;          // Refresca si cache tiene más de 4 horas
  const BASE_PROXY        = 'http://localhost:3000';
  const HISTORY_START     = '2020-01-01';

  let _data     = [];   // Array de { date, value } ordenado ASC
  let _lastFetch = null;
  let _log      = [];

  // ── Logging interno ───────────────────────────────────────────────────────

  function addLog(msg, level = 'info') {
    const entry = { ts: new Date().toISOString(), msg, level };
    _log.push(entry);
    if (_log.length > 200) _log.shift();
    const el = document.getElementById('log-output');
    if (el) {
      const line = document.createElement('div');
      line.className = `log-${level}`;
      line.textContent = `[${entry.ts.slice(11, 19)}] ${msg}`;
      el.prepend(line);
      // Limitar visualmente
      while (el.children.length > 50) el.removeChild(el.lastChild);
    }
    console[level === 'error' ? 'error' : 'log'](`[DataService] ${msg}`);
  }

  // ── Fuente 1: Archivo local generado por fetch_data.py ───────────────────

  /**
   * Carga datos desde el archivo local data/bcra_a3500.json (servido estáticamente).
   * Este es el método más rápido y confiable cuando el proxy está corriendo.
   */
  async function fetchLocalFile() {
    const url = `${BASE_PROXY}/api/bcra/local`;
    addLog(`Cargando datos locales: ${url}`);
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Local file HTTP ${r.status}`);
    const json = await r.json();
    if (json.error) throw new Error(json.error);
    // El archivo local ya está normalizado: [{date, value}]
    return json.results || [];
  }

  /**
   * Solicita al servidor que actualice el archivo local incrementalmente.
   */
  async function triggerServerRefresh() {
    addLog('Solicitando actualización incremental al servidor...');
    try {
      const r = await fetch(`${BASE_PROXY}/api/bcra/refresh`, { signal: AbortSignal.timeout(130000) });
      const json = await r.json();
      addLog(`Actualización completada: ${json.count} registros`);
      return json.ok;
    } catch (e) {
      addLog(`Refresh falló: ${e.message}`, 'warn');
      return false;
    }
  }

  // ── Fuente 2 (fallback): Proxy BCRA API ──────────────────────────────────

  /**
   * Intenta descarga vía proxy local (API BCRA — ya deprecada en v2).
   */
  async function fetchViaBCRAProxy(desde, hasta) {
    const url = `${BASE_PROXY}/api/bcra/serie/${BCRA_VARIABLE_ID}/${desde}/${hasta}`;
    addLog(`Fetching BCRA via proxy: ${url}`);
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Proxy HTTP ${r.status}`);
    const json = await r.json();
    if (json.error) throw new Error(json.error);
    return json;
  }

  /**
   * Normaliza la respuesta de la API BCRA al formato interno.
   * Retorna array de { date: 'YYYY-MM-DD', value: number }
   */
  function normalizeBCRAResponse(json) {
    const results = json?.results || json?.data || [];
    const normalized = [];

    for (const item of results) {
      const dateRaw  = item.fecha || item.date || item.Fecha;
      const valRaw   = item.valor ?? item.value ?? item.Valor;

      if (!dateRaw || valRaw === null || valRaw === undefined) continue;

      const date  = Utils.formatDate(Utils.toDate(dateRaw));
      const value = Utils.parseArgNumber(valRaw);

      if (!date || value === null || value <= 0) continue;
      if (Utils.isWeekend(date)) continue;

      normalized.push({ date, value });
    }

    return deduplicateAndSort(normalized);
  }

  function deduplicateAndSort(arr) {
    const map = new Map();
    for (const item of arr) {
      // En caso de duplicado, conservar el último
      map.set(item.date, item.value);
    }
    return Array.from(map.entries())
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // ── Carga principal ───────────────────────────────────────────────────────

  /**
   * Descarga todos los datos históricos.
   * Orden de prioridad:
   *   1. Archivo local JSON (servido por el proxy Python — data/bcra_a3500.json)
   *   2. Cache localStorage (si es reciente)
   *   3. API BCRA via proxy (fallback legacy)
   *   4. Demo data
   */
  async function fetchAllData() {
    addLog('Iniciando carga de datos...');

    // 1. Intentar archivo local (fuente real más rápida)
    try {
      const localData = await fetchLocalFile();
      if (localData && localData.length > 10) {
        addLog(`Datos locales OK: ${localData.length} registros`);
        _data      = localData;
        _lastFetch = new Date().toISOString();
        Utils.saveToLocalStorage(CACHE_KEY_DATA, localData);
        Utils.saveToLocalStorage(CACHE_KEY_META, {
          lastFetch: _lastFetch, count: localData.length, isDemo: false, source: 'local'
        });
        return localData;
      }
    } catch (e1) {
      addLog(`Archivo local no disponible: ${e1.message}`, 'warn');
    }

    // 2. Cache localStorage reciente
    const meta = Utils.loadFromLocalStorage(CACHE_KEY_META, {});
    if (meta.lastFetch && !meta.isDemo) {
      const hrs = (Date.now() - new Date(meta.lastFetch).getTime()) / (1000 * 3600);
      if (hrs < CACHE_TTL_HOURS) {
        addLog(`Usando cache localStorage (${hrs.toFixed(1)}h)`);
        return loadFromCache();
      }
    }

    // 3. Fallback: API BCRA via proxy (puede fallar si la v2 está deprecada)
    try {
      const today   = Utils.formatDate(new Date());
      const rawJson = await fetchViaBCRAProxy(HISTORY_START, today);
      const normalized = normalizeBCRAResponse(rawJson);
      if (normalized.length > 10) {
        addLog(`API BCRA OK: ${normalized.length} registros`);
        _data      = normalized;
        _lastFetch = new Date().toISOString();
        Utils.saveToLocalStorage(CACHE_KEY_DATA, normalized);
        Utils.saveToLocalStorage(CACHE_KEY_META, {
          lastFetch: _lastFetch, count: normalized.length, isDemo: false, source: 'api'
        });
        return normalized;
      }
    } catch (e3) {
      addLog(`API BCRA falló: ${e3.message}`, 'warn');
    }

    // 4. Cache vieja (cualquier antigüedad)
    const oldCache = loadFromCache();
    if (oldCache.length > 10) return oldCache;

    // Sin datos reales → demo
    addLog('Sin datos reales disponibles. Usando demo.', 'error');
    return [];
  }

  /**
   * Carga desde caché localStorage.
   */
  function loadFromCache() {
    const cached = Utils.loadFromLocalStorage(CACHE_KEY_DATA, []);
    const meta   = Utils.loadFromLocalStorage(CACHE_KEY_META, {});
    if (cached.length > 0) {
      addLog(`Cache: ${cached.length} registros (última actualización: ${meta.lastFetch || 'desconocida'})`);
      _data      = cached;
      _lastFetch = meta.lastFetch || null;
      return cached;
    }
    addLog('Sin datos en cache. Se necesitan datos para continuar.', 'error');
    _data = [];
    return [];
  }

  /**
   * Carga inteligente: si cache es reciente, no vuelve a bajar.
   * forceRefresh=true también actualiza el archivo local via el servidor.
   */
  async function loadData(forceRefresh = false) {
    const meta = Utils.loadFromLocalStorage(CACHE_KEY_META, {});

    if (!forceRefresh && meta.lastFetch && !meta.isDemo) {
      const hoursSince = (Date.now() - new Date(meta.lastFetch).getTime()) / (1000 * 3600);
      if (hoursSince < CACHE_TTL_HOURS) {
        addLog(`Cache reciente (${hoursSince.toFixed(1)}h). Cargando desde cache.`);
        return loadFromCache();
      }
    }

    if (forceRefresh) {
      // Pedir al servidor que actualice el archivo local incrementalmente
      await triggerServerRefresh();
    }

    return await fetchAllData();
  }

  // ── Accesores ─────────────────────────────────────────────────────────────

  function getData()              { return _data; }
  function getLastFetch()         { return _lastFetch; }
  function getLogs()              { return _log; }
  function clearCache()           {
    Utils.removeFromLocalStorage(CACHE_KEY_DATA);
    Utils.removeFromLocalStorage(CACHE_KEY_META);
    _data = [];
    addLog('Cache limpiada.');
  }

  /**
   * Retorna los últimos N días hábiles con dato válido.
   */
  function getLastNValidDays(n, upToDate = null) {
    let arr = _data;
    if (upToDate) arr = arr.filter(d => d.date <= upToDate);
    // Tomar los últimos N
    return arr.slice(-n);
  }

  /**
   * Retorna rango de fechas del dataset.
   */
  function getDataRange() {
    if (_data.length === 0) return { from: null, to: null };
    return { from: _data[0].date, to: _data[_data.length - 1].date };
  }

  /**
   * Filtra datos a un rango de fechas.
   */
  function getDataInRange(from, to) {
    return _data.filter(d => d.date >= from && d.date <= to);
  }

  /**
   * Valor más reciente.
   */
  function getLatestValue() {
    if (_data.length === 0) return null;
    return _data[_data.length - 1];
  }

  // ── Carga de datos de demo (fallback offline) ─────────────────────────────
  /**
   * Si no hay datos disponibles, genera datos sintéticos para demostración.
   * El centro parte de 1444.8 y simula un crawling peg.
   */
  function generateDemoData() {
    addLog('Generando datos de demostración (sin fuente real disponible)', 'warn');
    const data  = [];
    let   price = 800;
    const start = new Date(2022, 0, 3);  // 3 enero 2022
    const end   = new Date();
    let   d     = new Date(start);

    const drift     = 0.0012;   // ~0.12% diario = ~30% anual
    const vol       = 0.003;    // 0.3% volatilidad diaria

    while (d <= end) {
      if (Utils.isValidTradingDay(d)) {
        const shock = (Math.random() - 0.48) * vol * 2;
        price = price * (1 + drift + shock);
        data.push({ date: Utils.formatDate(d), value: Utils.roundTo(price, 2) });
      }
      d.setDate(d.getDate() + 1);
    }

    _data      = data;
    _lastFetch = new Date().toISOString() + ' (DEMO)';
    Utils.saveToLocalStorage(CACHE_KEY_DATA, data);
    Utils.saveToLocalStorage(CACHE_KEY_META, { lastFetch: _lastFetch, count: data.length, isDemo: true });
    addLog(`Datos demo: ${data.length} días hábiles`);
    return data;
  }

  /**
   * Retorna true si los datos cargados son demo.
   */
  function isDemo() {
    const meta = Utils.loadFromLocalStorage(CACHE_KEY_META, {});
    return !!meta.isDemo;
  }

  // ── Exportación ───────────────────────────────────────────────────────────

  return {
    loadData,
    getData,
    getLastFetch,
    getLogs,
    clearCache,
    getLastNValidDays,
    getDataRange,
    getDataInRange,
    getLatestValue,
    generateDemoData,
    isDemo,
    addLog
  };

})();

window.DataService = DataService;
