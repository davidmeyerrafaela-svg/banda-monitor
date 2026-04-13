/**
 * app.js — Controlador principal de la aplicación
 *
 * Orquesta: DataService → RulesEngine → ProbabilityEngine → NewsService → Charts → UI
 */

'use strict';

const App = (() => {

  // ── Estado global ─────────────────────────────────────────────────────────

  const state = {
    data:            [],    // Array crudo de { date, value, ref? }
    dailyStates:     [],    // Output del rules engine (daily)
    weeklyStates:    [],    // Output del rules engine (weekly)
    bandChanges:     [],    // Historial de cambios de banda
    currentBand:     null,  // Banda actual
    currentState:    null,  // Estado del día más reciente (daily)
    currentWeek:     null,  // Estado de la semana actual (parcial)
    usdTracker:      null,  // Tracker de pérdida acumulada en USD
    probability:     null,  // Resultado del probability engine
    news:            [],    // Noticias procesadas
    newsPressure:    0,     // Score -100 a 100
    backtestResults: null,
    isLoading:       false,
    isDemo:          false,
    lastUpdate:      null,
    selectedPeriod:  '3m',
    backtestWindow:  'all',
    config: {
      operativeCenter: 1444.8,   // Centro actual operativo de Tetra Pak (hoy)
      initialCenter:   1444.8,   // Para backtest/contexto histórico (ignorado si operativeCenter se usa)
      marginPct:       5,
      minDays:         5,
      pmFactor:        86,   // % ajuste precio PM/Straws
      amFactor:        100,  // % ajuste precio AM/TRC
      newsMaxAdjust:   0.10,
      newsWeight:      0.3,
      historyWindowMonths: 0,   // 0 = todo
      knnK:            30
    }
  };

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  async function init() {
    console.log('[App] Iniciando Tetra Pak Band Monitor...');
    loadConfig();
    setupEventListeners();
    applyConfigToUI();
    setLoadingState(true);
    await loadAndRender();
    setLoadingState(false);
    startAutoRefresh();
  }

  // ── Carga completa ────────────────────────────────────────────────────────

  async function loadAndRender() {
    try {
      // 1. Cargar datos
      setStatus('Descargando datos BCRA...');
      let data = await DataService.loadData();

      if (!data || data.length < 10) {
        // Fallback demo
        data = DataService.generateDemoData();
        state.isDemo = true;
        showDemoBanner(true);
      } else {
        state.isDemo = DataService.isDemo();
        showDemoBanner(state.isDemo);
      }
      state.data = data;

      // 2. Simular regla de banda (para contexto/backtest)
      setStatus('Aplicando reglas de banda...');
      const ruleResult   = RulesEngine.simulate(data, state.config);
      state.dailyStates  = ruleResult.dailyStates;
      state.weeklyStates = ruleResult.weeklyStates;
      state.bandChanges  = ruleResult.bandChanges;
      state.currentBand  = ruleResult.currentBand;  // Centro actual según historia
      state.currentState = RulesEngine.getCurrentState(state.dailyStates);

      // 2b. Recalcular la semana actual con el centro operativo (no histórico)
      const operativeBand = RulesEngine.calcBand(state.config.operativeCenter, state.config.marginPct);
      state.currentWeek = RulesEngine.getCurrentWeekState(data, operativeBand, state.config);
      state.usdTracker = RulesEngine.computeUsdTracker(state.bandChanges, state.config.pmFactor);

      // 3. Entrenar modelo de probabilidad
      setStatus('Entrenando modelo de probabilidad...');
      ProbabilityEngine.train(state.dailyStates, state.config.minDays);

      // 4. Obtener noticias (no bloquea render principal)
      loadNews();

      // 5. Calcular probabilidad
      computeCurrentProbability();

      // 6. Backtest
      setStatus('Ejecutando backtest...');
      state.backtestResults = ProbabilityEngine.backtest(
        state.dailyStates,
        state.config.minDays,
        state.backtestWindow === 'all' ? null : parseInt(state.backtestWindow)
      );

      // 7. Renderizar
      setStatus('Renderizando...');
      renderAll();

      state.lastUpdate = new Date();
      updateLastUpdateUI();
      setStatus('');
      console.log('[App] Carga completa.');

    } catch (err) {
      console.error('[App] Error en carga:', err);
      setStatus(`Error: ${err.message}`, 'error');
    }
  }

  // ── Noticias (async, no bloquea UI) ──────────────────────────────────────

  async function loadNews() {
    try {
      const all     = await NewsService.fetchNews();
      const filtered = NewsService.filterRelevantNews(all);
      state.news         = filtered;
      state.newsPressure = NewsService.computeNewsPressureScore(filtered);

      // Re-calcular probabilidad con noticias
      computeCurrentProbability();
      renderProbabilityPanel();
      renderNewsPanel();
    } catch (e) {
      console.warn('[App] Error cargando noticias:', e);
    }
  }

  // ── Cálculo de probabilidad ───────────────────────────────────────────────

  function computeCurrentProbability() {
    if (!state.dailyStates.length) return;
    const lastIdx   = state.dailyStates.length - 1;
    const features  = ProbabilityEngine.extractFeatures(state.dailyStates, lastIdx);
    if (!features) return;

    state.probability = ProbabilityEngine.computeProbability(
      features,
      state.newsPressure,
      {
        newsMaxAdjust: state.config.newsMaxAdjust,
        newsWeight:    state.config.newsWeight
      }
    );
  }

  // ── Render principal ──────────────────────────────────────────────────────

  function renderAll() {
    renderKPIs();
    renderStatusBanner();
    renderCurrentWeekPanel();
    renderUsdTrackerPanel();
    renderMainChart();
    renderProbabilityPanel();
    renderDailyTable();
    renderSignalHistory();
    renderNewsPanel();
    renderBacktestPanel();
    renderExplanationPanel();
  }

  // ── KPIs ──────────────────────────────────────────────────────────────────

  function renderKPIs() {
    const s  = state.currentState;
    const b  = RulesEngine.calcBand(state.config.operativeCenter, state.config.marginPct);  // Centro operativo, NO histórico
    const cw = state.currentWeek;
    if (!s || !b) return;

    const prev   = state.dailyStates.length >= 2
      ? state.dailyStates[state.dailyStates.length - 2]
      : null;
    const daily  = prev ? s.value - prev.value : 0;
    const dailyP = prev ? Utils.pctReturn(prev.value, s.value) * 100 : 0;

    // getStatusLabel(currentWeek, dailyState), getStatusClass(label)
    const statusLabel = RulesEngine.getStatusLabel(cw, s);
    const statusClass = RulesEngine.getStatusClass(statusLabel);
    // calcBandPressureIndex(currentWeek)
    const bpi = RulesEngine.calcBandPressureIndex(cw);

    setKPI('kpi-dollar', Utils.formatNumber(s.value),
           `${daily >= 0 ? '+' : ''}${Utils.formatNumber(daily)} / ${daily >= 0 ? '+' : ''}${Utils.formatNumber(dailyP)}%`,
           daily >= 0 ? 'positive' : 'negative');
    const initialVsActual = state.config.initialCenter !== b.center
      ? ` (inicial: ${Utils.formatNumber(state.config.initialCenter)})`
      : '';
    setKPI('kpi-center', Utils.formatNumber(b.center), 'Centro de banda operativo (Tetra Pak HOY)', '');
    setKPI('kpi-upper',  Utils.formatNumber(b.upper),  'Límite superior (+5%)', 'negative');
    setKPI('kpi-lower',  Utils.formatNumber(b.lower),  'Límite inferior (-5%)', 'positive');
    setKPI('kpi-gap-upper', Utils.formatNumber(s.gapToUpper) + '%',
           s.isAboveUpper ? '¡Sobre el techo!' : 'Dist. diaria al techo',
           s.isAboveUpper ? 'negative' : '');
    setKPI('kpi-gap-lower', Utils.formatNumber(s.gapToLower) + '%',
           s.isBelowLower ? '¡Bajo el piso!' : 'Dist. diaria al piso',
           s.isBelowLower ? 'negative' : '');

    // Promedio semanal (reemplaza las métricas de días consecutivos)
    if (cw) {
      const avgPct    = cw.avgPctFromCenter;
      const avgCls    = cw.avgAboveUpper ? 'negative' : cw.avgBelowLower ? 'info' : '';
      const avgLabel  = `Prom. semana (${cw.daysObserved}/5 días) · ${avgPct !== null ? (avgPct >= 0 ? '+' : '') + Utils.formatNumber(avgPct) + '%' : '--'} vs centro`;
      setKPI('kpi-weekly-avg',
             cw.partialAverage !== null ? Utils.formatNumber(cw.partialAverage) : '--',
             avgLabel, avgCls);

      const effLabel = (cw.avgAboveUpper || cw.avgBelowLower) ? 'Fecha efectiva ajuste' : 'Ef. si activa esta semana';
      const effCls   = (cw.avgAboveUpper || cw.avgBelowLower) ? 'negative' : '';
      setKPI('kpi-effective-date',
             Utils.formatDateDisplay(cw.effectiveDate),
             effLabel, effCls);
    }

    const probPct = state.probability ? Math.round(state.probability.probFinal * 100) : 0;
    setKPI('kpi-prob', `${probPct}%`, 'Prob. cambio próx. semana',
           probPct >= 60 ? 'negative' : probPct >= 30 ? 'warning' : '');

    const bpiEl = document.getElementById('kpi-bpi');
    if (bpiEl) {
      bpiEl.querySelector('.kpi-value').textContent = Utils.formatNumber(bpi, 1) + '/100';
      bpiEl.querySelector('.kpi-label').textContent = 'Band Pressure Index';
    }

    const statusEl = document.getElementById('kpi-status');
    if (statusEl) {
      statusEl.querySelector('.kpi-value').textContent = statusLabel;
      statusEl.querySelector('.kpi-value').className = `kpi-value status-badge ${statusClass}`;
    }

    checkAlerts(s, cw);
  }

  function setKPI(id, value, label, className = '') {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelector('.kpi-value').textContent = value;
    if (el.querySelector('.kpi-label')) el.querySelector('.kpi-label').textContent = label;
    if (className) el.querySelector('.kpi-value').className = `kpi-value ${className}`;
  }

  function checkAlerts(s, cw) {
    const alertBanner = document.getElementById('alert-banner');
    if (!alertBanner) return;
    const alerts = [];

    if (cw) {
      if (cw.isComplete && cw.avgAboveUpper)
        alerts.push(`🚨 Promedio semanal (${Utils.formatNumber(cw.partialAverage)}) SUPERA EL TECHO (${Utils.formatNumber(cw.upper)}). Cambio de banda activado. Fecha efectiva: ${Utils.formatDateDisplay(cw.effectiveDate)}`);
      else if (cw.isComplete && cw.avgBelowLower)
        alerts.push(`🚨 Promedio semanal (${Utils.formatNumber(cw.partialAverage)}) SUPERA EL PISO (${Utils.formatNumber(cw.lower)}). Cambio de banda activado. Fecha efectiva: ${Utils.formatDateDisplay(cw.effectiveDate)}`);
      else if (cw.avgAboveUpper)
        alerts.push(`⚠️ Promedio parcial semanal (${Utils.formatNumber(cw.partialAverage)}) ya supera el techo. Semana incompleta (${cw.daysObserved}/5 días).`);
      else if (cw.avgBelowLower)
        alerts.push(`⚠️ Promedio parcial semanal (${Utils.formatNumber(cw.partialAverage)}) ya supera el piso. Semana incompleta (${cw.daysObserved}/5 días).`);
      else if (cw.distToUpper !== null && cw.distToUpper < 1.5 && cw.distToUpper > 0)
        alerts.push(`⚠️ El promedio semanal está a solo ${Utils.formatNumber(cw.distToUpper)}% del TECHO (${Utils.formatNumber(cw.upper)}).`);
      else if (cw.distToLower !== null && cw.distToLower < 1.5 && cw.distToLower > 0)
        alerts.push(`⚠️ El promedio semanal está a solo ${Utils.formatNumber(cw.distToLower)}% del PISO (${Utils.formatNumber(cw.lower)}).`);
    }

    if (alerts.length > 0) {
      alertBanner.innerHTML = alerts.map(a => `<div class="alert-item">${a}</div>`).join('');
      alertBanner.classList.remove('hidden');
    } else {
      alertBanner.classList.add('hidden');
    }
  }

  // ── Panel semana actual ───────────────────────────────────────────────────

  function renderCurrentWeekPanel() {
    const el = document.getElementById('current-week-panel');
    if (!el) return;
    const cw = state.currentWeek;
    const b  = state.currentBand;
    if (!cw || !b) { el.innerHTML = '<p class="muted">Sin datos de semana actual.</p>'; return; }

    const avgStatus = cw.avgAboveUpper
      ? '<span class="week-tag week-tag-red">SUPERA TECHO — ACTIVA</span>'
      : cw.avgBelowLower
        ? '<span class="week-tag week-tag-blue">SUPERA PISO — ACTIVA</span>'
        : '<span class="week-tag week-tag-green">DENTRO DE BANDA</span>';

    const daysHtml = cw.days.map((d, i) => {
      const above  = d.value > b.upper;
      const below  = d.value < b.lower;
      const icon   = above ? '🔴' : below ? '🔵' : '🟢';
      const cls    = above ? 'negative' : below ? 'info' : 'positive';
      const isPrior = d.date < cw.weekStart;
      return `<div class="week-day-row${isPrior ? ' week-day-prior' : ''}">
        <span class="week-day-date">${isPrior ? '↩ ' : ''}${Utils.formatDateDisplay(d.date)}</span>
        <span class="week-day-value ${cls}">${icon} ${Utils.formatNumber(d.value)}</span>
      </div>`;
    }).join('');

    const needsUpperHtml = (cw.daysRemaining > 0 && cw.avgNeededForUpper !== null)
      ? `<div class="week-metric"><span class="week-metric-label">Necesita promediar (días rest.) para cruzar techo</span>
         <span class="week-metric-value">${Utils.formatNumber(cw.avgNeededForUpper)}</span></div>` : '';

    const effHtml = (cw.avgAboveUpper || cw.avgBelowLower)
      ? `<div class="week-metric"><span class="week-metric-label">Fecha efectiva de ajuste</span>
         <span class="week-metric-value negative">${Utils.formatDateDisplay(cw.effectiveDate)}</span></div>` : '';

    const distUpperHtml = !cw.avgAboveUpper
      ? `<div class="week-metric"><span class="week-metric-label">Dist. prom. al techo (${Utils.formatNumber(b.upper)})</span>
         <span class="week-metric-value">${cw.distToUpper !== null ? Utils.formatNumber(cw.distToUpper) + '%' : '--'}</span></div>` : '';
    const distLowerHtml = !cw.avgBelowLower
      ? `<div class="week-metric"><span class="week-metric-label">Dist. prom. al piso (${Utils.formatNumber(b.lower)})</span>
         <span class="week-metric-value">${cw.distToLower !== null ? Utils.formatNumber(cw.distToLower) + '%' : '--'}</span></div>` : '';

    el.innerHTML = `
      <div class="week-state-grid">
        <div class="week-info-col">
          <div class="week-header-row">
            <span class="week-period">${Utils.formatDateDisplay(cw.weekStart)} — ${Utils.formatDateDisplay(cw.weekEnd)}</span>
            ${avgStatus}
          </div>
          <div class="week-days-list">${daysHtml}</div>
        </div>
        <div class="week-metrics-col">
          <div class="week-metric">
            <span class="week-metric-label">Promedio semanal (${cw.daysObserved} obs. + ${cw.daysFilled} completados)</span>
            <span class="week-metric-value ${cw.avgAboveUpper ? 'negative' : cw.avgBelowLower ? 'info' : ''}">${cw.partialAverage !== null ? Utils.formatNumber(cw.partialAverage) : '--'}</span>
          </div>
          <div class="week-metric">
            <span class="week-metric-label">Desvío vs centro (${Utils.formatNumber(b.center)})</span>
            <span class="week-metric-value ${cw.avgPctFromCenter > 0 ? 'negative' : cw.avgPctFromCenter < 0 ? 'positive' : ''}">${cw.avgPctFromCenter !== null ? (cw.avgPctFromCenter >= 0 ? '+' : '') + Utils.formatNumber(cw.avgPctFromCenter) + '%' : '--'}</span>
          </div>
          ${distUpperHtml}
          ${distLowerHtml}
          ${needsUpperHtml}
          ${effHtml}
        </div>
      </div>`;
  }

  // ── Panel tracker USD ─────────────────────────────────────────────────────

  function renderUsdTrackerPanel() {
    const el = document.getElementById('usd-tracker-panel');
    if (!el || !state.usdTracker) return;
    const t = state.usdTracker;

    const oobHtml = t.outOfBandRecommendedPct > 0
      ? `<div class="usd-tracker-alert">Incremento fuera de banda acumulado recomendado: <b>${t.outOfBandRecommendedPct}%</b></div>` : '';

    const jumpsToOob = t.jumpsToNextOutOfBand;

    el.innerHTML = `
      <div class="usd-tracker-grid">
        <div class="usd-metric">
          <div class="usd-metric-label">Saltos alcistas</div>
          <div class="usd-metric-value negative">${t.bandJumpsUp}</div>
        </div>
        <div class="usd-metric">
          <div class="usd-metric-label">Saltos bajistas</div>
          <div class="usd-metric-value positive">${t.bandJumpsDown}</div>
        </div>
        <div class="usd-metric">
          <div class="usd-metric-label">Pérdida USD acumulada</div>
          <div class="usd-metric-value negative">${Utils.formatNumber(t.cumulativeUsdLossPct, 2)}%</div>
        </div>
        <div class="usd-metric">
          <div class="usd-metric-label">Pérdida prom. por salto</div>
          <div class="usd-metric-value">${Utils.formatNumber(t.avgUsdLossPerJump, 3)}%</div>
        </div>
        <div class="usd-metric">
          <div class="usd-metric-label">Saltos hasta próx. OOB</div>
          <div class="usd-metric-value ${jumpsToOob <= 1 ? 'negative' : ''}">${jumpsToOob === 0 ? '¡Ahora!' : jumpsToOob}</div>
        </div>
        <div class="usd-metric">
          <div class="usd-metric-label">Factor PM/Straws</div>
          <div class="usd-metric-value">${t.pmFactor}% del FX</div>
        </div>
      </div>
      ${oobHtml}
      <p class="muted" style="margin-top:8px;font-size:.78rem">
        Por cada salto alcista, el PM ajusta al ${t.pmFactor}% de la variación FX → pérdida en USD ≈ ${Utils.formatNumber(t.avgUsdLossPerJump || 0, 2)}% por salto.
        Cada 6 saltos se recomienda un incremento fuera de banda del ~5% para recuperar margen.
      </p>`;
  }

  // ── Banner de estado ──────────────────────────────────────────────────────

  function renderStatusBanner() {
    const label = RulesEngine.getStatusLabel(state.currentWeek, state.currentState);
    const cls   = RulesEngine.getStatusClass(label);
    const el    = document.getElementById('status-banner');
    if (!el) return;
    el.className = `status-banner ${cls}`;
    el.textContent = `Estado actual: ${label}`;
  }

  // ── Gráfico principal ─────────────────────────────────────────────────────

  function renderMainChart() {
    Charts.renderMainChart(state.dailyStates, state.bandChanges, state.selectedPeriod);
    Charts.renderBandPressureChart(state.dailyStates, state.selectedPeriod);
    Charts.renderReturnSparkline(state.dailyStates, state.selectedPeriod);
  }

  // ── Panel de probabilidad ─────────────────────────────────────────────────

  function renderProbabilityPanel() {
    const p = state.probability;
    if (!p) return;

    Charts.renderProbabilityGauge(p.probAlcista, p.probBajista);

    const breakdown = document.getElementById('prob-breakdown');
    if (breakdown) {
      const base  = p.probBase    != null ? Math.round(p.probBase    * 100) + '%' : 'Heurístico';
      const model = p.probModel   != null ? Math.round(p.probModel   * 100) + '%' : '--';
      const hist  = p.probHistorical != null ? Math.round(p.probHistorical * 100) + '%' : '--';
      const adj   = p.newsAdjust  != null ? (p.newsAdjust >= 0 ? '+' : '') + Math.round(p.newsAdjust * 100) + 'pp' : '0pp';
      const final = Math.round(p.probFinal * 100) + '%';
      const alcista = p.probAlcista != null ? Math.round(p.probAlcista * 100) + '%' : '--';
      const bajista = p.probBajista != null ? Math.round(p.probBajista * 100) + '%' : '--';
      const news  = state.newsPressure;
      const newsDir = news > 10 ? 'alcista' : news < -10 ? 'bajista' : 'neutral';
      breakdown.innerHTML = `
        <table class="prob-table">
          <tr><td>Modelo logístico</td><td class="prob-val">${model}</td></tr>
          <tr><td>Vecinos históricos</td><td class="prob-val">${hist}</td></tr>
          <tr><td><b>Probabilidad base</b></td><td class="prob-val"><b>${base}</b></td></tr>
          <tr class="separator"><td colspan="2"></td></tr>
          <tr><td>News Pressure Score</td><td class="prob-val">${news > 0 ? '+' : ''}${news}</td></tr>
          <tr><td>Contexto noticioso</td><td class="prob-val">${newsDir}</td></tr>
          <tr><td>Ajuste por noticias</td><td class="prob-val ${p.newsAdjust > 0 ? 'negative' : p.newsAdjust < 0 ? 'positive' : ''}">${adj}</td></tr>
          <tr class="separator"><td colspan="2"></td></tr>
          <tr class="prob-final"><td><b>Probabilidad final (total)</b></td><td class="prob-val"><b>${final}</b></td></tr>
          <tr><td><span style="color: #dc2626">Prob. ALCISTA (sube)</span></td><td class="prob-val" style="color: #dc2626"><b>${alcista}</b></td></tr>
          <tr><td><span style="color: #0284c7">Prob. BAJISTA (baja)</span></td><td class="prob-val" style="color: #0284c7"><b>${bajista}</b></td></tr>
        </table>
      `;
    }

    const explainEl = document.getElementById('prob-explain');
    if (explainEl) {
      explainEl.innerHTML = ProbabilityEngine.explainProbability(
        p, state.currentState, state.config.minDays
      );
    }
  }

  // ── Tabla diaria ──────────────────────────────────────────────────────────

  function renderDailyTable() {
    const tbody = document.querySelector('#daily-table tbody');
    if (!tbody) return;

    const filtered = Charts.filterByPeriod(state.dailyStates, state.selectedPeriod);
    const rows     = [...filtered].reverse().slice(0, 60);  // Últimas 60 filas

    tbody.innerHTML = rows.map((s, i) => {
      const prev    = filtered[filtered.length - 1 - i - 1];
      const daily   = prev ? s.value - prev.value : null;
      const dailyP  = prev ? Utils.pctReturn(prev.value, s.value) * 100 : null;
      const semaforo = s.isAboveUpper ? 'semaforo-rojo' : s.isBelowLower ? 'semaforo-azul' : 'semaforo-verde';
      const semaforoLabel = s.isAboveUpper ? '🔴 Sobre techo' : s.isBelowLower ? '🔵 Bajo piso' : '🟢 En banda';
      const bandChange = s.bandJustChanged ? ' 🔔' : '';

      return `<tr class="${semaforo}-row${s.bandJustChanged ? ' band-change-row' : ''}">
        <td>${Utils.formatDateDisplay(s.date)}${bandChange}</td>
        <td><b>${Utils.formatNumber(s.value)}</b></td>
        <td class="${daily === null ? '' : daily >= 0 ? 'positive' : 'negative'}">${
          daily === null ? '--' : (daily >= 0 ? '+' : '') + Utils.formatNumber(daily)}</td>
        <td class="${dailyP === null ? '' : dailyP >= 0 ? 'positive' : 'negative'}">${
          dailyP === null ? '--' : (dailyP >= 0 ? '+' : '') + Utils.formatNumber(dailyP) + '%'}</td>
        <td>${Utils.formatNumber(s.center)}</td>
        <td class="negative">${Utils.formatNumber(s.upper)}</td>
        <td class="positive">${Utils.formatNumber(s.lower)}</td>
        <td>${Utils.formatPercentValue(s.gapToCenter)}%</td>
        <td><span class="${semaforo}-badge">${semaforoLabel}</span></td>
      </tr>`;
    }).join('');
  }

  // ── Historial de señales ──────────────────────────────────────────────────

  function renderSignalHistory() {
    const tbody = document.querySelector('#signals-table tbody');
    if (!tbody) return;

    if (state.bandChanges.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#94a3b8">Sin cambios de banda históricos</td></tr>';
      return;
    }

    tbody.innerHTML = [...state.bandChanges].reverse().map(c => `
      <tr>
        <td>${Utils.formatDateDisplay(c.weekStart)} – ${Utils.formatDateDisplay(c.weekEnd)}</td>
        <td>${Utils.formatDateDisplay(c.effectiveDate)}</td>
        <td><b>${Utils.formatNumber(c.triggerAverage)}</b></td>
        <td class="${c.variationPct >= 0 ? 'negative' : 'positive'}">${c.variationPct >= 0 ? '+' : ''}${Utils.formatNumber(c.variationPct)}%</td>
        <td><span class="direction-badge direction-${c.direction}">
          ${c.direction === 'up' ? '↑ Alcista' : '↓ Bajista'}
        </span></td>
        <td>${Utils.formatNumber(c.oldCenter)} → ${Utils.formatNumber(c.newCenter)}</td>
        <td class="${c.priceAdjPm >= 0 ? 'negative' : 'positive'}">${c.priceAdjPm >= 0 ? '+' : ''}${Utils.formatNumber(c.priceAdjPm, 2)}%</td>
        <td class="${c.priceAdjAm >= 0 ? 'negative' : 'positive'}">${c.priceAdjAm >= 0 ? '+' : ''}${Utils.formatNumber(c.priceAdjAm, 2)}%</td>
        <td class="negative">${Utils.formatNumber(c.usdLossJump, 3)}%</td>
      </tr>`).join('');
  }

  // ── Noticias ──────────────────────────────────────────────────────────────

  function renderNewsPanel() {
    const container = document.getElementById('news-cards');
    if (!container) return;

    const items = state.news.slice(0, 12);
    if (items.length === 0) {
      container.innerHTML = '<p class="muted">Sin noticias disponibles. Asegurate de que el servidor proxy esté corriendo.</p>';
      return;
    }

    const pressCls = state.newsPressure > 10  ? 'pressure-up' :
                     state.newsPressure < -10 ? 'pressure-down' : 'pressure-neutral';
    document.getElementById('news-pressure-score').textContent =
      (state.newsPressure >= 0 ? '+' : '') + state.newsPressure;
    document.getElementById('news-pressure-score').className = `pressure-value ${pressCls}`;

    container.innerHTML = items.map(n => {
      const dirIcon = n.direction === 'alcista' ? '🔴' : n.direction === 'bajista' ? '🔵' : '⚪';
      const impactCls = `impact-${n.impact}`;
      const daysAgo = n.pubDate ? Math.round((Date.now() - new Date(n.pubDate).getTime()) / (1000*60*60*24)) : '?';
      return `
        <div class="news-card direction-${n.direction}">
          <div class="news-header">
            <span class="news-source">${n.source || 'N/D'}</span>
            <span class="news-date">${daysAgo}d atrás</span>
            <span class="news-impact ${impactCls}">${n.impact}</span>
          </div>
          <div class="news-title">${n.title}</div>
          ${n.summary ? `<div class="news-summary">${n.summary.slice(0, 200)}…</div>` : ''}
          <div class="news-footer">
            <span class="news-direction">${dirIcon} ${n.direction}</span>
            <span class="news-score">Score: ${n.score > 0 ? '+' : ''}${n.score}</span>
            ${n.link && n.link !== '#' ? `<a href="${n.link}" target="_blank" rel="noopener" class="news-link">Ver noticia</a>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  // ── Backtest ──────────────────────────────────────────────────────────────

  function renderBacktestPanel() {
    const r = state.backtestResults;
    if (!r) return;

    Charts.renderBacktestChart(r);

    const m = r.metrics;
    const metricsEl = document.getElementById('backtest-metrics');
    if (metricsEl && m) {
      metricsEl.innerHTML = `
        <div class="metric-grid">
          <div class="metric-item">
            <span class="metric-label">Cambios históricos</span>
            <span class="metric-value">${m.totalChanges}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Verdaderos positivos</span>
            <span class="metric-value positive">${m.tp}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Falsos positivos</span>
            <span class="metric-value negative">${m.fp}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Verdaderos negativos</span>
            <span class="metric-value positive">${m.tn}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Falsos negativos</span>
            <span class="metric-value negative">${m.fn}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Accuracy</span>
            <span class="metric-value">${Utils.formatNumber(m.accuracy * 100, 1)}%</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Precision</span>
            <span class="metric-value">${Utils.formatNumber(m.precision * 100, 1)}%</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Recall</span>
            <span class="metric-value">${Utils.formatNumber(m.recall * 100, 1)}%</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">F1 Score</span>
            <span class="metric-value">${Utils.formatNumber(m.f1 * 100, 1)}%</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Brier Score</span>
            <span class="metric-value">${Utils.formatNumber(m.brierScore, 4)}</span>
          </div>
        </div>`;

      // Tabla de confusión
      const confEl = document.getElementById('confusion-matrix');
      if (confEl) {
        confEl.innerHTML = `
          <table class="conf-matrix">
            <thead><tr><th></th><th>Predijo 0</th><th>Predijo 1</th></tr></thead>
            <tbody>
              <tr><td><b>Real 0</b></td><td class="tn">${m.tn}</td><td class="fp">${m.fp}</td></tr>
              <tr><td><b>Real 1</b></td><td class="fn">${m.fn}</td><td class="tp">${m.tp}</td></tr>
            </tbody>
          </table>`;
      }

      // Calibración
      const calEl = document.getElementById('calibration-table');
      if (calEl && m.calibration) {
        calEl.innerHTML = `
          <table class="data-table">
            <thead><tr><th>Bucket prob.</th><th>Pred. media</th><th>Frec. real</th><th>N</th></tr></thead>
            <tbody>
              ${m.calibration.map(b => `<tr>
                <td>${b.bucket}</td>
                <td>${Utils.formatNumber(b.predicted * 100, 1)}%</td>
                <td>${Utils.formatNumber(b.actual * 100, 1)}%</td>
                <td>${b.count}</td>
              </tr>`).join('')}
            </tbody>
          </table>`;
      }
    }
  }

  // ── Panel de explicación ──────────────────────────────────────────────────

  function renderExplanationPanel() {
    const s  = state.currentState;
    const cw = state.currentWeek;
    const p  = state.probability;

    const windowEl = document.getElementById('explain-window');
    if (windowEl) {
      windowEl.innerHTML = RulesEngine.explainWindow(cw);
    }

    const probEl = document.getElementById('explain-probability');
    if (probEl && p && s) {
      probEl.innerHTML = ProbabilityEngine.explainProbability(p, s, state.config.minDays);
    }
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  function setupEventListeners() {
    // Botón refresh
    document.getElementById('refresh-btn')?.addEventListener('click', async () => {
      setLoadingState(true);
      await DataService.loadData(true);
      await loadAndRender();
      setLoadingState(false);
    });

    // Dark mode
    document.getElementById('dark-mode-btn')?.addEventListener('click', () => {
      document.body.classList.toggle('dark');
      const isDark = document.body.classList.contains('dark');
      Charts.setDarkMode(isDark);
      Utils.saveToLocalStorage('tp_darkmode', isDark);
      renderMainChart();
      renderProbabilityPanel();
      Charts.renderBandPressureChart(state.dailyStates, state.selectedPeriod);
    });

    // Selector de período
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        state.selectedPeriod = this.dataset.period;
        renderMainChart();
        renderDailyTable();
        Charts.renderBandPressureChart(state.dailyStates, state.selectedPeriod);
        Charts.renderReturnSparkline(state.dailyStates, state.selectedPeriod);
      });
    });

    // Backtest window
    document.getElementById('backtest-window')?.addEventListener('change', function () {
      state.backtestWindow = this.value;
      state.backtestResults = ProbabilityEngine.backtest(
        state.dailyStates,
        state.config.minDays,
        this.value === 'all' ? null : parseInt(this.value)
      );
      renderBacktestPanel();
    });

    // Config form
    document.getElementById('config-form')?.addEventListener('submit', function (e) {
      e.preventDefault();
      applyConfigFromUI();
      saveConfig();
      // Reload con nueva configuración
      setLoadingState(true);
      loadAndRender().then(() => setLoadingState(false));
    });

    // Exportar CSV
    document.getElementById('export-csv-btn')?.addEventListener('click', exportCSV);

    // Exportar chart PNG
    document.getElementById('export-png-btn')?.addEventListener('click', () => {
      Charts.exportMainChart();
    });

    // Exportar PDF (impresión del navegador)
    document.getElementById('export-pdf-btn')?.addEventListener('click', () => {
      window.print();
    });

    // Refresh noticias
    document.getElementById('refresh-news-btn')?.addEventListener('click', async () => {
      await NewsService.fetchNews(true).then(news => {
        state.news = NewsService.filterRelevantNews(news);
        state.newsPressure = NewsService.computeNewsPressureScore(state.news);
        computeCurrentProbability();
        renderProbabilityPanel();
        renderNewsPanel();
      });
    });

    // Resize
    window.addEventListener('resize', Utils.debounce
      ? Utils.debounce(Charts.resizeAll, 300)
      : Charts.resizeAll
    );

    // Dark mode inicial
    if (Utils.loadFromLocalStorage('tp_darkmode', false)) {
      document.body.classList.add('dark');
      Charts.setDarkMode(true);
    }
  }

  // ── Configuración ─────────────────────────────────────────────────────────

  function applyConfigToUI() {
    const c = state.config;
    setVal('cfg-operative-center', c.operativeCenter);
    setVal('cfg-center',           c.initialCenter);
    setVal('cfg-margin',           c.marginPct);
    setVal('cfg-pm-factor',        c.pmFactor);
    setVal('cfg-am-factor',        c.amFactor);
    setVal('cfg-news-adj',         c.newsMaxAdjust * 100);
    setVal('cfg-knn-k',            c.knnK);
    setVal('cfg-history',          c.historyWindowMonths);
  }

  function applyConfigFromUI() {
    state.config.operativeCenter     = parseFloat(getVal('cfg-operative-center')) || 1444.8;
    state.config.initialCenter       = parseFloat(getVal('cfg-center'))          || 1444.8;
    state.config.marginPct           = parseFloat(getVal('cfg-margin'))          || 5;
    state.config.pmFactor            = parseFloat(getVal('cfg-pm-factor'))       || 86;
    state.config.amFactor            = parseFloat(getVal('cfg-am-factor'))       || 100;
    state.config.newsMaxAdjust       = parseFloat(getVal('cfg-news-adj')) / 100  || 0.10;
    state.config.knnK                = parseInt(getVal('cfg-knn-k'))             || 30;
    state.config.historyWindowMonths = parseInt(getVal('cfg-history'))           || 0;
  }

  function saveConfig() {
    Utils.saveToLocalStorage('tp_config', state.config);
  }

  function loadConfig() {
    const saved = Utils.loadFromLocalStorage('tp_config', null);
    if (saved) Object.assign(state.config, saved);
  }

  function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }
  function getVal(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  }

  // ── Auto-refresh ──────────────────────────────────────────────────────────

  let _refreshInterval = null;

  function startAutoRefresh() {
    _refreshInterval = setInterval(async () => {
      if (!document.hidden && !state.isLoading) {
        console.log('[App] Auto-refresh...');
        await DataService.loadData(true);
        await loadAndRender();
      }
    }, 15 * 60 * 1000);   // cada 15 minutos
  }

  // ── Exportar CSV ──────────────────────────────────────────────────────────

  function exportCSV() {
    const filtered = Charts.filterByPeriod(state.dailyStates, state.selectedPeriod);
    const header   = ['Fecha','USD Mayorista','Var ARS','Var %','Centro','Superior','Inferior','Dist Centro %','Estado'];
    const rows     = filtered.map((s, i) => {
      const prev  = i > 0 ? filtered[i-1] : null;
      const daily = prev ? s.value - prev.value : '';
      const dailyP= prev ? Utils.pctReturn(prev.value, s.value) * 100 : '';
      const estado= s.isAboveUpper ? 'Sobre techo' : s.isBelowLower ? 'Bajo piso' : 'En banda';
      return [
        s.date,
        s.value,
        daily !== '' ? Utils.roundTo(daily, 2) : '',
        dailyP !== '' ? Utils.roundTo(dailyP, 4) : '',
        s.center,
        s.upper,
        s.lower,
        Utils.roundTo(s.gapToCenter, 4),
        estado
      ].join(',');
    });

    const csv  = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `banda-cambiaria-${Utils.formatDate(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  function setLoadingState(loading) {
    state.isLoading = loading;
    const btn = document.getElementById('refresh-btn');
    if (btn) btn.disabled = loading;
    const spinner = document.getElementById('loading-spinner');
    if (spinner) spinner.style.display = loading ? 'flex' : 'none';
  }

  function setStatus(msg, level = 'info') {
    const el = document.getElementById('status-msg');
    if (!el) return;
    el.textContent = msg;
    el.className   = `status-msg status-${level}`;
    el.style.display = msg ? 'block' : 'none';
  }

  function updateLastUpdateUI() {
    const el = document.getElementById('last-update');
    if (!el || !state.lastUpdate) return;
    el.textContent = `Actualizado: ${Utils.formatDateDisplay(state.lastUpdate)} ` +
                     `${state.lastUpdate.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
    if (state.isDemo) el.textContent += ' (DEMO)';
  }

  function showDemoBanner(show) {
    const el = document.getElementById('demo-banner');
    if (el) el.style.display = show ? 'block' : 'none';
  }

  // ── Exportación ───────────────────────────────────────────────────────────

  return { init };

})();

// Iniciar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => App.init());
