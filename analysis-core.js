/*
 * Multiband Entropy Lab — núcleo científico testável.
 * SampEn segue H_SE = -ln(A/B), distância de Chebyshev e exclusão de auto-pares.
 * O índice de modulação usa a definição intrínseca do artigo de referência.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.EntropyCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '0.5.0';

  function finiteSeries(values) {
    return Array.from(values ?? []).filter(Number.isFinite).map(Number);
  }

  function mean(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function populationStd(values) {
    if (!values.length) return null;
    const center = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
  }

  function getNeighborOffsets(dimensions) {
    const offsets = [];
    const current = Array(dimensions).fill(0);
    function build(depth) {
      if (depth === dimensions) {
        offsets.push(current.slice());
        return;
      }
      for (let step = -1; step <= 1; step++) {
        current[depth] = step;
        build(depth + 1);
      }
    }
    build(0);
    return offsets;
  }

  function bruteForceMatches(z, dimension, radius) {
    const nTemplates = z.length - dimension + 1;
    let matches = 0;
    for (let i = 0; i < nTemplates; i++) {
      for (let j = i + 1; j < nTemplates; j++) {
        let match = true;
        for (let k = 0; k < dimension; k++) {
          if (Math.abs(z[i + k] - z[j + k]) > radius) {
            match = false;
            break;
          }
        }
        if (match) matches++;
      }
    }
    return matches;
  }

  // Uniform-grid search counts all pairs for a fixed embedding dimension. B
  // and A are counted separately for dimensions m and m+1, matching the
  // project's reference Python/cKDTree routine. Equivalence to EntropyHub v2.0
  // still requires a direct numerical comparison on identical series.
  function gridMatches(z, dimension, radius) {
    const nTemplates = z.length - dimension + 1;
    const offsets = getNeighborOffsets(dimension);
    const buckets = new Map();
    let matches = 0;

    for (let i = 0; i < nTemplates; i++) {
      const cell = Array.from({ length: dimension }, (_, k) => Math.floor(z[i + k] / radius));
      for (const offset of offsets) {
        const neighborKey = cell.map((value, k) => value + offset[k]).join(',');
        const candidates = buckets.get(neighborKey);
        if (!candidates) continue;
        for (const j of candidates) {
          let match = true;
          for (let k = 0; k < dimension; k++) {
            if (Math.abs(z[i + k] - z[j + k]) > radius) {
              match = false;
              break;
            }
          }
          if (match) matches++;
        }
      }
      const key = cell.join(',');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    }
    return matches;
  }

  function countMatches(z, dimension, radius) {
    const nTemplates = z.length - dimension + 1;
    if (nTemplates < 2) return 0;
    return nTemplates < 700
      ? bruteForceMatches(z, dimension, radius)
      : gridMatches(z, dimension, radius);
  }

  /**
   * Sample Entropy H_SE = -ln(A/B), with independent pair counts at
   * embedding dimensions m (B) and m+1 (A), as defined in the paper.
   * r = toleranceMultiplier * population SD(series), following NumPy's default
   * convention used by the documented EntropyHub API. Auto-pairs are excluded;
   * each unordered pair is counted once, and equality at r is included.
   */
  function sampleEntropy(series, m = 2, toleranceMultiplier = 0.2) {
    const x = finiteSeries(series);
    if (!Number.isInteger(m) || m < 1) throw new RangeError('A dimensão m deve ser um inteiro positivo.');
    if (!Number.isFinite(toleranceMultiplier) || toleranceMultiplier <= 0) throw new RangeError('A tolerância deve ser maior que zero.');

    const n = x.length;
    if (n < m + 2) {
      return { value: null, reason: 'Poucos pontos para formar pares', sigma: null, r: null, A: 0, B: 0, n };
    }
    const center = mean(x);
    const sigma = populationStd(x);
    if (sigma === 0) {
      return { value: null, reason: 'Série constante (σ = 0)', sigma, r: 0, A: 0, B: 0, n };
    }
    if (!Number.isFinite(sigma) || !Number.isFinite(center)) {
      return { value: null, reason: 'Escala numérica não finita', sigma, r: null, A: 0, B: 0, n };
    }
    const r = toleranceMultiplier * sigma;
    const z = x.map(value => (value - center) / sigma);
    const radius = toleranceMultiplier;

    // B counts every pair of m-dimensional templates; A independently counts
    // every pair of (m+1)-dimensional templates. This avoids silently aligning
    // the template sets to different sample counts.
    const B = countMatches(z, m, radius);
    const A = countMatches(z, m + 1, radius);
    if (B === 0) return { value: null, reason: 'B = 0 (nenhum par semelhante)', sigma, r, A, B, n };
    if (A === 0) return { value: null, reason: 'A = 0 (nenhuma extensão semelhante)', sigma, r, A, B, n };
    const estimate = -Math.log(A / B);
    return { value: Object.is(estimate, -0) ? 0 : estimate, reason: 'OK', sigma, r, A, B, n };
  }

  /**
   * Intrinsic modulation index, in percent:
   * m = 100 * sqrt(S^2 - mean(error^2)) / mean(flux).
   * S^2 uses sample variance (N-1), matching the user's reference script;
   * the source article gives the formula but does not specify this divisor.
   * Only observations with finite flux and finite non-negative uncertainties
   * enter this estimate. Mean flux is not replaced by its absolute value.
   */
  function intrinsicModulation(points, hasErrorColumn = true) {
    const all = Array.from(points ?? []).filter(p => Number.isFinite(p?.y));
    if (!hasErrorColumn) {
      return {
        value: null, reason: 'Coluna de incerteza não selecionada', status: 'missing_error_column',
        nRate: all.length, nUsed: 0, nErrorExcluded: all.length, meanFlux: mean(all.map(p => p.y)),
        observedVariance: null, noiseVariance: null, intrinsicVariance: null, rmsIntrinsic: null
      };
    }
    const valid = all.filter(p => Number.isFinite(p?.error) && p.error >= 0);
    const nErrorExcluded = all.length - valid.length;
    const flux = valid.map(p => p.y);
    const errors = valid.map(p => p.error);
    const n = flux.length;
    const avg = mean(flux);
    const base = {
      value: null, reason: '', status: 'unavailable', nRate: all.length, nUsed: n,
      nErrorExcluded, meanFlux: avg, observedVariance: null, noiseVariance: null,
      intrinsicVariance: null, rmsIntrinsic: null
    };
    if (n < 2) {
      return { ...base, reason: 'Menos de 2 pontos com fluxo e incerteza válidos', status: 'insufficient_paired_data' };
    }
    const varianceObserved = flux.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (n - 1);
    const varianceNoise = mean(errors.map(error => error ** 2));
    let varianceIntrinsic = varianceObserved - varianceNoise;
    const varianceScale = Math.max(Number.MIN_VALUE, Math.abs(varianceObserved), Math.abs(varianceNoise));
    const numericalTolerance = 1e-12 * varianceScale;
    if (varianceIntrinsic < 0 && Math.abs(varianceIntrinsic) <= numericalTolerance) varianceIntrinsic = 0;
    const calculated = { ...base, observedVariance: varianceObserved, noiseVariance: varianceNoise, intrinsicVariance: varianceIntrinsic };

    if (!Number.isFinite(avg) || avg <= 0) {
      return { ...calculated, reason: 'Fluxo médio não positivo; a fórmula do artigo não define um índice percentual válido', status: 'nonpositive_mean' };
    }
    if (![varianceObserved, varianceNoise, varianceIntrinsic].every(Number.isFinite)) {
      return { ...calculated, reason: 'Variância observada/corrigida não finita', status: 'nonfinite_variance' };
    }
    if (varianceIntrinsic < 0) {
      return { ...calculated, reason: 'Variância corrigida pelo ruído negativa', status: 'negative_intrinsic_variance' };
    }
    const rmsIntrinsic = Math.sqrt(varianceIntrinsic);
    const value = 100 * rmsIntrinsic / avg;
    if (!Number.isFinite(value)) {
      return { ...calculated, rmsIntrinsic, reason: 'O índice percentual não é finito para esta média de fluxo', status: 'nonfinite_result' };
    }
    const partial = nErrorExcluded > 0;
    return {
      ...calculated, value, rmsIntrinsic,
      reason: partial ? 'Calculado com subconjunto: algumas incertezas faltam ou são inválidas' : (varianceIntrinsic === 0 ? 'Variância intrínseca estimada igual a zero' : 'OK'),
      status: partial ? 'partial_uncertainties' : (varianceIntrinsic === 0 ? 'zero_intrinsic_variance' : 'OK')
    };
  }

  return { VERSION, mean, populationStd, sampleEntropy, intrinsicModulation };
});
