/**
 * charts.js — Visualizaciones con Plotly.js
 *
 * Renderiza:
 *  1. Gráfico principal: precio vs banda
 *  2. Gauge de probabilidad
 *  3. Band Pressure Index
 *  4. Gráfico de backtest
 */

'use strict';

const Charts = (() => {

  // ── Paleta de colores ─────────────────────────────────────────────────────

  const C = {
    price:      '#2563eb',
    center:     '#64748b',
    upper:      '#ef4444',
    lower:      '#3b82f6',
    band:       'rgba(100, 116, 139, 0.08)',
    trigger:    '#f59e0b',
    triggerUp:  '#ef4444',
    triggerDown:'#3b82f6',
    green:      '#22c55e',
    red:        '#ef4444',
    blue:       '#3b82f6',
    gray:       '#94a3b8',
    bg:         '#ffffff',
    gridline:   '#e2e8f0',
    text:       '#1e293b',
    textMuted:  '#64748b'
  };

  // ── Theme (dark mode) ─────────────────────────────────────────────────────

  let _darkMode = false;

  function setDarkMode(enabled) {
    _darkMode = enabled;
    Object.assign(C, enabled ? {
      bg:       '#0f172a',
      gridline: '#1e293b',
      text:     '#f1f5f9',
      textMuted:'#94a3b8',
      band:     'rgba(148, 163, 184, 0.06)'
    } : {
      bg:       '#ffffff',
      gridline: '#e2e8f0',
      text:     '#1e293b',
      textMuted:'#64748b',
      band:     'rgba(100, 116, 139, 0.08)'
    });
  }

  function baseLayout(title = '') {
    return {
      title:      { text: title, font: { size: 13, color: C.text }, x: 0.01 },
      paper_bgcolor: C.bg,
      plot_bgcolor:  C.bg,
      margin:     { t: 36, r: 16, b: 48, l: 72 },
      font:       { family: 'Inter, system-ui, sans-serif', color: C.text, size: 11 },
      xaxis: {
        gridcolor:  C.gridline,
        linecolor:  C.gridline,
        tickfont:   { color: C.textMuted },
        showgrid:   true,
        zeroline:   false,
        type:       'date'
      },
      yaxis: {
        gridcolor:  C.gridline,
        linecolor:  C.gridline,
        tickfont:   { color: C.textMuted },
        tickprefix: '$ ',
        showgrid:   true,
        zeroline:   false
      },
      legend: {
        bgcolor:    'transparent',
        bordercolor:'transparent',
        font:       { size: 11, color: C.textMuted }
      },
      hovermode: 'x unified',
      hoverlabel: {
        bgcolor:    _darkMode ? '#1e293b' : '#f8fafc',
        bordercolor:C.gridline,
        font:       { size: 11 }
      }
    };
  }

  // ── 1. Gráfico principal ──────────────────────────────────────────────────

  /**
   * @param {Array}  dailyStates - Output de RulesEngine.simulate()
   * @param {Array}  bandChanges - Cambios de banda históricos
   * @param {string} period      - '1m'|'3m'|'6m'|'12m'|'ytd'|'all'
   */
  function renderMainChart(dailyStates, bandChanges, period = '3m') {
    const el = document.getElementById('main-chart');
    if (!el || !dailyStates || dailyStates.length === 0) return;

    // Filtrar por período
    const filtered = filterByPeriod(dailyStates, period);
    if (filtered.length === 0) return;

    const dates  = filtered.map(d => d.date);
    const prices = filtered.map(d => d.value);
    const upper  = filtered.map(d => d.upper);
    const lower  = filtered.map(d => d.lower);
    const center = filtered.map(d => d.center);

    // Colores por estado
    const markerColors = filtered.map(d =>
      d.isAboveUpper ? C.red :
      d.isBelowLower ? C.blue : C.price
    );

    // Área sombreada de la banda (upper - lower)
    const traceBandUpper = {
      x: dates, y: upper,
      fill: 'none',
      line:  { color: 'transparent' },
      showlegend: false,
      hoverinfo: 'skip',
      type: 'scatter'
    };
    const traceBandFill = {
      x: dates, y: lower,
      fill: 'tonexty',
      fillcolor: C.band,
      line:  { color: 'transparent' },
      name: 'Banda interna',
      hoverinfo: 'skip',
      type: 'scatter'
    };
    const traceUpper = {
      x: dates, y: upper,
      name: 'Límite superior',
      line: { color: C.upper, width: 1.5, dash: 'dot' },
      type: 'scatter',
      hovertemplate: 'Techo: $%{y:,.2f}<extra></extra>'
    };
    const traceLower = {
      x: dates, y: lower,
      name: 'Límite inferior',
      line: { color: C.lower, width: 1.5, dash: 'dot' },
      type: 'scatter',
      hovertemplate: 'Piso: $%{y:,.2f}<extra></extra>'
    };
    const traceCenter = {
      x: dates, y: center,
      name: 'Centro de banda',
      line: { color: C.center, width: 1.5, dash: 'longdash' },
      type: 'scatter',
      hovertemplate: 'Centro: $%{y:,.2f}<extra></extra>'
    };
    const tracePrice = {
      x: dates, y: prices,
      name: 'USD Mayorista A3500',
      line:   { color: C.price, width: 2.5 },
      marker: { color: markerColors, size: 4 },
      type:   'scatter',
      customdata: filtered.map(d => [
        d.gapToUpper, d.gapToLower, d.streakAboveUpper, d.streakBelowLower
      ]),
      hovertemplate:
        '<b>%{x|%d/%m/%Y}</b><br>' +
        'USD: <b>$%{y:,.2f}</b><br>' +
        'Al techo: %{customdata[0]:.2f}%<br>' +
        'Al piso: %{customdata[1]:.2f}%<br>' +
        'Racha ↑: %{customdata[2]}d | ↓: %{customdata[3]}d' +
        '<extra></extra>'
    };

    // Marcadores de cambio de banda
    const filteredChanges = bandChanges.filter(c =>
      c.date >= filtered[0].date && c.date <= filtered[filtered.length - 1].date
    );

    const traceChanges = {
      x: filteredChanges.map(c => c.date),
      y: filteredChanges.map(c => c.triggerValue),
      name: 'Cambio de banda',
      mode: 'markers',
      marker: {
        symbol: 'diamond',
        size:   12,
        color:  filteredChanges.map(c => c.direction === 'up' ? C.triggerUp : C.triggerDown),
        line:   { color: C.trigger, width: 2 }
      },
      type: 'scatter',
      customdata: filteredChanges.map(c => [c.oldCenter, c.newCenter, c.direction]),
      hovertemplate:
        '<b>CAMBIO DE BANDA</b><br>' +
        'Fecha: %{x|%d/%m/%Y}<br>' +
        'Valor gatillante: $%{y:,.2f}<br>' +
        'Centro: $%{customdata[0]:,.2f} → $%{customdata[1]:,.2f}<br>' +
        'Dirección: %{customdata[2]}' +
        '<extra></extra>'
    };

    const traces = [
      traceBandUpper, traceBandFill,
      traceUpper, traceLower, traceCenter,
      tracePrice, traceChanges
    ];

    const layout = {
      ...baseLayout(),
      yaxis: {
        ...baseLayout().yaxis,
        title: { text: 'ARS por USD', font: { size: 11 } }
      },
      shapes: buildAlertShapes(filtered)
    };

    Plotly.react(el, traces, layout, {
      displayModeBar: true,
      modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'],
      displaylogo: false,
      responsive: true,
      toImageButtonOptions: {
        format: 'png', filename: 'banda-cambiaria', scale: 2
      }
    });
  }

  function buildAlertShapes(states) {
    const shapes = [];
    // Marcar días fuera de banda
    for (const s of states) {
      if (!s.isInsideBand) {
        shapes.push({
          type: 'rect',
          x0: s.date, x1: s.date,
          y0: 0, y1: 1,
          yref: 'paper',
          line: {
            color: s.isAboveUpper ? C.red : C.blue,
            width: 1,
            dash:  'dot'
          },
          opacity: 0.2
        });
      }
    }
    return shapes;
  }

  // ── 2. Gauge de probabilidad ──────────────────────────────────────────────

  function renderProbabilityGauge(probAlcista, probBajista) {
    const el = document.getElementById('prob-gauge');
    if (!el) return;

    // Convertir a porcentajes
    const pctAlcista = Math.round((probAlcista || 0) * 100);
    const pctBajista = Math.round((probBajista || 0) * 100);
    const pctTotal = pctAlcista + pctBajista;

    // Gauge circular: ALCISTA (arriba, ROJO) vs BAJISTA (abajo, AZUL)
    const trace = {
      type:  'indicator',
      mode:  'gauge+number+delta',
      value: pctAlcista,
      number: {
        suffix: '%',
        font: { size: 50, color: C.red, weight: 'bold' }
      },
      delta: {
        reference: pctBajista,
        increasing: { color: C.red },
        decreasing: { color: C.info },
        suffix: '% bajista'
      },
      gauge: {
        axis: {
          range: [0, 100],
          tickwidth: 2,
          tickcolor: C.gridline,
          tickfont:  { size: 11, color: C.textMuted }
        },
        bar: { color: C.red, thickness: 0.15 },
        bgcolor: _darkMode ? '#1e293b' : '#f1f5f9',
        borderwidth: 2,
        bordercolor: C.gridline,
        // 3 zonas: ROJO (alcista), BLANCO (neutral), AZUL (bajista)
        steps: [
          { range: [0, 33],   color: 'rgba(59, 130, 246, 0.20)' },  // Azul bajista
          { range: [33, 67],  color: 'rgba(100, 116, 139, 0.10)' }, // Gris neutral
          { range: [67, 100], color: 'rgba(239, 68, 68, 0.20)' }    // Rojo alcista
        ],
        threshold: {
          line:  { color: C.textMuted, width: 2, dash: 'dot' },
          thickness: 0.5,
          value: 50
        }
      }
    };

    Plotly.react(el, [trace], {
      title: {
        text: `<b>Probabilidad de Cambio de Banda</b><br><span style="font-size:12px; color:${C.textMuted}">ALCISTA (rojo) vs BAJISTA (azul)</span>`,
        font: { size: 16, color: C.text }
      },
      paper_bgcolor: C.bg,
      plot_bgcolor:  C.bg,
      margin:  { t: 60, b: 20, l: 20, r: 20 },
      height:  280,
      font:    { family: 'Inter, system-ui', color: C.text }
    }, { displayModeBar: false, responsive: true });
  }

  // ── 3. Band Pressure Index ────────────────────────────────────────────────

  function renderBandPressureChart(dailyStates, period = '3m') {
    const el = document.getElementById('pressure-chart');
    if (!el) return;

    const filtered = filterByPeriod(dailyStates, period);
    if (filtered.length === 0) return;

    const dates     = filtered.map(d => d.date);
    const pressures = filtered.map(d => {
      const pos = Utils.clamp(d.positionPct, 0, 1);
      return Utils.roundTo(pos * 100, 1);
    });

    const colors = pressures.map(p =>
      p > 80 ? C.red : p < 20 ? C.blue : C.green
    );

    Plotly.react(el, [{
      x: dates, y: pressures,
      type:      'bar',
      marker:    { color: colors },
      name:      'Presión de banda',
      hovertemplate: '%{x|%d/%m/%Y}: <b>%{y:.1f}</b>/100<extra></extra>'
    }], {
      ...baseLayout(),
      yaxis: {
        ...baseLayout().yaxis,
        range: [0, 100],
        tickprefix: '',
        title: { text: 'Índice (0=piso, 100=techo)', font: { size: 10 } }
      },
      shapes: [
        { type: 'line', x0: dates[0], x1: dates[dates.length-1], y0: 80, y1: 80,
          line: { color: C.red,  width: 1, dash: 'dot' }, yref: 'y' },
        { type: 'line', x0: dates[0], x1: dates[dates.length-1], y0: 20, y1: 20,
          line: { color: C.blue, width: 1, dash: 'dot' }, yref: 'y' },
        { type: 'line', x0: dates[0], x1: dates[dates.length-1], y0: 50, y1: 50,
          line: { color: C.center, width: 1, dash: 'longdash' }, yref: 'y' }
      ]
    }, { displayModeBar: false, responsive: true });
  }

  // ── 4. Gráfico de backtest ────────────────────────────────────────────────

  function renderBacktestChart(backtestResults) {
    const el = document.getElementById('backtest-chart');
    if (!el || !backtestResults) return;

    const { results } = backtestResults;
    if (!results || results.length === 0) return;

    const dates     = results.map(r => r.date);
    const probs     = results.map(r => r.prob * 100);
    const actuals   = results.filter(r => r.actual === 1).map(r => r.date);
    const actualProbs = results.filter(r => r.actual === 1).map(r => r.prob * 100);

    const traceProb = {
      x: dates, y: probs,
      name:      'Probabilidad estimada',
      type:      'scatter',
      line:      { color: C.price, width: 1.5 },
      fill:      'tozeroy',
      fillcolor: `rgba(37,99,235,0.08)`,
      hovertemplate: '%{x|%d/%m/%Y}: %{y:.1f}%<extra></extra>'
    };

    const traceActual = {
      x: actuals, y: actualProbs,
      name:      'Cambio real',
      mode:      'markers',
      marker:    { symbol: 'star', size: 14, color: C.red, line: { color: 'white', width: 1 } },
      type:      'scatter',
      hovertemplate: 'Cambio real: %{x|%d/%m/%Y}<extra></extra>'
    };

    Plotly.react(el, [traceProb, traceActual], {
      ...baseLayout(),
      yaxis: {
        ...baseLayout().yaxis,
        range:       [0, 100],
        tickprefix:  '',
        ticksuffix:  '%',
        title:       { text: 'Prob. cambio (%)', font: { size: 10 } }
      },
      shapes: [{
        type: 'line',
        x0: dates[0], x1: dates[dates.length - 1],
        y0: 50, y1: 50,
        line: { color: C.trigger, width: 1, dash: 'dot' },
        yref: 'y'
      }]
    }, { displayModeBar: false, responsive: true });
  }

  // ── 5. Sparkline de retorno diario ────────────────────────────────────────

  function renderReturnSparkline(dailyStates, period = '3m') {
    const el = document.getElementById('return-sparkline');
    if (!el) return;

    const filtered = filterByPeriod(dailyStates, period);
    if (filtered.length < 2) return;

    const returns = [];
    for (let i = 1; i < filtered.length; i++) {
      returns.push({
        date:  filtered[i].date,
        value: Utils.pctReturn(filtered[i-1].value, filtered[i].value) * 100
      });
    }

    const colors = returns.map(r => r.value >= 0 ? C.red : C.blue);

    Plotly.react(el, [{
      x: returns.map(r => r.date),
      y: returns.map(r => r.value),
      type:      'bar',
      marker:    { color: colors },
      name:      'Var. diaria %',
      hovertemplate: '%{x|%d/%m/%Y}: <b>%{y:.3f}%</b><extra></extra>'
    }], {
      ...baseLayout(),
      yaxis: {
        ...baseLayout().yaxis,
        tickprefix:  '',
        ticksuffix:  '%',
        title:       { text: 'Var. diaria', font: { size: 10 } }
      },
      margin: { t: 20, r: 16, b: 40, l: 60 }
    }, { displayModeBar: false, responsive: true });
  }

  // ── Filtro por período ────────────────────────────────────────────────────

  function filterByPeriod(data, period) {
    const today = Utils.formatDate(new Date());
    let cutoff;
    switch (period) {
      case '1m':   cutoff = Utils.formatDate(Utils.monthsAgo(new Date(), 1));  break;
      case '3m':   cutoff = Utils.formatDate(Utils.monthsAgo(new Date(), 3));  break;
      case '6m':   cutoff = Utils.formatDate(Utils.monthsAgo(new Date(), 6));  break;
      case '12m':  cutoff = Utils.formatDate(Utils.monthsAgo(new Date(), 12)); break;
      case 'ytd':  cutoff = Utils.formatDate(Utils.startOfYear(new Date()));   break;
      case 'all':  cutoff = '2000-01-01'; break;
      default:     cutoff = Utils.formatDate(Utils.monthsAgo(new Date(), 3));
    }
    return data.filter(d => d.date >= cutoff && d.date <= today);
  }

  // ── Resize ────────────────────────────────────────────────────────────────

  function resizeAll() {
    ['main-chart', 'prob-gauge', 'pressure-chart', 'backtest-chart', 'return-sparkline']
      .forEach(id => {
        const el = document.getElementById(id);
        if (el && el.data) Plotly.relayout(el, { autosize: true });
      });
  }

  // ── Exportar chart como imagen ────────────────────────────────────────────

  function exportMainChart() {
    const el = document.getElementById('main-chart');
    if (!el) return;
    Plotly.downloadImage(el, {
      format:   'png',
      filename: `banda-cambiaria-${Utils.formatDate(new Date())}`,
      scale:    2,
      width:    1400,
      height:   600
    });
  }

  // ── Exportación ───────────────────────────────────────────────────────────

  return {
    renderMainChart,
    renderProbabilityGauge,
    renderBandPressureChart,
    renderBacktestChart,
    renderReturnSparkline,
    filterByPeriod,
    setDarkMode,
    resizeAll,
    exportMainChart
  };

})();

window.Charts = Charts;
