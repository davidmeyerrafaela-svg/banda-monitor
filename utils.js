/**
 * utils.js — Utilidades generales
 * Manejo de fechas (calendario Argentina), estadística, formateo y persistencia.
 */

'use strict';

const Utils = (() => {

  // ── Feriados Argentina ────────────────────────────────────────────────────
  // Lista de feriados nacionales fijos + algunos trasladables (2020-2027).
  // Formato: 'YYYY-MM-DD'

  const FIXED_HOLIDAYS_BY_MONTH_DAY = [
    '01-01', // Año Nuevo
    '04-02', // Día del Veterano y Caídos en Malvinas
    '05-01', // Día del Trabajador
    '05-25', // Revolución de Mayo
    '06-17', // Paso a la Inmortalidad del Gral. Güemes
    '06-20', // Paso a la Inmortalidad del Gral. Belgrano (Día de la Bandera)
    '07-09', // Día de la Independencia
    '12-08', // Inmaculada Concepción
    '12-25', // Navidad
  ];

  // Feriados con fecha variable o específica por año
  const SPECIFIC_HOLIDAYS = new Set([
    // Carnaval 2024
    '2024-02-12','2024-02-13',
    // Semana Santa 2024
    '2024-03-28','2024-03-29',
    // San Martín 2024 (3er lunes agosto)
    '2024-08-19',
    // Día de la Diversidad Cultural 2024 (2do lunes oct)
    '2024-10-14',
    // Soberanía Nacional 2024 (4to lunes nov)
    '2024-11-18',
    // Puente 2024
    '2024-06-21',

    // Carnaval 2025
    '2025-03-03','2025-03-04',
    // Semana Santa 2025
    '2025-04-17','2025-04-18',
    // San Martín 2025
    '2025-08-18',
    // Diversidad Cultural 2025
    '2025-10-13',
    // Soberanía Nacional 2025
    '2025-11-24',

    // Carnaval 2026
    '2026-02-16','2026-02-17',
    // Semana Santa 2026
    '2026-04-02','2026-04-03',
    // San Martín 2026
    '2026-08-17',
    // Diversidad Cultural 2026
    '2026-10-12',
    // Soberanía Nacional 2026
    '2026-11-23',

    // Feriados puente y extraordinarios comunes
    '2024-07-08','2024-07-10',
    '2025-05-02',
  ]);

  /**
   * Retorna true si la fecha es feriado nacional argentino.
   * @param {Date|string} date
   */
  function isHoliday(date) {
    const d    = toDate(date);
    const iso  = formatDate(d);
    if (SPECIFIC_HOLIDAYS.has(iso)) return true;
    const md   = iso.slice(5); // 'MM-DD'
    return FIXED_HOLIDAYS_BY_MONTH_DAY.includes(md);
  }

  /**
   * Retorna true si es sábado (6) o domingo (0).
   */
  function isWeekend(date) {
    const d = toDate(date);
    const day = d.getDay();
    return day === 0 || day === 6;
  }

  /**
   * Retorna true si es un día hábil bursátil (no fin de semana, no feriado).
   */
  function isValidTradingDay(date) {
    return !isWeekend(date) && !isHoliday(date);
  }

  // ── Manejo de fechas ──────────────────────────────────────────────────────

  /**
   * Convierte string 'YYYY-MM-DD' o Date a Date (mediodía UTC para evitar tz issues).
   */
  function toDate(d) {
    if (d instanceof Date) return d;
    if (typeof d === 'string') {
      const [y, m, day] = d.split('-').map(Number);
      return new Date(y, m - 1, day, 12, 0, 0);
    }
    return new Date(d);
  }

  /**
   * Formatea Date a 'YYYY-MM-DD'.
   */
  function formatDate(d) {
    const date = toDate(d);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * Formatea Date a 'DD/MM/YYYY' (display).
   */
  function formatDateDisplay(d) {
    const date = toDate(d);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${day}/${m}/${y}`;
  }

  /**
   * Retorna true si d1 < d2 (solo fecha, sin hora).
   */
  function dateBefore(d1, d2) {
    return formatDate(d1) < formatDate(d2);
  }

  /**
   * Agrega N días calendario a una fecha.
   */
  function addDays(date, n) {
    const d = toDate(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  /**
   * Diferencia en días calendario entre dos fechas.
   */
  function daysDiff(d1, d2) {
    const a = toDate(d1);
    const b = toDate(d2);
    return Math.round((b - a) / (1000 * 60 * 60 * 24));
  }

  /**
   * Retorna el primer día del año en curso.
   */
  function startOfYear(date) {
    const d = toDate(date);
    return new Date(d.getFullYear(), 0, 1, 12, 0, 0);
  }

  /**
   * Retorna fecha N meses atrás.
   */
  function monthsAgo(date, n) {
    const d = toDate(date);
    d.setMonth(d.getMonth() - n);
    return d;
  }

  // ── Formateo numérico ─────────────────────────────────────────────────────

  /**
   * Formatea número con separadores Argentina (punto miles, coma decimal).
   */
  function formatNumber(n, decimals = 2) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    return new Intl.NumberFormat('es-AR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(n);
  }

  function formatPercent(n, decimals = 2) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    const sign = n > 0 ? '+' : '';
    return `${sign}${formatNumber(n * 100, decimals)}%`;
  }

  function formatPercentValue(n, decimals = 2) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    const sign = n > 0 ? '+' : '';
    return `${sign}${formatNumber(n, decimals)}%`;
  }

  /**
   * Parsea número argentino: "1.444,80" → 1444.80
   */
  function parseArgNumber(str) {
    if (typeof str === 'number') return str;
    if (!str) return null;
    // Si tiene punto de miles y coma decimal
    const s = String(str).trim().replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  // ── Estadística ───────────────────────────────────────────────────────────

  function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function variance(arr) {
    if (!arr || arr.length < 2) return 0;
    const m = mean(arr);
    return arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  }

  function stdDev(arr) {
    return Math.sqrt(variance(arr));
  }

  /**
   * Regresión lineal simple. Retorna { slope, intercept, r2 }.
   */
  function linearRegression(xs, ys) {
    const n  = xs.length;
    if (n < 2) return { slope: 0, intercept: ys[0] || 0, r2: 0 };
    const mx = mean(xs);
    const my = mean(ys);
    let sxy  = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    const slope     = sxx !== 0 ? sxy / sxx : 0;
    const intercept = my - slope * mx;
    const r2        = syy !== 0 ? (sxy ** 2) / (sxx * syy) : 0;
    return { slope, intercept, r2 };
  }

  /**
   * Estandariza array (z-score).
   */
  function standardize(arr) {
    const m = mean(arr);
    const s = stdDev(arr);
    if (s === 0) return arr.map(() => 0);
    return arr.map(x => (x - m) / s);
  }

  /**
   * Normaliza array a [0,1].
   */
  function normalize(arr) {
    const mn = Math.min(...arr);
    const mx = Math.max(...arr);
    const range = mx - mn;
    if (range === 0) return arr.map(() => 0.5);
    return arr.map(x => (x - mn) / range);
  }

  /**
   * Calcula retorno porcentual entre dos valores.
   */
  function pctReturn(v1, v2) {
    if (!v1 || v1 === 0) return 0;
    return (v2 - v1) / v1;
  }

  /**
   * Retorna percentil p de un array ordenado.
   */
  function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx    = (p / 100) * (sorted.length - 1);
    const lo     = Math.floor(idx);
    const hi     = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // ── Persistencia local ────────────────────────────────────────────────────

  function saveToLocalStorage(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      console.warn('LocalStorage save error:', e);
      return false;
    }
  }

  function loadFromLocalStorage(key, defaultValue = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : defaultValue;
    } catch (e) {
      console.warn('LocalStorage load error:', e);
      return defaultValue;
    }
  }

  function removeFromLocalStorage(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  // ── Clamp y utilidades numéricas ──────────────────────────────────────────

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function roundTo(n, decimals) {
    const factor = 10 ** decimals;
    return Math.round(n * factor) / factor;
  }

  function sigmoid(z) {
    return 1 / (1 + Math.exp(-z));
  }

  // ── Debounce ──────────────────────────────────────────────────────────────

  function debounce(fn, wait) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  // ── Exportación ───────────────────────────────────────────────────────────

  return {
    isHoliday, isWeekend, isValidTradingDay,
    toDate, formatDate, formatDateDisplay, dateBefore, addDays, daysDiff,
    startOfYear, monthsAgo,
    formatNumber, formatPercent, formatPercentValue, parseArgNumber,
    mean, variance, stdDev, linearRegression, standardize, normalize,
    pctReturn, percentile,
    saveToLocalStorage, loadFromLocalStorage, removeFromLocalStorage,
    clamp, roundTo, sigmoid, debounce
  };
})();

// Exponer globalmente
window.Utils = Utils;
