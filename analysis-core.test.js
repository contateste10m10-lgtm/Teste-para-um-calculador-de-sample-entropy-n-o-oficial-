'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../analysis-core.js');

function countDimension(series, dimension, r) {
  const templates = series.length - dimension + 1;
  let count = 0;
  for (let i = 0; i < templates; i++) {
    for (let j = i + 1; j < templates; j++) {
      let match = true;
      for (let k = 0; k < dimension; k++) {
        if (Math.abs(series[i+k] - series[j+k]) > r) { match = false; break; }
      }
      if (match) count++;
    }
  }
  return count;
}
function bruteReference(series, m, tolMult) {
  const x = series.filter(Number.isFinite);
  const mu = x.reduce((s, v) => s + v, 0) / x.length;
  const sigma = Math.sqrt(x.reduce((s, v) => s + (v - mu) ** 2, 0) / x.length);
  if (!sigma) return { A: 0, B: 0, value: null };
  const z = x.map(value => (value - mu) / sigma);
  const B = countDimension(z, m, tolMult);
  const A = countDimension(z, m + 1, tolMult);
  return { A, B, value: A > 0 && B > 0 ? -Math.log(A/B) : null };
}

test('SampEn follows -ln(A/B) and counts only non-self pairs', () => {
  const result = Core.sampleEntropy([0, 1, 0, 1], 1, 1.4);
  assert.equal(result.A, 1);
  assert.equal(result.B, 2);
  assert.ok(Math.abs(result.value - Math.log(2)) < 1e-12);
});

test('SampEn flags constant and undersampled series, rather than returning zero', () => {
  assert.equal(Core.sampleEntropy([4, 4, 4, 4], 2, 0.2).value, null);
  assert.equal(Core.sampleEntropy([1, 2, 3], 2, 0.2).value, null);
});

test('SampEn reports no matches in B or no extensions in A', () => {
  const noMatches = Core.sampleEntropy([0, 1, 3, 9, 2, 4], 2, 0.01);
  assert.equal(noMatches.value, null);
  assert.ok(noMatches.reason.startsWith('B = 0') || noMatches.reason.startsWith('A = 0'));
  const noExtension = Core.sampleEntropy([0, 0, 1, 1], 1, 0.2);
  assert.equal(noExtension.B, 2);
  assert.equal(noExtension.A, 0);
  assert.equal(noExtension.value, null);
});

test('SampEn fast pair counts agree with independent brute-force counts on seeded series', () => {
  let seed = 20261011;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
  for (let trial = 0; trial < 24; trial++) {
    const n = 760 + trial * 3;
    const series = Array.from({length:n}, (_, i) => Math.sin(i * (0.03 + trial * 0.001)) + (random() - 0.5) * 0.8);
    const m = 1 + (trial % 4);
    const tolerance = 0.12 + (trial % 5) * 0.05;
    const expected = bruteReference(series, m, tolerance);
    const actual = Core.sampleEntropy(series, m, tolerance);
    assert.equal(actual.A, expected.A, `A mismatch at trial ${trial}`);
    assert.equal(actual.B, expected.B, `B mismatch at trial ${trial}`);
    if (expected.value == null) assert.equal(actual.value, null);
    else assert.ok(Math.abs(actual.value - expected.value) < 1e-12);
  }
});

test('intrinsic modulation follows noise-corrected formula and returns percent', () => {
  const result = Core.intrinsicModulation([
    {y:8,error:1},{y:10,error:1},{y:12,error:1}
  ]);
  assert.equal(result.status, 'OK');
  assert.equal(result.nUsed, 3);
  assert.equal(result.observedVariance, 4);
  assert.equal(result.noiseVariance, 1);
  assert.equal(result.intrinsicVariance, 3);
  assert.ok(Math.abs(result.value - 100 * Math.sqrt(3) / 10) < 1e-12);
});

test('modulation distinguishes zero intrinsic variance from negative variance', () => {
  const zero = Core.intrinsicModulation([{y:9,error:1},{y:10,error:1},{y:11,error:1}]);
  assert.equal(zero.status, 'zero_intrinsic_variance');
  assert.equal(zero.value, 0);
  const negative = Core.intrinsicModulation([{y:9,error:2},{y:10,error:2},{y:11,error:2}]);
  assert.equal(negative.status, 'negative_intrinsic_variance');
  assert.equal(negative.value, null);
});

test('modulation does not use absolute mean and reports missing uncertainty columns', () => {
  const nonpositive = Core.intrinsicModulation([{y:-2,error:0.1},{y:-1,error:0.1}]);
  assert.equal(nonpositive.status, 'nonpositive_mean');
  const noColumn = Core.intrinsicModulation([{y:1,error:null},{y:2,error:null}], false);
  assert.equal(noColumn.status, 'missing_error_column');
});

test('modulation reports how many rate samples were excluded for missing or invalid errors', () => {
  const result = Core.intrinsicModulation([
    {y:8,error:1},{y:10,error:null},{y:12,error:-1},{y:14,error:1}
  ]);
  assert.equal(result.nRate, 4);
  assert.equal(result.nUsed, 2);
  assert.equal(result.nErrorExcluded, 2);
  assert.equal(result.status, 'partial_uncertainties');
});


test('SampEn optimized search handles a larger series', () => {
  let seed = 314159;
  const random = () => { seed = (1103515245 * seed + 12345) >>> 0; return seed / 4294967296; };
  const series = Array.from({length:10000}, () => random() - 0.5);
  const result = Core.sampleEntropy(series, 2, 0.2);
  assert.ok(Number.isFinite(result.value));
  assert.ok(result.A > 0 && result.B >= result.A);
});


test('negative intrinsic variance is not rounded to zero for very small flux scales', () => {
  const result = Core.intrinsicModulation([
    {y:0.9e-8,error:2e-9},{y:1e-8,error:2e-9},{y:1.1e-8,error:2e-9}
  ]);
  assert.equal(result.status, 'negative_intrinsic_variance');
  assert.equal(result.value, null);
  assert.ok(result.intrinsicVariance < 0);
});
