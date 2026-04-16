/**
 * probabilityEngine.js — Motor de probabilidad de cambio de banda
 *
 * Tres capas:
 *  1. Empírica histórica (vecinos más cercanos)
 *  2. Regresión logística entrenada in-browser
 *  3. Ajuste por noticias (news pressure score)
 */

'use strict';

const ProbabilityEngine = (() => {

  let _model     = null;   // Pesos de la regresión logística
  let _trainData = null;   // { X, y, featureNames }
  let _scaleParams = null; // { means, stds } para normalizar features

  // ── Features ──────────────────────────────────────────────────────────────

  /**
   * Extrae features para el día i del array dailyStates.
   * Requiere suficiente historial previo.
   */
  function extractFeatures(dailyStates, i) {
    const s = dailyStates[i];
    if (!s) return null;

    const prices = dailyStates.slice(0, i + 1).map(d => d.value);
    const n      = prices.length;

    const ret = (k) => {
      if (n <= k) return 0;
      return Utils.pctReturn(prices[n - 1 - k], prices[n - 1]);
    };

    const rollingVol = (k) => {
      if (n < k + 1) return 0;
      const window = [];
      for (let j = 1; j <= k; j++) {
        window.push(Utils.pctReturn(prices[n - 1 - j], prices[n - j]));
      }
      return Utils.stdDev(window);
    };

    const slope = (k) => {
      if (n < k) return 0;
      const ys = prices.slice(n - k);
      const xs = ys.map((_, idx) => idx);
      return Utils.linearRegression(xs, ys).slope / (ys[0] || 1);
    };

    const bandWidth = s.upper - s.lower;

    // Frecuencia de días fuera de banda en últimos 5 días
    // (capturas no solo rachas, sino patrones intermitentes)
    const freqOutOfBand = (k) => {
      if (n <= k) return 0;
      const window = dailyStates.slice(Math.max(0, n - k), n);
      const countOut = window.filter(d => d.isAboveUpper || d.isBelowLower).length;
      return countOut / window.length;
    };

    const freqAboveUpper = (k) => {
      if (n <= k) return 0;
      const window = dailyStates.slice(Math.max(0, n - k), n);
      const count = window.filter(d => d.isAboveUpper).length;
      return count / window.length;
    };

    const freqBelowLower = (k) => {
      if (n <= k) return 0;
      const window = dailyStates.slice(Math.max(0, n - k), n);
      const count = window.filter(d => d.isBelowLower).length;
      return count / window.length;
    };

    // Puntuación de proximidad con decaimiento exponencial
    // Valores cercanos al límite tienen mayor peso
    const proximityScore = (k) => {
      if (n <= k) return 0;
      const window = dailyStates.slice(Math.max(0, n - k), n);
      let score = 0;
      window.forEach((d, idx) => {
        const daysAgo = window.length - idx;
        const recencyFactor = Math.exp(-daysAgo / 3); // Recencia: días recientes pesan más
        if (d.isAboveUpper) {
          // Qué tan lejos del techo? Si gapToUpper es negativo, ya lo superó
          const distFromThreshold = Math.max(0, d.gapToUpper) / 100;
          score += (1 - distFromThreshold) * recencyFactor; // Cercano = 1, lejano = 0
        }
        if (d.isBelowLower) {
          const distFromThreshold = Math.max(0, d.gapToLower) / 100;
          score += (1 - distFromThreshold) * recencyFactor;
        }
      });
      return Math.min(score / window.length, 1); // Normalizar 0-1
    };

    // Volatilidad de las brechas: cambios agresivos en distancia a límites
    const gapVolatility = (k) => {
      if (n <= k + 1) return 0;
      const window = dailyStates.slice(Math.max(0, n - k), n);
      const gaps = window.map(d => {
        const upGap = d.isAboveUpper ? Math.abs(d.gapToUpper) : 0;
        const downGap = d.isBelowLower ? Math.abs(d.gapToLower) : 0;
        return upGap + downGap;
      });
      if (gaps.length < 2) return 0;
      return Utils.stdDev(gaps) / (Math.max(...gaps) || 0.01);
    };

    // Días desde último evento fuera de banda (recencia)
    const daysSinceOutOfBand = (k) => {
      if (n <= k) return k; // Si no hay datos, devuelve k (máximo)
      const window = dailyStates.slice(Math.max(0, n - k), n);
      for (let j = window.length - 1; j >= 0; j--) {
        if (window[j].isAboveUpper || window[j].isBelowLower) {
          return (window.length - 1 - j); // 0 si hoy, 1 si ayer, etc.
        }
      }
      return k; // No hubo evento
    };

    return [
      s.gapToUpper / 100,                        // 0: distancia al techo (pct)
      s.gapToLower / 100,                        // 1: distancia al piso (pct)
      s.gapToCenter / 100,                       // 2: distancia al centro (pct)
      s.positionPct,                             // 3: posición relativa en banda
      s.streakAboveUpper / 5,                    // 4: racha sobre techo (norm.)
      s.streakBelowLower / 5,                    // 5: racha bajo piso (norm.)
      s.consecutiveAboveCenter / 10,             // 6: racha sobre centro
      s.consecutiveBelowCenter / 10,             // 7: racha bajo centro
      ret(3),                                    // 8: retorno 3d
      ret(5),                                    // 9: retorno 5d
      ret(10),                                   // 10: retorno 10d
      rollingVol(5),                             // 11: vol 5d
      rollingVol(10),                            // 12: vol 10d
      rollingVol(20),                            // 13: vol 20d
      slope(5),                                  // 14: pendiente 5d
      slope(10),                                 // 15: pendiente 10d
      bandWidth > 0 ? bandWidth / s.center : 0,  // 16: amplitud relativa
      s.isAboveUpper ? 1 : 0,                    // 17: binario sobre techo
      s.isBelowLower ? 1 : 0,                    // 18: binario bajo piso
      freqOutOfBand(5),                          // 19: % días fuera de banda (5d)
      freqAboveUpper(5),                         // 20: % días sobre techo (5d)
      freqBelowLower(5),                         // 21: % días bajo piso (5d)
      proximityScore(5),                         // 22: puntuación de proximidad (5d)
      gapVolatility(5),                          // 23: volatilidad de brechas (5d)
      daysSinceOutOfBand(5) / 5,                 // 24: días desde último evento (5d, normalizado)
    ];
  }

  const FEATURE_NAMES = [
    'Gap al techo', 'Gap al piso', 'Gap al centro', 'Posición en banda',
    'Racha sobre techo', 'Racha bajo piso', 'Racha sobre centro', 'Racha bajo centro',
    'Retorno 3d', 'Retorno 5d', 'Retorno 10d',
    'Volatilidad 5d', 'Volatilidad 10d', 'Volatilidad 20d',
    'Pendiente 5d', 'Pendiente 10d',
    'Amplitud de banda', 'Sobre techo (bin)', 'Bajo piso (bin)',
    'Frec. fuera de banda (5d)', 'Frec. sobre techo (5d)', 'Frec. bajo piso (5d)',
    'Proximidad (5d)', 'Vol. brechas (5d)', 'Días desde evento (5d)'
  ];

  // ── Preparar datos de entrenamiento ──────────────────────────────────────

  /**
   * Crea el dataset de entrenamiento a partir de dailyStates.
   * Variable objetivo: ¿hubo cambio de banda en los próximos minDays?
   *
   * IMPORTANTE: No usamos look-ahead. Para la fila i, el target
   * se conoce mirando hacia adelante, pero en producción solo se
   * usa para entrenar sobre el pasado, nunca para el día actual.
   */
  function buildTrainingData(dailyStates, minDays = 5) {
    const X = [];
    const y = [];
    const N = dailyStates.length;

    for (let i = 20; i < N - minDays; i++) {
      const features = extractFeatures(dailyStates, i);
      if (!features) continue;

      // Target: ¿hubo bandJustChanged en los próximos minDays días?
      let label = 0;
      for (let j = i + 1; j <= Math.min(i + minDays, N - 1); j++) {
        if (dailyStates[j].bandJustChanged) { label = 1; break; }
      }

      X.push(features);
      y.push(label);
    }

    return { X, y, featureNames: FEATURE_NAMES };
  }

  // ── Normalización de features ─────────────────────────────────────────────

  function computeScaleParams(X) {
    const nFeatures = X[0].length;
    const means = new Array(nFeatures).fill(0);
    const stds  = new Array(nFeatures).fill(1);
    for (let j = 0; j < nFeatures; j++) {
      const col = X.map(row => row[j]);
      means[j]  = Utils.mean(col);
      stds[j]   = Utils.stdDev(col) || 1;
    }
    return { means, stds };
  }

  function scaleFeatures(x, params) {
    return x.map((v, j) => (v - params.means[j]) / params.stds[j]);
  }

  // ── Regresión logística (gradiente descendente) ───────────────────────────

  /**
   * Entrena regresión logística con gradiente descendente.
   * @returns { weights, bias, trainMetrics }
   */
  function trainLogisticRegression(X, y, opts = {}) {
    const { lr = 0.05, iterations = 500, l2 = 0.01 } = opts;
    const nSamples  = X.length;
    const nFeatures = X[0].length;
    const posCount  = y.filter(v => v === 1).length;
    const negCount  = nSamples - posCount;
    // Class weight para desbalance
    const wPos = posCount > 0 ? nSamples / (2 * posCount) : 1;
    const wNeg = negCount > 0 ? nSamples / (2 * negCount) : 1;

    let weights = new Array(nFeatures).fill(0);
    let bias    = 0;
    let lastLoss = Infinity;

    for (let iter = 0; iter < iterations; iter++) {
      const dw = new Array(nFeatures).fill(0);
      let   db = 0;
      let  loss = 0;

      for (let i = 0; i < nSamples; i++) {
        const z    = X[i].reduce((s, xi, j) => s + xi * weights[j], bias);
        const pred = Utils.sigmoid(z);
        const w    = y[i] === 1 ? wPos : wNeg;
        const err  = (pred - y[i]) * w;
        const eps  = 1e-9;
        loss += -w * (y[i] * Math.log(pred + eps) + (1 - y[i]) * Math.log(1 - pred + eps));
        for (let j = 0; j < nFeatures; j++) dw[j] += err * X[i][j];
        db += err;
      }

      // L2 regularization
      for (let j = 0; j < nFeatures; j++) {
        weights[j] = weights[j] - lr * (dw[j] / nSamples + l2 * weights[j]);
      }
      bias -= lr * db / nSamples;

      // Early stopping
      if (Math.abs(lastLoss - loss) < 1e-6 && iter > 50) break;
      lastLoss = loss;
    }

    // Métricas sobre training set
    const trainMetrics = evaluateModel(X, y, weights, bias);
    return { weights, bias, trainMetrics };
  }

  function evaluateModel(X, y, weights, bias, threshold = 0.5) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    let brierSum = 0;

    for (let i = 0; i < X.length; i++) {
      const z    = X[i].reduce((s, xi, j) => s + xi * weights[j], bias);
      const prob = Utils.sigmoid(z);
      const pred = prob >= threshold ? 1 : 0;
      brierSum  += (prob - y[i]) ** 2;
      if (pred === 1 && y[i] === 1) tp++;
      else if (pred === 1 && y[i] === 0) fp++;
      else if (pred === 0 && y[i] === 0) tn++;
      else fn++;
    }

    const accuracy   = (tp + tn) / X.length;
    const precision  = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall     = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1         = precision + recall > 0 ?
                       2 * precision * recall / (precision + recall) : 0;
    const brierScore = brierSum / X.length;

    return { tp, fp, tn, fn, accuracy, precision, recall, f1, brierScore };
  }

  // ── Búsqueda de vecinos históricos ───────────────────────────────────────

  /**
   * Encuentra los K vecinos más similares en el espacio de features.
   * Retorna la proporción que derivaron en cambio de banda.
   */
  function historicalLookup(currentFeatures, X, y, k = 30) {
    if (!X || X.length === 0) return 0.1;

    // Distancia euclidiana
    const distances = X.map((xRow, i) => {
      const d = xRow.reduce((s, xi, j) => s + (xi - currentFeatures[j]) ** 2, 0);
      return { dist: Math.sqrt(d), label: y[i] };
    });

    distances.sort((a, b) => a.dist - b.dist);
    const knn   = distances.slice(0, k);
    const posK  = knn.filter(d => d.label === 1).length;
    return posK / k;
  }

  // ── Probabilidad combinada ────────────────────────────────────────────────

  /**
   * Retorna la probabilidad final de cambio de banda (alcista y bajista).
   * Combina: regresión logística + vecinos históricos + ajuste por noticias.
   *
   * @param {Array}  currentFeatures - Features del día actual
   * @param {number} newsPressure    - Score de noticias [-100, 100]
   * @param {Object} config          - { newsMaxAdjust = 0.10, newsWeight = 0.3 }
   * @returns {Object} { probModel, probHistorical, probBase, newsAdjust, probFinal, probAlcista, probBajista }
   */
  function computeProbability(currentFeatures, newsPressure = 0, config = {}) {
    const { newsMaxAdjust = 0.10, newsWeight = 0.3 } = config;

    // Modelo no entrenado aún → probabilidad base por heurística
    if (!_model || !_trainData) {
      return heuristicProbability(currentFeatures, newsPressure, config);
    }

    // 1. Regresión logística
    const scaledFeatures = scaleFeatures(currentFeatures, _scaleParams);
    const z      = scaledFeatures.reduce((s, xi, j) => s + xi * _model.weights[j], _model.bias);
    const probModel = Utils.clamp(Utils.sigmoid(z), 0.01, 0.99);

    // 2. Vecinos históricos
    const scaledX    = _trainData.X.map(row => scaleFeatures(row, _scaleParams));
    const probHistorical = historicalLookup(scaledFeatures, scaledX, _trainData.y, 30);

    // 3. Combinar capa 1 y 2 (60% modelo, 40% histórico)
    const probBase = Utils.clamp(0.60 * probModel + 0.40 * probHistorical, 0.01, 0.99);

    // 4. Ajuste por noticias
    const newsAdjust = Utils.clamp(
      (newsPressure / 100) * newsMaxAdjust,
      -newsMaxAdjust,
      newsMaxAdjust
    );
    const probFinal = Utils.clamp(probBase + newsAdjust, 0.01, 0.99);

    // 5. Probabilidades direccionales ASIMÉTRICAS (alcista vs bajista)
    // Usar el mismo algoritmo frequency-based que en heuristicProbability
    const streakU  = currentFeatures[4] * 5;  // días sobre techo
    const streakL  = currentFeatures[5] * 5;  // días bajo piso
    const freqAboveU = currentFeatures[20] || 0;  // frecuencia de días SOBRE TECHO
    const freqBelowL = currentFeatures[21] || 0;  // frecuencia de días BAJO PISO

    // PROBABILIDAD ALCISTA: basada en frecuencia de días SOBRE TECHO
    let probAlcista = 0.01;  // Mínimo base
    if (freqAboveU >= 0.80) probAlcista = 0.70;      // 4/5 o más días sobre techo = muy probable
    else if (freqAboveU >= 0.60) probAlcista = 0.50;  // 3/5 días sobre techo = probable
    else if (freqAboveU >= 0.40) probAlcista = 0.30;  // 2/5 días sobre techo = posible
    else if (freqAboveU >= 0.20) probAlcista = 0.15;  // 1/5 días sobre techo = débil
    else if (streakU >= 4) probAlcista = 0.40;        // Racha de 4+ días sobre techo = riesgo significativo
    else if (streakU >= 3) probAlcista = 0.25;        // Racha de 3 días = riesgo moderado
    else if (streakU >= 2) probAlcista = 0.12;        // Racha de 2 días = riesgo bajo
    else probAlcista = 0.01;                           // Sin señal alcista = casi imposible

    // PROBABILIDAD BAJISTA: basada en frecuencia de días BAJO PISO
    let probBajista = 0.01;  // Mínimo base
    if (freqBelowL >= 0.80) probBajista = 0.75;      // 4/5 o más días bajo piso = muy probable
    else if (freqBelowL >= 0.60) probBajista = 0.55;  // 3/5 días bajo piso = probable
    else if (freqBelowL >= 0.40) probBajista = 0.35;  // 2/5 días bajo piso = posible
    else if (freqBelowL >= 0.20) probBajista = 0.20;  // 1/5 días bajo piso = débil
    else if (streakL >= 4) probBajista = 0.65;        // Racha de 4+ días bajo piso = alto riesgo
    else if (streakL >= 3) probBajista = 0.45;        // Racha de 3 días = riesgo moderado
    else if (streakL >= 2) probBajista = 0.25;        // Racha de 2 días = riesgo bajo
    else probBajista = 0.02;                           // Sin señal bajista = muy débil

    // Normalizar para que la suma de probabilidades sea razonable
    const totalProb = probAlcista + probBajista;
    if (totalProb > 1.0) {
      const factor = 0.99 / totalProb;
      probAlcista *= factor;
      probBajista *= factor;
    }

    probAlcista = Utils.clamp(probAlcista, 0.01, 0.99);
    probBajista = Utils.clamp(probBajista, 0.01, 0.99);

    return {
      probModel:      Utils.roundTo(probModel, 4),
      probHistorical: Utils.roundTo(probHistorical, 4),
      probBase:       Utils.roundTo(probBase, 4),
      newsAdjust:     Utils.roundTo(newsAdjust, 4),
      probFinal:      Utils.roundTo(probFinal, 4),
      probAlcista:    Utils.roundTo(probAlcista, 4),
      probBajista:    Utils.roundTo(probBajista, 4)
    };
  }

  /**
   * Probabilidad heurística cuando no hay modelo entrenado.
   * Basada en reglas explícitas de distancia y rachas.
   */
  function heuristicProbability(features, newsPressure, config) {
    const { newsMaxAdjust = 0.10 } = config;
    // features[4] = streakAboveUpper/5, features[5] = streakBelowLower/5
    // features[0] = gapToUpper, features[1] = gapToLower
    // features[17] = aboveUpper binary, features[18] = belowLower binary
    // features[19] = freqOutOfBand(5d), features[20] = freqAboveUpper(5d), features[21] = freqBelowLower(5d)
    // features[22] = proximityScore, features[23] = gapVolatility, features[24] = daysSinceOutOfBand

    const streakU  = features[4] * 5;  // días sobre techo
    const streakL  = features[5] * 5;  // días bajo piso
    const gapU     = features[0];      // gap al techo en fracción
    const gapL     = features[1];      // gap al piso en fracción
    const posInBand = features[3];     // 0=piso, 1=techo
    const freqOut  = features[19] || 0; // frecuencia días fuera de banda
    const freqAboveU = features[20] || 0;
    const freqBelowL = features[21] || 0;
    const proximityScore = features[22] || 0;
    const gapVolatility = features[23] || 0;
    const daysSinceEvent = features[24] || 0; // normalizado 0-1

    let baseScore = 0;

    // Frecuencia de días fuera de banda (nuevo: MAYOR SENSIBILIDAD)
    // 40% de días fuera = 0.40 → ahora suma 0.30 a la probabilidad
    if (freqOut >= 0.40) baseScore += 0.35;
    else if (freqOut >= 0.30) baseScore += 0.25;
    else if (freqOut >= 0.20) baseScore += 0.15;

    // Racha sobre techo (con sensibilidad mejorada)
    if (streakU >= 4)      baseScore += 0.70;
    else if (streakU >= 3) baseScore += 0.50;
    else if (streakU >= 2) baseScore += 0.30;
    else if (streakU >= 1) baseScore += 0.15;

    // Racha bajo piso (con sensibilidad mejorada)
    if (streakL >= 4)      baseScore += 0.70;
    else if (streakL >= 3) baseScore += 0.50;
    else if (streakL >= 2) baseScore += 0.30;
    else if (streakL >= 1) baseScore += 0.15;

    // Proximidad con decaimiento exponencial (nuevo: directamente usa score calculado)
    // proximityScore mide qué tan cercanos están los eventos recientes a los límites
    baseScore += proximityScore * 0.25;

    // Volatilidad de brechas: cambios agresivos en distancia a límites (nuevo)
    if (gapVolatility > 0.5) baseScore += 0.15;
    else if (gapVolatility > 0.3) baseScore += 0.08;

    // Recencia: eventos recientes son más predictivos (nuevo)
    // daysSinceEvent: 0 = hoy, 1 = ayer, normalizado a 0-1 en 5d window
    const recencyBonus = (1 - daysSinceEvent * 0.2) * freqOut * 0.15; // Máx +0.15 si evento hoy
    baseScore += recencyBonus;

    // Proximidad al techo (original)
    if (gapU < 0)         baseScore += 0.20;   // ya superó el techo
    else if (gapU < 0.01) baseScore += 0.15;   // a <1%
    else if (gapU < 0.02) baseScore += 0.08;

    // Proximidad al piso (original, ahora también mejorado)
    if (gapL < 0)         baseScore += 0.20;   // ya superó el piso
    else if (gapL < 0.01) baseScore += 0.15;   // a <1%
    else if (gapL < 0.02) baseScore += 0.08;

    // Posición en banda
    if (posInBand > 0.85) baseScore += 0.10;
    if (posInBand < 0.15) baseScore += 0.10;

    const probBase  = Utils.clamp(baseScore, 0.02, 0.95);
    const newsAdjust = Utils.clamp(
      (newsPressure / 100) * newsMaxAdjust,
      -newsMaxAdjust, newsMaxAdjust
    );
    const probFinal = Utils.clamp(probBase + newsAdjust, 0.01, 0.99);

    // Probabilidades direccionales (alcista vs bajista)
    const probAlcista = Utils.clamp(probFinal * (streakU / (streakU + streakL + 0.1)), 0.01, 0.99);
    const probBajista = Utils.clamp(probFinal * (streakL / (streakU + streakL + 0.1)), 0.01, 0.99);

    return {
      probModel:       null,
      probHistorical:  null,
      probBase:        Utils.roundTo(probBase, 4),
      newsAdjust:      Utils.roundTo(newsAdjust, 4),
      probFinal:       Utils.roundTo(probFinal, 4),
      probAlcista:     Utils.roundTo(probAlcista, 4),
      probBajista:     Utils.roundTo(probBajista, 4),
      isHeuristic:     true
    };
  }

  // ── Entrenamiento y backtesting ───────────────────────────────────────────

  /**
   * Entrena el modelo sobre los dailyStates históricos.
   * Modifica el estado interno (_model, _trainData, _scaleParams).
   */
  function train(dailyStates, minDays = 5) {
    const { X, y } = buildTrainingData(dailyStates, minDays);
    if (X.length < 50) {
      console.warn('[ProbabilityEngine] Pocos datos de entrenamiento:', X.length);
      return null;
    }

    _scaleParams = computeScaleParams(X);
    const Xscaled = X.map(row => scaleFeatures(row, _scaleParams));
    _model = trainLogisticRegression(Xscaled, y);
    _trainData = { X, y, featureNames: FEATURE_NAMES };

    console.log('[ProbabilityEngine] Modelo entrenado:', _model.trainMetrics);
    return _model.trainMetrics;
  }

  /**
   * Backtest completo: para cada día calcula probabilidad sin look-ahead.
   * Retorna array de { date, prob, actual, state }.
   */
  function backtest(dailyStates, minDays = 5, windowFilter = null) {
    const N       = dailyStates.length;
    const results = [];

    // Determinar rango
    let states = dailyStates;
    if (windowFilter) {
      const cutoff = Utils.formatDate(Utils.monthsAgo(new Date(), windowFilter));
      states = dailyStates.filter(s => s.date >= cutoff);
    }

    const offset = dailyStates.length - states.length;

    for (let i = 20; i < states.length - minDays; i++) {
      const globalI = i + offset;
      const features = extractFeatures(dailyStates, globalI);
      if (!features) continue;

      // Entrenar con datos hasta i (sin look-ahead)
      const partialStates = dailyStates.slice(0, globalI + 1);
      let prob = 0.1;

      // Para eficiencia, usar heurística rápida en lugar de re-entrenar cada día
      const newsScore = 0; // Sin noticias en backtest
      const result = heuristicProbability(features, newsScore, {});
      prob = result.probFinal;

      // Target real
      let actual = 0;
      for (let j = globalI + 1; j <= Math.min(globalI + minDays, N - 1); j++) {
        if (dailyStates[j].bandJustChanged) { actual = 1; break; }
      }

      results.push({
        date:  states[i].date,
        prob,
        actual,
        state: states[i]
      });
    }

    // Métricas de backtest
    const metrics = computeBacktestMetrics(results);
    return { results, metrics };
  }

  function computeBacktestMetrics(results, threshold = 0.5) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    let brierSum = 0;
    const totalChanges = results.filter(r => r.actual === 1).length;

    for (const r of results) {
      const pred = r.prob >= threshold ? 1 : 0;
      brierSum += (r.prob - r.actual) ** 2;
      if (pred === 1 && r.actual === 1) tp++;
      else if (pred === 1 && r.actual === 0) fp++;
      else if (pred === 0 && r.actual === 0) tn++;
      else fn++;
    }

    const n          = results.length;
    const accuracy   = n > 0 ? (tp + tn) / n : 0;
    const precision  = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall     = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1         = precision + recall > 0 ?
                       2 * precision * recall / (precision + recall) : 0;
    const brierScore = n > 0 ? brierSum / n : 0;

    // Calibration buckets
    const buckets = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const calibration = [];
    for (let b = 0; b < buckets.length - 1; b++) {
      const inBucket = results.filter(r => r.prob >= buckets[b] && r.prob < buckets[b+1]);
      if (inBucket.length > 0) {
        const actualRate = inBucket.filter(r => r.actual === 1).length / inBucket.length;
        calibration.push({
          bucket:     `${Math.round(buckets[b]*100)}-${Math.round(buckets[b+1]*100)}%`,
          predicted:  (buckets[b] + buckets[b+1]) / 2,
          actual:     actualRate,
          count:      inBucket.length
        });
      }
    }

    return {
      tp, fp, tn, fn, totalChanges,
      accuracy:   Utils.roundTo(accuracy, 4),
      precision:  Utils.roundTo(precision, 4),
      recall:     Utils.roundTo(recall, 4),
      f1:         Utils.roundTo(f1, 4),
      brierScore: Utils.roundTo(brierScore, 4),
      calibration
    };
  }

  // ── Accesores ─────────────────────────────────────────────────────────────

  function getModel()       { return _model; }
  function getTrainData()   { return _trainData; }
  function isModelTrained() { return _model !== null; }

  /**
   * Texto explicativo de la probabilidad.
   */
  function explainProbability(probResult, state, minDays) {
    if (!state || !probResult) return 'Sin datos suficientes.';
    const { probBase, newsAdjust, probFinal, isHeuristic } = probResult;
    const pct      = Math.round(probFinal * 100);
    const streak   = Math.max(state.streakAboveUpper, state.streakBelowLower);
    const dir      = state.streakAboveUpper > state.streakBelowLower ? 'alcista' : 'bajista';
    const distTech = state.isAboveUpper
      ? `${Utils.formatNumber(Math.abs(state.gapToUpper))}% sobre el techo`
      : `${Utils.formatNumber(state.gapToUpper)}% del techo`;
    const news = newsAdjust > 0.005  ? 'alcista'
               : newsAdjust < -0.005 ? 'bajista' : 'neutral';
    const adj  = Math.round(Math.abs(newsAdjust) * 100);

    let text = `Con el dólar mayorista actualmente en <b>${Utils.formatNumber(state.value)}</b>, `;
    text += `ubicado a <b>${distTech}</b> de la banda interna, `;
    text += `una racha de <b>${streak} día${streak !== 1 ? 's' : ''}</b> en dirección ${dir} `;
    text += `y un contexto noticioso <b>${news}</b>, `;
    text += `la probabilidad estimada de cambio de banda para la próxima semana es de <b>${pct}%</b>. `;
    if (isHeuristic) {
      text += `<em>(Modelo heurístico — pocos datos históricos disponibles para entrenamiento completo.)</em>`;
    } else {
      text += `Probabilidad base: ${Math.round(probBase * 100)}%. `;
      text += `Ajuste por noticias: ${adj > 0 ? (newsAdjust > 0 ? '+' : '-') + adj + 'pp' : 'ninguno'}.`;
    }
    return text;
  }

  // ── Exportación ───────────────────────────────────────────────────────────

  return {
    extractFeatures,
    buildTrainingData,
    train,
    computeProbability,
    heuristicProbability,
    backtest,
    computeBacktestMetrics,
    getModel,
    isModelTrained,
    explainProbability,
    FEATURE_NAMES
  };

})();

window.ProbabilityEngine = ProbabilityEngine;
