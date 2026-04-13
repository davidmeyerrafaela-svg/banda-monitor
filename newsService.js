/**
 * newsService.js — Módulo de noticias y presión cambiaria
 *
 * Obtiene noticias económicas de Argentina vía proxy RSS.
 * Clasifica cada noticia: presión alcista / bajista / neutral sobre el USD oficial.
 * Genera un "News Pressure Score" entre -100 y +100.
 */

'use strict';

const NewsService = (() => {

  const CACHE_KEY  = 'tp_news_cache';
  const CACHE_TTL  = 6;   // horas

  // ── Diccionario de keywords ───────────────────────────────────────────────

  const BULLISH_KEYWORDS = [
    // Alta presión (peso 3)
    { kw: 'devaluación',       w: 3 },
    { kw: 'devalúa',           w: 3 },
    { kw: 'salto cambiario',   w: 3 },
    { kw: 'corrida cambiaria', w: 3 },
    { kw: 'crisis cambiaria',  w: 3 },
    { kw: 'default',           w: 3 },
    { kw: 'cepo se levanta',   w: 3 },
    // Presión media (peso 2)
    { kw: 'dólar sube',        w: 2 },
    { kw: 'sube el dólar',     w: 2 },
    { kw: 'presión cambiaria', w: 2 },
    { kw: 'brecha cambiaria',  w: 2 },
    { kw: 'reservas caen',     w: 2 },
    { kw: 'reservas bajan',    w: 2 },
    { kw: 'fuga de capitales', w: 2 },
    { kw: 'inflación',         w: 2 },
    { kw: 'suba del dólar',    w: 2 },
    { kw: 'tensión cambiaria', w: 2 },
    { kw: 'tipo de cambio sube',w:2 },
    { kw: 'emisión monetaria', w: 2 },
    { kw: 'déficit fiscal',    w: 2 },
    // Presión baja (peso 1)
    { kw: 'dólar mayorista',   w: 1 },
    { kw: 'demanda de divisas',w: 1 },
    { kw: 'cepo cambiario',    w: 1 },
    { kw: 'control de cambios',w: 1 },
    { kw: 'restricciones cambiarias', w: 1 },
    { kw: 'banco central vende', w: 1 },
    { kw: 'bcra vende',        w: 1 },
    { kw: 'tipo de cambio',    w: 1 },
  ];

  const BEARISH_KEYWORDS = [
    // Alta presión bajista (peso 3)
    { kw: 'liquidación del agro',  w: 3 },
    { kw: 'liquidación soja',      w: 3 },
    { kw: 'ingreso de divisas',    w: 3 },
    { kw: 'acuerdo fmi',           w: 3 },
    { kw: 'desembolso fmi',        w: 3 },
    // Presión media (peso 2)
    { kw: 'dólar baja',            w: 2 },
    { kw: 'baja el dólar',         w: 2 },
    { kw: 'calma cambiaria',       w: 2 },
    { kw: 'reservas suben',        w: 2 },
    { kw: 'reservas crecen',       w: 2 },
    { kw: 'banco central compra',  w: 2 },
    { kw: 'bcra compra',           w: 2 },
    { kw: 'exportaciones crecen',  w: 2 },
    { kw: 'superávit',             w: 2 },
    { kw: 'tipo de cambio baja',   w: 2 },
    { kw: 'cosecha récord',        w: 2 },
    { kw: 'ingreso de dólares',    w: 2 },
    { kw: 'sube tasa de interés',  w: 2 },
    { kw: 'tasa sube',             w: 2 },
    // Presión baja (peso 1)
    { kw: 'remonetización',        w: 1 },
    { kw: 'blanqueo',              w: 1 },
    { kw: 'estabilidad cambiaria', w: 1 },
    { kw: 'exportaciones',         w: 1 },
    { kw: 'campo liquida',         w: 1 },
    { kw: 'dólar blend',           w: 1 },
  ];

  // ── Scoring de una noticia ────────────────────────────────────────────────

  /**
   * Analiza el texto (título + resumen) y retorna clasificación e impacto.
   */
  function scoreNewsItem(item) {
    const text = (item.title + ' ' + (item.summary || '')).toLowerCase();

    let bullishScore = 0;
    let bearishScore = 0;

    for (const { kw, w } of BULLISH_KEYWORDS) {
      if (text.includes(kw)) bullishScore += w;
    }
    for (const { kw, w } of BEARISH_KEYWORDS) {
      if (text.includes(kw)) bearishScore += w;
    }

    const net = bullishScore - bearishScore;

    let direction, impact;
    if (Math.abs(net) < 1) {
      direction = 'neutral';
      impact    = 'bajo';
    } else if (net > 0) {
      direction = 'alcista';
      impact    = net >= 5 ? 'alto' : net >= 3 ? 'medio' : 'bajo';
    } else {
      direction = 'bajista';
      impact    = Math.abs(net) >= 5 ? 'alto' : Math.abs(net) >= 3 ? 'medio' : 'bajo';
    }

    const impactScore = { alto: 3, medio: 2, bajo: 1 }[impact] || 0;

    return {
      ...item,
      direction,
      impact,
      impactScore,
      bullishScore,
      bearishScore,
      score: net
    };
  }

  /**
   * Peso temporal de una noticia según su antigüedad.
   * Últimos 7 días: peso 1.0
   * 8-21 días: peso 0.5
   * >21 días: peso 0.2
   */
  function timeWeight(pubDate) {
    if (!pubDate) return 0.5;
    const now   = Date.now();
    const date  = new Date(pubDate).getTime();
    const daysDiff = (now - date) / (1000 * 60 * 60 * 24);
    if (isNaN(daysDiff) || daysDiff < 0) return 0.5;
    if (daysDiff <= 7)  return 1.0;
    if (daysDiff <= 21) return 0.5;
    return 0.2;
  }

  /**
   * Calcula el News Pressure Score agregado: -100 a +100.
   */
  function computeNewsPressureScore(scoredNews) {
    if (!scoredNews || scoredNews.length === 0) return 0;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const n of scoredNews) {
      const tw = timeWeight(n.pubDate);
      const pw = n.impactScore || 1;
      const weight = tw * pw;
      weightedSum += n.score * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return 0;
    const rawScore = weightedSum / totalWeight;
    // Normalizar a [-100, 100] usando una escala empírica (max score ~8)
    const normalized = Utils.clamp((rawScore / 8) * 100, -100, 100);
    return Utils.roundTo(normalized, 1);
  }

  // ── Fetch de noticias ─────────────────────────────────────────────────────

  /**
   * Descarga noticias vía proxy, o carga del caché.
   */
  async function fetchNews(forceRefresh = false) {
    // Verificar caché
    if (!forceRefresh) {
      const cached = Utils.loadFromLocalStorage(CACHE_KEY, null);
      if (cached && cached.fetchedAt) {
        const hrs = (Date.now() - new Date(cached.fetchedAt).getTime()) / (1000 * 3600);
        if (hrs < CACHE_TTL) {
          console.log('[NewsService] Usando cache de noticias:', cached.items.length, 'items');
          return cached.items;
        }
      }
    }

    try {
      // 1. Intenta cargar noticias embebidas (generadas diariamente por GitHub Actions)
      if (window.EMBEDDED_NEWS && window.EMBEDDED_NEWS.results && window.EMBEDDED_NEWS.results.length > 0) {
        console.log('[NewsService] Usando noticias embebidas:', window.EMBEDDED_NEWS.results.length, 'items');
        const scored = window.EMBEDDED_NEWS.results.map(scoreNewsItem);

        Utils.saveToLocalStorage(CACHE_KEY, {
          items:     scored,
          fetchedAt: window.EMBEDDED_NEWS.fetchedAt || new Date().toISOString()
        });

        return scored;
      }

      // 2. Fallback: intenta desde API de Vercel
      const r = await fetch('/api/news', {
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      const scored = (json.results || []).map(scoreNewsItem);

      Utils.saveToLocalStorage(CACHE_KEY, {
        items:     scored,
        fetchedAt: json.fetchedAt || new Date().toISOString()
      });

      console.log('[NewsService] Noticias obtenidas desde API:', scored.length);
      return scored;
    } catch (e) {
      console.warn('[NewsService] Error fetching noticias:', e.message);
      console.log('[NewsService] Usando cache o demo como fallback');

      // 3. Fallback final: cache antigua o demo
      const cached = Utils.loadFromLocalStorage(CACHE_KEY, null);
      if (cached && cached.items && cached.items.length > 0) {
        console.log('[NewsService] Usando cache guardado');
        return cached.items;
      }

      return getDemoNews();
    }
  }

  /**
   * Filtra noticias relevantes (con score ≠ 0 o con keywords cambiarias).
   */
  function filterRelevantNews(news) {
    const cambiaryTerms = [
      'dólar', 'cambio', 'bcra', 'reservas', 'tipo de cambio',
      'fmi', 'exportaciones', 'inflación', 'cepo', 'banco central',
      'soja', 'agro', 'monetaria', 'fiscal', 'tasas'
    ];
    return news.filter(n => {
      if (Math.abs(n.score) > 0) return true;
      const text = (n.title + ' ' + (n.summary || '')).toLowerCase();
      return cambiaryTerms.some(t => text.includes(t));
    });
  }

  // ── Noticias de demostración ──────────────────────────────────────────────

  function getDemoNews() {
    const today = new Date();
    const days  = (n) => {
      const d = new Date(today);
      d.setDate(d.getDate() - n);
      return d.toISOString();
    };
    const items = [
      {
        source:  'Ámbito Financiero',
        title:   'El BCRA compra divisas y acumula reservas por tercera semana',
        summary: 'El Banco Central compró US$320M esta semana gracias a la liquidación del agro y la calma cambiaria.',
        link:    '#',
        pubDate: days(1)
      },
      {
        source:  'Infobae Economía',
        title:   'Tipo de cambio mayorista sube levemente, cerca del límite superior de referencias internas',
        summary: 'El dólar mayorista cerró en alza moderada, acumulando cinco sesiones consecutivas con presión alcista.',
        link:    '#',
        pubDate: days(2)
      },
      {
        source:  'El Cronista',
        title:   'FMI aprobó nuevo desembolso para Argentina, reforzando reservas',
        summary: 'El directorio del FMI aprobó una transferencia de US$800M como parte del acuerdo EFF.',
        link:    '#',
        pubDate: days(4)
      },
      {
        source:  'La Nación',
        title:   'Tensión cambiaria tras declaraciones del ministro de economía',
        summary: 'El ministro no descartó ajustes en el tipo de cambio de referencia ante la presión del mercado.',
        link:    '#',
        pubDate: days(6)
      },
      {
        source:  'iProfesional',
        title:   'Exportaciones del agro crecen 18% interanual en el trimestre',
        summary: 'Los sojeros liquidaron US$1.200M durante la semana ante la ventana favorable del dólar blend.',
        link:    '#',
        pubDate: days(10)
      },
      {
        source:  'Ámbito Financiero',
        title:   'BCRA mantiene tasas de referencia sin cambios',
        summary: 'La autoridad monetaria optó por la estabilidad de tasas, en línea con la tendencia de estabilización.',
        link:    '#',
        pubDate: days(15)
      },
      {
        source:  'Infobae',
        title:   'Inflación de febrero en 4,2%, levemente por encima de lo esperado',
        summary: 'Los datos del IPC mostraron presión en alimentos y servicios; analistas advierten impacto en política cambiaria.',
        link:    '#',
        pubDate: days(20)
      }
    ];
    return items.map(scoreNewsItem);
  }

  // ── Exportación ───────────────────────────────────────────────────────────

  return {
    fetchNews,
    scoreNewsItem,
    filterRelevantNews,
    computeNewsPressureScore,
    timeWeight,
    getDemoNews
  };

})();

window.NewsService = NewsService;
