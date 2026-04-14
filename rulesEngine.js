/**
 * rulesEngine.js — Motor de reglas Tetra Pak (Esquema de Ancho de Banda)
 *
 * REGLA OFICIAL:
 *   Si el PROMEDIO SEMANAL del USD-ARS (Banco Nación) excede ±5% del centro
 *   de banda vigente, el precio se ajusta el LUNES de la semana siguiente.
 *
 *   Ajuste de precio:
 *     PM y Straws → 86% de la variación del tipo de cambio
 *     AM y TRC    → 100% de la variación del tipo de cambio
 *
 *   Feriados: se completan con los días hábiles inmediatamente anteriores
 *   de la semana previa (1 feriado → viernes previo; 2 → jueves+viernes).
 *
 *   El promedio siempre se calcula con exactamente 5 observaciones.
 */

'use strict';

const RulesEngine = (() => {

  // ── Banda ─────────────────────────────────────────────────────────────────

  function calcBand(center, marginPct) {
    return {
      center,
      upper:  Utils.roundTo(center * (1 + marginPct / 100), 4),
      lower:  Utils.roundTo(center * (1 - marginPct / 100), 4),
      margin: marginPct
    };
  }

  // ── Helpers de fecha ──────────────────────────────────────────────────────

  /** Retorna el lunes (inicio de semana) de la fecha dada. */
  function getWeekStart(date) {
    const d   = Utils.toDate(date);
    const day = d.getDay(); // 0=Dom, 1=Lun...6=Sáb
    const diff = day === 0 ? -6 : 1 - day;
    const mon  = new Date(d);
    mon.setDate(d.getDate() + diff);
    return Utils.formatDate(mon);
  }

  /** Agrega N días calendario a una fecha. */
  function addDays(date, n) {
    const d = Utils.toDate(date);
    d.setDate(d.getDate() + n);
    return Utils.formatDate(d);
  }

  // ── Obtener los 5 días para el promedio semanal ───────────────────────────

  /**
   * Retorna exactamente 5 observaciones para la semana que empieza el lunes dado.
   * Si la semana tiene feriados (< 5 días con dato), completa hacia atrás
   * con los días hábiles inmediatamente anteriores.
   *
   * @param {string} weekMonday  - 'YYYY-MM-DD' del lunes de la semana
   * @param {Array}  allData     - Dataset completo ordenado ASC [{date,value}]
   * @param {number} minDays     - 5
   */
  function getWeeklyAverageDays(weekMonday, allData, minDays = 5) {
    const weekFriday = addDays(weekMonday, 4);

    // Días con dato en la semana (Lun-Vie)
    const thisWeek = allData.filter(d =>
      d.date >= weekMonday && d.date <= weekFriday
    );

    if (thisWeek.length >= minDays) return thisWeek.slice(0, minDays);

    // Faltan días → completar con los más recientes antes de la semana
    const needed  = minDays - thisWeek.length;
    const priorDays = allData
      .filter(d => d.date < weekMonday)
      .slice(-needed);

    return [...priorDays, ...thisWeek];
  }

  // ── Simulación histórica semanal ──────────────────────────────────────────

  /**
   * Simula la regla semana a semana sobre toda la historia.
   *
   * @param {Array}  data    - [{date, value, ref?}] ordenado ASC
   * @param {Object} config  - { initialCenter, marginPct, minDays, pmFactor, amFactor }
   *
   * @returns {Object} { dailyStates, weeklyStates, bandChanges, currentBand, currentWeek, usdTracker }
   */
  function simulate(data, config) {
    const {
      initialCenter = 1444.8,
      marginPct     = 5,
      minDays       = 5,
      pmFactor      = 86,
      amFactor      = 100
    } = config;

    if (!data || data.length === 0) {
      return {
        dailyStates:  [],
        weeklyStates: [],
        bandChanges:  [],
        currentBand:  calcBand(initialCenter, marginPct),
        currentWeek:  null,
        usdTracker:   { cumulativeUsdLossPct: 0, bandJumpsUp: 0 }
      };
    }

    // ── Agrupar datos por semana ────────────────────────────────────────────
    const weekSet = new Set(data.map(d => getWeekStart(d.date)));
    const weeks   = Array.from(weekSet).sort();

    let band        = calcBand(initialCenter, marginPct);
    const weeklyStates = [];
    const bandChanges  = [];

    for (const weekMonday of weeks) {
      const weekFriday = addDays(weekMonday, 4);
      const avgDays    = getWeeklyAverageDays(weekMonday, data, minDays);

      if (avgDays.length === 0) continue;

      const average = Utils.mean(avgDays.map(d => d.value));
      const avgPctFromCenter = (average - band.center) / band.center * 100;

      const oldBand       = { ...band };
      const isAboveUpper  = average > band.upper;
      const isBelowLower  = average < band.lower;

      let bandChanged   = false;
      let effectiveDate = null;
      let priceAdjPm    = null;
      let priceAdjAm    = null;
      let usdLossJump   = null;

      if (isAboveUpper || isBelowLower) {
        const direction  = isAboveUpper ? 'up' : 'down';
        const newCenter  = Utils.roundTo(average, 4);
        const variation  = (average - oldBand.center) / oldBand.center; // signed

        const newBand = calcBand(newCenter, marginPct);

        // Ajuste de precio en ARS
        priceAdjPm = Utils.roundTo(variation * (pmFactor  / 100) * 100, 4);
        priceAdjAm = Utils.roundTo(variation * (amFactor  / 100) * 100, 4);

        // Pérdida en USD por salto: el PM sube 86%*V%, el FX sube V%
        // Precio en USD = ARS / FX → (1+0.86V)/(1+V) - 1
        usdLossJump = Utils.roundTo(
          ((1 + (pmFactor / 100) * variation) / (1 + variation) - 1) * 100,
          4
        );

        // Fecha efectiva = lunes de la semana siguiente
        effectiveDate = addDays(weekMonday, 7);

        bandChanges.push({
          weekStart:    weekMonday,
          weekEnd:      weekFriday,
          effectiveDate,
          direction,
          triggerAverage: Utils.roundTo(average, 4),
          variationPct:   Utils.roundTo(variation * 100, 4),
          oldCenter:  oldBand.center,
          oldUpper:   oldBand.upper,
          oldLower:   oldBand.lower,
          newCenter:  newBand.center,
          newUpper:   newBand.upper,
          newLower:   newBand.lower,
          priceAdjPm,
          priceAdjAm,
          usdLossJump,
          days: avgDays.map(d => ({ date: d.date, value: d.value }))
        });

        band        = newBand;
        bandChanged = true;
      }

      weeklyStates.push({
        weekStart:   weekMonday,
        weekEnd:     weekFriday,
        days:        avgDays,
        dayCount:    avgDays.length,
        average:     Utils.roundTo(average, 4),
        // Band BEFORE the potential change (for display)
        center:      oldBand.center,
        upper:       oldBand.upper,
        lower:       oldBand.lower,
        // Band AFTER the potential change (effective for next week)
        centerNext:  band.center,
        upperNext:   band.upper,
        lowerNext:   band.lower,
        avgPctFromCenter: Utils.roundTo(avgPctFromCenter, 4),
        isAboveUpper,
        isBelowLower,
        isInsideBand: !isAboveUpper && !isBelowLower,
        bandChanged,
        effectiveDate,
        priceAdjPm,
        priceAdjAm,
        usdLossJump
      });
    }

    // ── Construir dailyStates (para gráficos y tabla) ────────────────────────
    const dailyStates = buildDailyStates(data, weeklyStates, bandChanges, config);

    // ── Estado de la semana actual (parcial) ─────────────────────────────────
    const currentWeek = getCurrentWeekState(data, band, config);

    // ── Tracker de pérdida en USD ─────────────────────────────────────────────
    const usdTracker = computeUsdTracker(bandChanges, pmFactor);

    return { dailyStates, weeklyStates, bandChanges, currentBand: band, currentWeek, usdTracker };
  }

  // ── Daily states (para compatibilidad con charts.js) ─────────────────────

  function buildDailyStates(data, weeklyStates, bandChanges, config) {
    const { operativeCenter, initialCenter = 1444.8, marginPct = 5 } = config;
    const centerToUse = operativeCenter || initialCenter;

    // Mapear semana → estado semanal (indexed by weekStart)
    const weekMap = new Map(weeklyStates.map(w => [w.weekStart, w]));

    // Mapear effectiveDate → banda nueva (para cambios que toman efecto ese día)
    const effectiveMap = new Map(
      bandChanges.map(c => [c.effectiveDate, { center: c.newCenter, upper: c.newUpper, lower: c.newLower }])
    );

    // Reconstituir la banda vigente día a día (respetando effective dates)
    let activeBand = { center: null, upper: null, lower: null };

    // Precomputar la banda vigente para cada día
    // Partir del operativeCenter para evaluar todos los días de forma consistente
    if (weeklyStates.length > 0) {
      activeBand = calcBand(centerToUse, marginPct);
    }

    const result = [];
    let consAboveCenter = 0;
    let consBelowCenter = 0;

    // Precalcular el band vigente para cada día para los streaks
    const bandHistory = [];
    let currentBand = weeklyStates.length > 0
      ? calcBand(centerToUse, marginPct)
      : { center: null, upper: null, lower: null };

    for (let i = 0; i < data.length; i++) {
      if (effectiveMap.has(data[i].date)) {
        currentBand = effectiveMap.get(data[i].date);
      }
      bandHistory[i] = { ...currentBand };
    }

    for (let i = 0; i < data.length; i++) {
      const { date, value } = data[i];

      // NOT actualizar activeBand basado en cambios de banda históricos
      // Todos los días se evalúan contra operativeCenter de forma consistente
      // (Los cambios de banda se muestran en la sección de histórico, pero no afectan
      // la evaluación diaria contra el centro operativo actual)

      const ws = getWeekStart(date);
      const week = weekMap.get(ws);

      const bandWidth   = activeBand.upper - activeBand.lower;
      const positionPct = bandWidth > 0 ? (value - activeBand.lower) / bandWidth : 0.5;
      const gapToUpper  = activeBand.center ? Utils.roundTo((activeBand.upper - value) / activeBand.center * 100, 4) : 0;
      const gapToLower  = activeBand.center ? Utils.roundTo((value - activeBand.lower) / activeBand.center * 100, 4) : 0;
      const gapToCenter = activeBand.center ? Utils.roundTo((value - activeBand.center) / activeBand.center * 100, 4) : 0;

      const isAboveUpper = activeBand.upper !== null && value > activeBand.upper;
      const isBelowLower = activeBand.lower !== null && value < activeBand.lower;

      if (activeBand.center && value > activeBand.center) { consAboveCenter++; consBelowCenter = 0; }
      else if (activeBand.center && value < activeBand.center) { consBelowCenter++; consAboveCenter = 0; }
      else { consAboveCenter = 0; consBelowCenter = 0; }

      // Racha de días sobre/bajo el límite (usando band histórico correcto para cada día)
      let streakAboveUpper = 0, streakBelowLower = 0;
      for (let j = i; j >= 0; j--) {
        const histBand = bandHistory[j];
        if (histBand.upper !== null && data[j].value > histBand.upper) streakAboveUpper++;
        else break;
      }
      for (let j = i; j >= 0; j--) {
        const histBand = bandHistory[j];
        if (histBand.lower !== null && data[j].value < histBand.lower) streakBelowLower++;
        else break;
      }

      // ¿La semana de esta fecha activó un cambio?
      const bandJustChanged = week ? (week.bandChanged && week.effectiveDate === date) : false;

      result.push({
        date,
        value,
        ref: data[i].ref || value,
        center:   activeBand.center,
        upper:    activeBand.upper,
        lower:    activeBand.lower,
        positionPct,
        gapToUpper,
        gapToLower,
        gapToCenter,
        isAboveUpper,
        isBelowLower,
        isInsideBand: !isAboveUpper && !isBelowLower,
        consecutiveAboveCenter: consAboveCenter,
        consecutiveBelowCenter: consBelowCenter,
        streakAboveUpper,
        streakBelowLower,
        // Contexto semanal
        weekStart:    ws,
        weekAverage:  week ? week.average : null,
        weekAvgAboveUpper: week ? week.isAboveUpper : false,
        weekAvgBelowLower: week ? week.isBelowLower : false,
        weekAvgPctFromCenter: week ? week.avgPctFromCenter : null,
        bandJustChanged,
        // Para compatibilidad con el motor de probabilidad
        ruleWindowDays: week ? week.days.map(d => ({
          date:      d.date,
          value:     d.value,
          aboveUpper: d.value > activeBand.upper,
          belowLower: d.value < activeBand.lower
        })) : [],
        ruleStatus: week
          ? (week.bandChanged ? 'triggered'
            : week.isAboveUpper || week.isBelowLower ? 'alertAbove'
            : week.avgPctFromCenter > 3 ? 'alertAbove'
            : week.avgPctFromCenter < -3 ? 'alertBelow'
            : 'neutral')
          : 'neutral'
      });
    }
    return result;
  }

  // ── Semana actual (parcial) ───────────────────────────────────────────────

  /**
   * Retorna el estado de la semana en curso (puede ser incompleta).
   * Muestra cuánto falta para cruzar el umbral con los días restantes.
   */
  function getCurrentWeekState(data, currentBand, config) {
    const { minDays = 5 } = config;
    if (!data || data.length === 0) return null;

    const lastDate    = data[data.length - 1].date;
    const weekMonday  = getWeekStart(lastDate);
    const weekFriday  = addDays(weekMonday, 4);

    // Días disponibles de esta semana
    const thisWeekDays = data.filter(d => d.date >= weekMonday && d.date <= weekFriday);

    // ¿Ya completó la semana?
    const lastDayOfWeek = thisWeekDays[thisWeekDays.length - 1];
    const isComplete = thisWeekDays.length >= minDays;

    // Completar con días previos si es necesario
    const avgDays = getWeeklyAverageDays(weekMonday, data, minDays);

    const partialAvg = avgDays.length > 0 ? Utils.mean(avgDays.map(d => d.value)) : null;
    const daysObserved = thisWeekDays.length;
    const daysFilled   = avgDays.length - daysObserved;   // Días llenados de semana anterior
    const daysRemaining = Math.max(0, minDays - avgDays.length); // Negocio-días que aún faltan

    // Distancia del promedio parcial al umbral
    const distToUpper = partialAvg ? Utils.roundTo((currentBand.upper - partialAvg) / currentBand.center * 100, 4) : null;
    const distToLower = partialAvg ? Utils.roundTo((partialAvg - currentBand.lower) / currentBand.center * 100, 4) : null;

    // ¿Qué promedio necesitarían los días restantes para cruzar el umbral?
    let avgNeededForUpper = null, avgNeededForLower = null;
    if (daysRemaining > 0 && avgDays.length > 0) {
      const sumSoFar  = avgDays.reduce((s, d) => s + d.value, 0);
      avgNeededForUpper = (currentBand.upper * minDays - sumSoFar) / daysRemaining;
      avgNeededForLower = (currentBand.lower * minDays - sumSoFar) / daysRemaining;
    }

    // ¿Ya se cruzó?
    const avgAboveUpper = partialAvg !== null && partialAvg > currentBand.upper;
    const avgBelowLower = partialAvg !== null && partialAvg < currentBand.lower;

    // Fecha efectiva si se activara esta semana
    const effectiveDate = addDays(weekMonday, 7);

    return {
      weekStart:     weekMonday,
      weekEnd:       weekFriday,
      effectiveDate,
      isComplete,
      days:          avgDays,
      daysObserved,
      daysFilled,
      daysRemaining,
      partialAverage: partialAvg ? Utils.roundTo(partialAvg, 4) : null,
      avgPctFromCenter: partialAvg ? Utils.roundTo((partialAvg - currentBand.center) / currentBand.center * 100, 4) : null,
      distToUpper,
      distToLower,
      avgAboveUpper,
      avgBelowLower,
      avgNeededForUpper: avgNeededForUpper ? Utils.roundTo(avgNeededForUpper, 2) : null,
      avgNeededForLower: avgNeededForLower ? Utils.roundTo(avgNeededForLower, 2) : null,
      center: currentBand.center,
      upper:  currentBand.upper,
      lower:  currentBand.lower
    };
  }

  // ── Tracker de pérdida en USD ─────────────────────────────────────────────

  /**
   * Calcula la pérdida acumulada en USD por los saltos de banda alcistas.
   * Con cada salto, el PM sube 86% de la variación FX → el precio en USD cae ~0.7-0.8%.
   * Cada 6 saltos se necesita un aumento fuera de banda del ~5%.
   */
  function computeUsdTracker(bandChanges, pmFactor = 86) {
    const upChanges = bandChanges.filter(c => c.direction === 'up');
    let cumulativeUsdLossPct = 0;

    for (const c of upChanges) {
      cumulativeUsdLossPct += c.usdLossJump || 0;
    }

    const bandJumpsUp              = upChanges.length;
    const JUMPS_PER_OOB            = 6;
    const OOB_RECOVERY_PCT         = 5;
    const jumpsToNextOutOfBand     = JUMPS_PER_OOB - (bandJumpsUp % JUMPS_PER_OOB);
    const outOfBandRecommendedPct  = OOB_RECOVERY_PCT * Math.floor(bandJumpsUp / JUMPS_PER_OOB);

    return {
      bandJumpsUp,
      bandJumpsDown:        bandChanges.filter(c => c.direction === 'down').length,
      cumulativeUsdLossPct: Utils.roundTo(cumulativeUsdLossPct, 4),
      avgUsdLossPerJump:    bandJumpsUp > 0 ? Utils.roundTo(cumulativeUsdLossPct / bandJumpsUp, 4) : 0,
      jumpsToNextOutOfBand: jumpsToNextOutOfBand === JUMPS_PER_OOB ? 0 : jumpsToNextOutOfBand,
      outOfBandRecommendedPct,
      pmFactor
    };
  }

  // ── Estado actual ─────────────────────────────────────────────────────────

  function getCurrentState(dailyStates) {
    if (!dailyStates || dailyStates.length === 0) return null;
    return dailyStates[dailyStates.length - 1];
  }

  // ── Etiquetas de estado ───────────────────────────────────────────────────

  function getStatusLabel(currentWeek, dailyState) {
    if (!currentWeek) return 'Sin datos';

    if (currentWeek.isComplete && (currentWeek.avgAboveUpper || currentWeek.avgBelowLower))
      return 'Cambio de banda activado';
    if (currentWeek.avgAboveUpper || currentWeek.avgBelowLower)
      return 'Cambio de banda probable';
    if (currentWeek.distToUpper !== null && currentWeek.distToUpper < 2)
      return 'Vigilancia alcista';
    if (currentWeek.distToLower !== null && currentWeek.distToLower < 2)
      return 'Vigilancia bajista';
    if (currentWeek.avgPctFromCenter > 2)  return 'Vigilancia alcista';
    if (currentWeek.avgPctFromCenter < -2) return 'Vigilancia bajista';
    return 'Sin señal';
  }

  function getStatusClass(label) {
    const map = {
      'Cambio de banda activado': 'status-triggered',
      'Cambio de banda probable': 'status-probable',
      'Vigilancia alcista':        'status-watch-up',
      'Vigilancia bajista':        'status-watch-down',
      'Sin señal':                 'status-neutral',
      'Sin datos':                 'status-neutral'
    };
    return map[label] || 'status-neutral';
  }

  // ── Band Pressure Index (0–100) ───────────────────────────────────────────

  function calcBandPressureIndex(currentWeek) {
    if (!currentWeek || currentWeek.partialAverage === null) return 50;
    const { partialAverage, lower, upper } = currentWeek;
    const bandWidth = upper - lower;
    if (bandWidth <= 0) return 50;
    return Utils.roundTo(Utils.clamp((partialAverage - lower) / bandWidth * 100, 0, 100), 1);
  }

  // ── Explicación de la ventana semanal ─────────────────────────────────────

  function explainWindow(currentWeek) {
    if (!currentWeek) return '<p>Sin datos disponibles.</p>';
    const lines = [];
    lines.push(`<strong>Banda vigente:</strong>`);
    lines.push(`Centro: <b>${Utils.formatNumber(currentWeek.center)}</b> | ` +
               `Superior: <b>${Utils.formatNumber(currentWeek.upper)}</b> | ` +
               `Inferior: <b>${Utils.formatNumber(currentWeek.lower)}</b>`);
    lines.push(`<br><strong>Semana ${Utils.formatDateDisplay(currentWeek.weekStart)} — ${Utils.formatDateDisplay(currentWeek.weekEnd)}</strong>`);
    lines.push(`Días observados: ${currentWeek.daysObserved} | Días llenados de sem. anterior: ${currentWeek.daysFilled}`);
    lines.push(`<br><strong>Observaciones utilizadas:</strong>`);
    currentWeek.days.forEach((d, i) => {
      const aboveUpper = d.value > currentWeek.upper;
      const belowLower = d.value < currentWeek.lower;
      const pos = aboveUpper ? '🔴 sobre techo' : belowLower ? '🔵 bajo piso' : '🟢 dentro';
      lines.push(`Día ${i+1}: ${Utils.formatDateDisplay(d.date)} — ${Utils.formatNumber(d.value)} ARS — ${pos}`);
    });
    if (currentWeek.partialAverage !== null) {
      const status = currentWeek.avgAboveUpper ? '🔴 SUPERA EL TECHO' :
                     currentWeek.avgBelowLower ? '🔵 SUPERA EL PISO' : '🟢 dentro de banda';
      lines.push(`<br><strong>Promedio semanal: <b>${Utils.formatNumber(currentWeek.partialAverage)}</b> → ${status}</strong>`);
      lines.push(`Desvío vs centro: ${Utils.formatNumber(currentWeek.avgPctFromCenter)}%`);
      if (!currentWeek.avgAboveUpper && currentWeek.distToUpper !== null)
        lines.push(`Distancia al techo: ${Utils.formatNumber(currentWeek.distToUpper)}%`);
      if (!currentWeek.avgBelowLower && currentWeek.distToLower !== null)
        lines.push(`Distancia al piso: ${Utils.formatNumber(currentWeek.distToLower)}%`);
    }
    if (currentWeek.daysRemaining > 0) {
      lines.push(`<br><em>Faltan ${currentWeek.daysRemaining} día(s) para completar la semana.</em>`);
      if (currentWeek.avgNeededForUpper !== null) {
        lines.push(`Para cruzar el techo, los días restantes necesitan promediar: <b>${Utils.formatNumber(currentWeek.avgNeededForUpper)}</b>`);
      }
    }
    if (currentWeek.avgAboveUpper || currentWeek.avgBelowLower) {
      lines.push(`<br>🔔 <strong>Fecha efectiva de ajuste: ${Utils.formatDateDisplay(currentWeek.effectiveDate)}</strong>`);
    }
    return lines.join('<br>');
  }

  // ── Exportación ───────────────────────────────────────────────────────────

  return {
    calcBand,
    simulate,
    getWeekStart,
    getCurrentWeekState,
    getCurrentState,
    computeUsdTracker,
    getStatusLabel,
    getStatusClass,
    calcBandPressureIndex,
    explainWindow
  };

})();

window.RulesEngine = RulesEngine;
