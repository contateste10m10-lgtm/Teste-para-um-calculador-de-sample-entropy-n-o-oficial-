'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('page loads scientific core before application code', () => {
  const core = html.indexOf('src="analysis-core.js"');
  const app = html.indexOf('src="app.js"');
  assert.ok(core >= 0 && app > core);
});

test('results UI includes both measurements and export actions', () => {
  for (const id of ['entropyChart','modulationChart','metricModMean','resultsTable','downloadCsvBtn','downloadPngBtn','downloadModulationPngBtn']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  }
  assert.match(html, /m intrínseco \(%\)/i);
  assert.match(html, /SampEn/);
  assert.match(js, /intrinsicModulation/);
  assert.match(js, /N_excluded_missing_invalid_error/);
});

test('HTML and application references use the expected chart and table field IDs', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const refs = new Set([...js.matchAll(/el\('([A-Za-z][A-Za-z0-9_-]*)'\)/g)].map(match => match[1]));
  const missing = [...refs].filter(id => !ids.has(id) && id !== 'timeColumn'); // timeColumn is built after file mapping.
  assert.deepEqual(missing, []);
});
