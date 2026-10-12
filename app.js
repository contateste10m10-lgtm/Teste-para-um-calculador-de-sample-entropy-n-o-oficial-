'use strict';

const BAND_DEFS = [
  { key: 'b1', name: '14–20 keV', short: '14–20', color: '#8a8dff' },
  { key: 'b2', name: '20–24 keV', short: '20–24', color: '#5cdec2' },
  { key: 'b3', name: '24–35 keV', short: '24–35', color: '#ffbd78' },
  { key: 'b4', name: '35–50 keV', short: '35–50', color: '#f285a3' },
  { key: 'b5', name: '50–75 keV', short: '50–75', color: '#71b7ff' },
  { key: 'b6', name: '75–100 keV', short: '75–100', color: '#d0a1ff' },
  { key: 'b7', name: '100–150 keV', short: '100–150', color: '#b1d765' },
  { key: 'b8', name: '150–195 keV', short: '150–195', color: '#ff9e6d' }
];
const state = { table: null, source: '', instrument: '', charts: [], results: [], parsed: false, dataRows: [], header: [], delimiter: 'whitespace', fileName: '', timeIndex: 0, bandIndices: [], errorIndices: [], timeLabel: 'Tempo', columnNames: [], latestAnalysis: null, bandDefs: BAND_DEFS.map(b => ({...b})) };
const el = id => document.getElementById(id);

// Optional Chart.js zoom plugin. Toolbar-based zoom remains available as a fallback.
try {
  if (window.Chart && window.ChartZoom) {
    const zoomPlugin = window.ChartZoom.default || window.ChartZoom;
    if (!Chart.registry?.plugins?.get?.('zoom')) Chart.register(zoomPlugin);
  }
} catch (err) { console.warn('Plugin de zoom indisponível; controles manuais continuam ativos.', err); }

function message(text, type = '') { const n = el('analysisMessage'); n.textContent = text; n.className = `analysis-message ${type}`.trim(); }
function fileStatus(text, type = '') { const n = el('fileStatus'); n.textContent = text; n.className = `file-status ${type}`.trim(); }
function normName(s) { return String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function numericToken(s) { if (s == null) return null; const t = String(s).trim().replace(/,/g, '.'); if (!t || /^(-|--|nan|nan\(|null|none|indef|inf|\*+)$/i.test(t)) return null; const v = Number(t); return Number.isFinite(v) ? v : null; }
function splitLine(line, delimiter) { if (delimiter === 'comma') return line.split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')); if (delimiter === 'semicolon') return line.split(';').map(x => x.trim().replace(/^['"]|['"]$/g, '')); if (delimiter === 'tab') return line.split(/\t+/).map(x => x.trim()); return line.trim().split(/\s+/); }

function detectDelimiter(lines) {
  const sample = lines.filter(x => x.trim() && !x.trim().startsWith('#')).slice(0, 8).join('\n');
  const counts = { comma: (sample.match(/,/g) || []).length, semicolon: (sample.match(/;/g) || []).length, tab: (sample.match(/\t/g) || []).length };
  if (counts.comma > 0 && counts.comma >= counts.semicolon && counts.comma >= counts.tab) return 'comma';
  if (counts.semicolon > 0 && counts.semicolon > counts.comma && counts.semicolon >= counts.tab) return 'semicolon';
  if (counts.tab > 0) return 'tab';
  return 'whitespace';
}
function looksLikeHeader(tokens) { return tokens.some(t => /time|mjd|date|rate|count|error|err|band|energy|flux|exposure|cent_rate|bkg_var/i.test(t)) && tokens.some(t => /time|mjd|date|rate|count|error|err|band|energy|flux/i.test(t)); }
function findTimeColumn(header) { const rx = [/^mjd$/, /time/, /date/, /day/]; for (const pat of rx) { const i = header.findIndex(h => pat.test(normName(h))); if (i >= 0) return i; } return 0; }
function explicitBandScore(name, bandNum, aliases) { const n = normName(name); let score = 0; if (new RegExp(`\\b(?:band|b) ?0?${bandNum}\\b`).test(n)) score += 5; if (n.includes(aliases[0]) || n.includes(aliases[1])) score += 5; if (/rate|count|flux|cent/.test(n)) score += 1; if (/err|error|sigma|uncert|bkg var/.test(n)) score -= 4; return score; }
function guessColumnMap(header, nCols) {
  const time = findTimeColumn(header);
  const rates = [], errors = [];
  const aliases = [['14 20','14 20'], ['20 24','20 24'], ['24 35','24 35'], ['35 50','35 50'], ['50 75','50 75'], ['75 100','75 100'], ['100 150','100 150'], ['150 195','150 195']];
  const unused = new Set(Array.from({ length:nCols }, (_,i)=>i).filter(i=>i!==time));
  for (let b = 0; b < 8; b++) {
    const scores = [...unused].map(i => ({i, score: explicitBandScore(header[i] || '', b+1, aliases[b])})).sort((a,c)=>c.score-a.score);
    const candidate = scores[0] && scores[0].score >= 5 ? scores[0].i : null;
    if (candidate != null) { rates[b] = candidate; unused.delete(candidate); } else rates[b] = null;
  }
  // Swift-BAT snapshot tables commonly store a time column, nine rates (8 bands + total), then nine errors.
  // When headers are not informative, offer a conservative default and expose every selector for correction.
  if (rates.filter(x=>x != null).length < 8) {
    const possible = Array.from({length:nCols},(_,i)=>i).filter(i=>i!==time);
    let defaultRates;
    if (nCols >= 19) defaultRates = possible.slice(0,8); // time + 8 band-rate columns; total-rate may follow
    else if (nCols >= 9) defaultRates = possible.slice(0,8);
    else defaultRates = possible.slice(0, Math.min(8, possible.length));
    for (let b=0;b<8;b++) if (rates[b] == null) rates[b] = defaultRates[b] ?? null;
  }
  // Error columns are only selected when column names make them explicit or the table resembles rate+error groups.
  for (let b=0;b<8;b++) {
    const rn = normName(header[rates[b]] || '');
    const energyAlias = aliases[b][0];
    const e = header.findIndex((h,i)=>i!==rates[b] && (/error|err|sigma|bkg var|uncert/.test(normName(h))) && (normName(h).includes(energyAlias) || new RegExp(`(?:band|b) ?0?${b+1}\\b`).test(normName(h))));
    errors[b] = e >= 0 ? e : null;
    if (errors[b] == null && /^(?:rate|cent rate) ?\d*$/.test(rn) && nCols >= 18) {
      const likely = rates[b] + 9; if (likely < nCols && likely !== time) errors[b] = likely;
    }
  }
  return {time, rates, errors};
}

function parseTextTable(text, filename = 'dados') {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (text.includes('\u0000')) throw new Error('O arquivo parece ser binário (por exemplo, FITS). Esta primeira versão aceita arquivos de texto ASCII como .lc, .txt, .csv ou .tsv.');
  const delimiter = detectDelimiter(lines);
  let header = null, headerLine = -1;
  const body = [];
  for (let i=0; i<lines.length; i++) {
    const raw=lines[i].trim(); if (!raw) continue;
    const cleaned = raw.replace(/^#+\s?/, '');
    const tokens = splitLine(cleaned, delimiter);
    const numericCount = tokens.filter(t => numericToken(t) !== null).length;
    if (header === null && looksLikeHeader(tokens) && numericCount < tokens.length * 0.65) { header = tokens; headerLine = i; continue; }
    if (raw.startsWith('#')) continue;
    if (numericCount >= Math.min(2, tokens.length)) body.push({line:i+1, tokens});
  }
  if (!body.length) throw new Error('Não encontrei linhas numéricas no arquivo. Verifique se o arquivo foi descompactado corretamente e está em formato ASCII.');
  const nCols = Math.max(...body.map(r=>r.tokens.length));
  if (nCols < 2) throw new Error('A tabela precisa ter uma coluna de tempo e ao menos uma coluna de medidas.');
  // Align labels to numeric row width; if there is no recognizable header, build editable generic labels.
  if (!header || header.length !== nCols || !looksLikeHeader(header)) header = Array.from({length:nCols},(_,i)=>`Coluna ${i+1}`);
  else if (header.length < nCols) header = [...header, ...Array.from({length:nCols-header.length},(_,i)=>`Coluna ${header.length+i+1}`)];
  const rows = body.map(r => Array.from({length:nCols},(_,i)=>numericToken(r.tokens[i])));
  const map = guessColumnMap(header,nCols);
  return {filename, header, rows, delimiter, ...map, rawLines: lines.length, headerLine};
}

async function readFileBuffer(file) {
  let buffer = await file.arrayBuffer();
  const u8 = new Uint8Array(buffer);
  const isGzip = (file.name.toLowerCase().endsWith('.gz') || (u8[0]===0x1f && u8[1]===0x8b));
  if (isGzip) {
    let decompressed=false;
    if (typeof DecompressionStream !== 'undefined') {
      try { const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')); buffer = await new Response(stream).arrayBuffer(); decompressed=true; } catch (_) {}
    }
    if(!decompressed && window.pako && typeof window.pako.ungzip==='function') {
      try { buffer=window.pako.ungzip(new Uint8Array(buffer)).buffer; decompressed=true; } catch (_) {}
    }
    if(!decompressed) throw new Error('Não consegui descompactar este .gz. Confira se o download terminou. Se o arquivo termina em .lc, o site também verifica a assinatura gzip interna; tente baixar novamente do catálogo Swift-BAT.');
  }
  return buffer;
}

function fitsCardValue(card) {
  let raw = card.slice(10).trim();
  if (!raw) return '';
  let inQuote = false, out = '';
  for (let i=0;i<raw.length;i++) {
    const c=raw[i];
    if (c==="'") { if (inQuote && raw[i+1]==="'") { out += "''"; i++; continue; } inQuote=!inQuote; out+=c; continue; }
    if (c==='/' && !inQuote) break;
    out+=c;
  }
  out=out.trim();
  if (out.startsWith("'")) return out.slice(1,out.lastIndexOf("'")).replace(/''/g,"'").trim();
  if (out==='T') return true; if (out==='F') return false;
  const n=Number(out); return out!=='' && Number.isFinite(n) ? n : out;
}
function readFitsHeader(bytes, start) {
  const decoder=new TextDecoder('ascii'); const header={}; let pos=start, ended=false, cards=0;
  while(pos+80<=bytes.length && !ended) {
    const card=decoder.decode(bytes.subarray(pos,pos+80)); pos+=80; cards++;
    const key=card.slice(0,8).trim();
    if(key==='END'){ended=true;break;}
    if(key && card[8]==='=') header[key]=fitsCardValue(card);
  }
  if(!ended) throw new Error('Cabeçalho FITS inválido ou incompleto.');
  const headerBytes=Math.ceil((cards*80)/2880)*2880;
  return {header, dataStart:start+headerBytes};
}
function fitsFormat(form) {
  const raw=String(form||'').trim().toUpperCase();
  const variable=raw.match(/^(\d*)([PQ])([LXBIJKAEDCM])(?:\((\d+)\))?$/);
  if(variable){
    const repeat=Number(variable[1]||1),code=variable[2],elementCode=variable[3];
    return {repeat,code,width:repeat*(code==='P'?8:16),elementCode,maxElements:variable[4]?Number(variable[4]):null,variable:true};
  }
  const m=raw.match(/^(\d*)([A-Z])(?:\((\d+)\))?/);
  if(!m) throw new Error(`Formato de coluna FITS não reconhecido: ${form}`);
  const repeat=Number(m[1]||1), code=m[2];
  const sizeMap={L:1,A:1,B:1,I:2,J:4,K:8,E:4,D:8,C:8,M:16,X:0};
  if(!(code in sizeMap)) throw new Error(`Tipo FITS não suportado: ${code}`);
  const width=code==='X'?Math.ceil(repeat/8):repeat*sizeMap[code];
  return {repeat,code,width,variable:false};
}
function fitsReadScalar(view, offset, code) {
  switch(code){case 'L': return String.fromCharCode(view.getUint8(offset))==='T'?1:0;case 'B': return view.getUint8(offset);case 'I': return view.getInt16(offset,false);case 'J': return view.getInt32(offset,false);case 'K': return Number(view.getBigInt64(offset,false));case 'E': return view.getFloat32(offset,false);case 'D': return view.getFloat64(offset,false);case 'C': return view.getFloat32(offset,false);case 'M': return view.getFloat64(offset,false);default:return null;}
}
function parseFitsBuffer(buffer, filename) {
  const bytes=new Uint8Array(buffer); const decoder=new TextDecoder('ascii');
  if(decoder.decode(bytes.subarray(0,8)).trim()!=='SIMPLE') throw new Error('O arquivo não parece ser um FITS válido.');
  let offset=0, chosen=null, hduCount=0;
  while(offset+2880<=bytes.length && hduCount<30) {
    const {header,dataStart}=readFitsHeader(bytes,offset); hduCount++;
    const xtension=String(header.XTENSION||'').trim().toUpperCase();
    const naxis=Number(header.NAXIS||0), bitpix=Math.abs(Number(header.BITPIX||8));
    let rawDataSize=0;
    if(naxis>0){let dims=1;for(let n=1;n<=naxis;n++)dims*=Number(header[`NAXIS${n}`]||0);rawDataSize=(bitpix/8)*dims+Number(header.PCOUNT||0);if(Number(header.GCOUNT||1)>1)rawDataSize*=Number(header.GCOUNT||1);}
    if(xtension.includes('BINTABLE')) {
      const nRows=Number(header.NAXIS2||0), rowWidth=Number(header.NAXIS1||0), nFields=Number(header.TFIELDS||0), cols=[];let cursor=0;
      for(let c=1;c<=nFields;c++){
        const name=String(header[`TTYPE${c}`]||`COL${c}`).trim();const format=fitsFormat(header[`TFORM${c}`]);
        cols.push({name,format,offset:cursor,unit:header[`TUNIT${c}`]||''});cursor+=format.width;
      }
      if(nRows>0 && rowWidth>0 && dataStart+rowWidth*nRows<=bytes.length) {
        const hasTime=cols.some(c=>/time|mjd|date/i.test(c.name));
        const hasRate=cols.some(c=>/(rate|flux|count|cent)/i.test(c.name) && !/(err|error|sigma)/i.test(c.name) && (c.format.repeat>=8 || (c.format.variable && /[PQ]/.test(c.format.code))));
        if(hasTime && hasRate){chosen={header,cols,nRows,rowWidth,dataStart};break;}
      }
    }
    const padded=Math.ceil(rawDataSize/2880)*2880;offset=dataStart+padded;
  }
  if(!chosen) throw new Error('O FITS foi reconhecido, mas não encontrei uma tabela BINTABLE com tempo e um vetor multibanda. Selecione/exporte a tabela RATE para CSV/ASCII, ou envie um arquivo FITS com colunas de taxa explícitas.');
  const {header,cols,nRows,rowWidth,dataStart}=chosen;const view=new DataView(buffer);const swift=/swift|bat/i.test(filename);const energyLabels=['14_20','20_24','24_35','35_50','50_75','75_100','100_150','150_195','14_195'];
  const heapStart=dataStart+Number(header.THEAP??(rowWidth*nRows));
  const outHeader=[], layout=[];
  for(const col of cols){
    const normalized=normName(col.name);const isTime=/^time$|^mjd$|date/.test(normalized);const isError=/(err|error|sigma|uncert|bkg var)/.test(normalized);const isRates=/(rate|flux|count|cent)/.test(normalized)&&!isError;
    if(col.format.code==='X') continue;
    if(col.format.variable){
      if(swift && (isRates||isError)){
        for(let k=0;k<9;k++){const label=`${isError?'ERR':'RATE'}_${energyLabels[k]}`;outHeader.push(label);layout.push({col,index:k,label,variable:true});}
      } else if(isTime){outHeader.push(col.name);layout.push({col,index:0,label:col.name,variable:true});}
      else if(/rate|flux|count|cent/i.test(col.name)){for(let k=0;k<8;k++){const label=`${col.name}_${k+1}`;outHeader.push(label);layout.push({col,index:k,label,variable:true});}}
      continue;
    }
    for(let k=0;k<col.format.repeat;k++){
      let label;
      if(col.format.repeat===1)label=col.name;
      else if(swift && (isRates||isError) && k<9){const e=energyLabels[k];label=`${isError?'ERR':'RATE'}_${e}`;}
      else label=`${col.name}_${k+1}`;
      outHeader.push(label);layout.push({col,index:k,label,variable:false});
    }
  }
  const rows=[];
  for(let r=0;r<nRows;r++){
    const base=dataStart+r*rowWidth, values=[];
    for(const item of layout){const {col,index}=item;const {code}=col.format;let value=null;const at=base+col.offset;
      if(item.variable && (code==='P'||code==='Q')){
        const descAt=at+index* (code==='P'?8:16);
        const count=code==='P'?view.getInt32(descAt,false):Number(view.getBigInt64(descAt,false));
        const heapOffset=code==='P'?view.getInt32(descAt+4,false):Number(view.getBigInt64(descAt+8,false));
        const elementCode=col.format.elementCode;const elementBytes=({L:1,B:1,I:2,J:4,K:8,E:4,D:8,C:8,M:16,A:1})[elementCode]||0;
        if(count>index && elementBytes>0 && heapOffset>=0){const pos=heapStart+heapOffset+index*elementBytes;if(pos+elementBytes<=bytes.length)value=fitsReadScalar(view,pos,elementCode);}
      } else if(code==='A'){value=decoder.decode(bytes.subarray(at,at+col.format.repeat)).trim();}
      else value=fitsReadScalar(view,at+index*col.format.width/col.format.repeat,code);
      values.push(typeof value==='number'&&Number.isFinite(value)?value:null);
    }
    rows.push(values);
  }
  const parsedMap=guessColumnMap(outHeader,outHeader.length);
  return {filename,header:outHeader,rows,delimiter:'fits',...parsedMap,rawLines:nRows,headerLine:-1,fits:true,units:cols.map(c=>c.unit)};
}

function populateMapping(parsed) {
  const swiftProfile = /swift|bat/i.test(parsed.filename || '') || parsed.header.some(h => /14.?20|20.?24|24.?35|35.?50|50.?75|75.?100|100.?150|150.?195/i.test(String(h)));
  state.bandDefs = BAND_DEFS.map((b,i) => ({...b, name: swiftProfile ? b.name : `Banda ${i+1}`, short: swiftProfile ? b.short : `B${i+1}`}));
  state.table = parsed; state.header = parsed.header; state.dataRows = parsed.rows; state.delimiter = parsed.delimiter; state.fileName = parsed.filename;
  state.timeIndex = parsed.time; state.bandIndices = parsed.rates.slice(); state.errorIndices = parsed.errors.slice(); state.timeLabel = parsed.header[parsed.time] || 'Tempo';
  const area = el('mappingArea');
  const options = parsed.header.map((name,i)=>`<option value="${i}">${escapeHtml(`${i+1}. ${name}`)}</option>`).join('');
  const timeSelect = `<select id="timeColumn" aria-label="Coluna de tempo">${options}</select>`;
  const selectFor = (id, val, label) => `<select id="${id}" aria-label="${escapeHtml(label)}"><option value="-1">— não usar —</option>${options}</select>`;
  area.innerHTML = `<div class="mapping-scroll"><table class="mapping-table"><thead><tr><th>Banda</th><th>Taxa / fluxo</th><th>Erro (opcional)</th></tr></thead><tbody>${state.bandDefs.map((b,i)=>`<tr><td><input class="band-label-input" id="label-${i}" value="${escapeHtml(b.name)}" aria-label="Rótulo da banda ${i+1}"></td><td>${selectFor(`rate-${i}`, parsed.rates[i], `Taxa de ${b.name}`)}</td><td>${selectFor(`err-${i}`, parsed.errors[i], `Erro de ${b.name}`)}</td></tr>`).join('')}</tbody></table></div><div class="mapping-time"><label class="field"><span>Coluna de tempo</span>${timeSelect}</label></div>`;
  const tc=el('timeColumn'); tc.value=String(parsed.time);
  for (let i=0;i<8;i++) { const rs=el(`rate-${i}`), es=el(`err-${i}`), label=el(`label-${i}`); rs.value=String(parsed.rates[i] ?? -1); es.value=String(parsed.errors[i] ?? -1); rs.addEventListener('change',()=>{state.bandIndices[i]=Number(rs.value)>=0?Number(rs.value):null;}); es.addEventListener('change',()=>{state.errorIndices[i]=Number(es.value)>=0?Number(es.value):null;}); label.addEventListener('change',()=>{const text=label.value.trim()||`Banda ${i+1}`;state.bandDefs[i].name=text;state.bandDefs[i].short=text;}); label.addEventListener('blur',()=>{const text=label.value.trim()||`Banda ${i+1}`;state.bandDefs[i].name=text;state.bandDefs[i].short=text;}); }
  tc.addEventListener('change',()=>{state.timeIndex=Number(tc.value);state.timeLabel=parsed.header[state.timeIndex]||'Tempo';});
  el('mappingCount').textContent=`${parsed.header.length} colunas detectadas`;
  el('dataBadge').textContent='DADOS CARREGADOS';
  el('analyzeBtn').disabled=false;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function labelLikelyRates(rows, nCols) { return rows.length > 1 && nCols > 1; }

async function handleFile(file) {
  if (!file) return;
  fileStatus(`Lendo ${file.name}…`);
  message('');
  try {
    const buffer = await readFileBuffer(file);
    const bytes = new Uint8Array(buffer);
    const looksFits = new TextDecoder('ascii').decode(bytes.subarray(0,8)).trim() === 'SIMPLE';
    const parsed = looksFits ? parseFitsBuffer(buffer,file.name) : parseTextTable(new TextDecoder('utf-8',{fatal:false}).decode(buffer),file.name);
    populateMapping(parsed);
    el('sourceName').value = file.name.replace(/\.(lc|txt|csv|tsv|dat)(\.gz)?$/i,'').replace(/^BAT_157m_eight_band_snapshot_/i,'').replaceAll('_',' ');
    if (/swift|bat/i.test(file.name)) el('instrumentName').value='Swift-BAT';
    fileStatus(`${file.name} · ${parsed.rows.length.toLocaleString('pt-BR')} linhas · ${parsed.header.length} colunas`, 'success');
    message('Verifique o mapeamento das colunas antes de calcular. Os valores sugeridos pelo site são editáveis.');
    state.parsed=true;
  } catch (err) {
    fileStatus(err.message || 'Erro ao ler arquivo.', 'error');
    message(err.message || 'Erro ao ler arquivo.', 'error');
    el('analyzeBtn').disabled=true; el('mappingCount').textContent='—'; el('dataBadge').textContent='ERRO NA LEITURA';
  }
}

// The validated scientific core is shared by full-series and temporal-window analyses.
function sampleEntropy(series, m, toleranceMultiplier) {
  if (!window.EntropyCore || typeof window.EntropyCore.sampleEntropy !== 'function') {
    throw new Error('O núcleo científico analysis-core.js não carregou. Recarregue a página e confira se o arquivo está na raiz do projeto.');
  }
  return window.EntropyCore.sampleEntropy(series, m, toleranceMultiplier);
}
function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }
function std(arr) { if (!arr.length) return null; const m=mean(arr); return Math.sqrt(mean(arr.map(v=>(v-m)**2))); }
function formatNum(v,d=3) { return Number.isFinite(v) ? v.toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d}) : '—'; }
function formatInt(v) { return Number(v).toLocaleString('pt-BR'); }
function parseTime(v) { return Number.isFinite(v) ? v : null; }
function getRowsFromMap() {
  const timeIdx=Number(el('timeColumn').value); state.timeIndex=timeIdx;
  const bands=[];
  for(let i=0;i<8;i++) {
    const ri=Number(el(`rate-${i}`).value), ei=Number(el(`err-${i}`).value);
    state.bandIndices[i]=ri>=0?ri:null; state.errorIndices[i]=ei>=0?ei:null;
    const points=[];
    for(const row of state.dataRows) {
      const t=row[timeIdx], y=ri>=0?row[ri]:null, err=ei>=0?row[ei]:null;
      if (Number.isFinite(t) && Number.isFinite(y)) points.push({x:t,y,error:Number.isFinite(err)?err:null});
    }
    points.sort((a,b)=>a.x-b.x);
    bands.push({def:state.bandDefs[i],points,rawValues:points.map(p=>p.y),errorIndex:ei});
  }
  return bands;
}
function timeUnitLabel(header) { const n=normName(header); if(n.includes('mjd')) return 'MJD'; if(n.includes('time')) return 'Tempo'; if(n.includes('date')) return 'Data'; if(n.includes('day')) return 'Dias'; return header || 'Tempo'; }
function timeCadence(points) {
  const diffs=[]; for(let i=1;i<points.length;i++){const d=points[i].x-points[i-1].x;if(d>0&&Number.isFinite(d))diffs.push(d);}
  if(diffs.length<2) return {median:null,cv:null};
  const med=[...diffs].sort((a,b)=>a-b)[Math.floor(diffs.length/2)]; const m=mean(diffs);return {median:med,cv:m?std(diffs)/m:null};
}

function analyze() {
  if(!state.parsed || !state.dataRows.length) {message('Carregue um arquivo primeiro.','error');return;}
  const m=Number(el('embedding').value), r=Number(el('tolerance').value);
  if(!Number.isFinite(r)||r<=0){message('A tolerância precisa ser maior que zero.','error');return;}
  const bands=getRowsFromMap();
  if(bands.every(b=>!b.points.length)){message('Nenhuma banda tem dados válidos. Confira o mapeamento das colunas.','error');return;}
  const results=bands.map(b=>{
    const values=b.points.map(p=>p.y);
    const res=sampleEntropy(values,m,r);
    const modulationResult=window.EntropyCore.intrinsicModulation(
      b.points.map(p=>({y:p.y,error:p.error})), b.errorIndex>=0
    );
    return {
      ...b, ...res,
      modulationIndex: modulationResult.value,
      modulationResult,
      mean:mean(values), std:std(values), n:values.length,
      cadence:timeCadence(b.points)
    };
  });
  const valid=results.filter(r=>Number.isFinite(r.value));
  state.results=results;state.latestAnalysis={m,r,source:el('sourceName').value.trim()||state.fileName,instrument:el('instrumentName').value.trim()||'Não informado',timeLabel:timeUnitLabel(state.table.header[state.timeIndex]),algorithmVersion:window.EntropyCore.VERSION,timestamp:new Date()};
  renderResults(results, valid);
  el('resultsSection').classList.remove('hidden');
  el('resultsSection').scrollIntoView({behavior:'smooth',block:'start'});
  const missing=results.filter(x=>!Number.isFinite(x.value)).length;
  message(missing?`Análise concluída. ${missing} banda(s) não produziram SampEn finita; veja a coluna Status.`:'Análise concluída com sucesso para as oito bandas.','');
}

function destroyCharts(){for(const c of state.charts){try{removeChartToolbar(c.canvas);c.destroy()}catch{}}state.charts=[];if(state.temporalSampenChart){try{removeChartToolbar(state.temporalSampenChart.canvas);state.temporalSampenChart.destroy()}catch{}state.temporalSampenChart=null;if(el('temporalSampenStatus'))el('temporalSampenStatus').textContent='Os dados mudaram. Recalcule a SampEn temporal para atualizar este gráfico.';}}
function chartDefaults(){
  const plugins={legend:{display:false},tooltip:{backgroundColor:'#0b1020',borderColor:'#35435f',borderWidth:1,titleColor:'#eaf1ff',bodyColor:'#bdcbe4',displayColors:false}};
  if (window.ChartZoom || (window.Chart && Chart.registry?.plugins?.get?.('zoom'))) {
    plugins.zoom={limits:{x:{min:'original',max:'original'},y:{min:'original',max:'original'}},pan:{enabled:true,mode:'xy',modifierKey:'shift'},zoom:{wheel:{enabled:true,speed:0.08},pinch:{enabled:true},drag:{enabled:true,backgroundColor:'rgba(92,222,194,.12)',borderColor:'rgba(92,222,194,.75)',borderWidth:1},mode:'xy'}};
  }
  return {responsive:true,maintainAspectRatio:false,animation:{duration:250},plugins,scales:{x:{grid:{color:'rgba(128,149,190,.08)'},ticks:{color:'#7787a5',maxTicksLimit:7,font:{family:'DM Mono',size:9}},border:{color:'#34405a'}},y:{grid:{color:'rgba(128,149,190,.10)'},ticks:{color:'#7787a5',maxTicksLimit:5,font:{family:'DM Mono',size:9}},border:{color:'#34405a'}}}};
}
function removeChartToolbar(canvas){
  const card=canvas?.closest?.('.chart-panel, .lightcurve-card');
  card?.querySelector('.chart-zoom-toolbar')?.remove();
}
function changeChartZoom(chart, factor){
  if(typeof chart.zoom==='function') { chart.zoom(factor); return; }
  const scales=Object.values(chart.scales||{});
  if(!chart.$melOriginalBounds){
    chart.$melOriginalBounds={};
    for(const scale of scales) chart.$melOriginalBounds[scale.id]={min:scale.min,max:scale.max,type:scale.type};
  }
  for(const scale of scales){
    const original=chart.$melOriginalBounds[scale.id];
    const options=chart.options.scales?.[scale.id];
    if(!options||!Number.isFinite(scale.min)||!Number.isFinite(scale.max)||scale.max<=scale.min)continue;
    const log=scale.type==='logarithmic';
    const low=log?Math.log(scale.min):scale.min, high=log?Math.log(scale.max):scale.max;
    const center=(low+high)/2, half=(high-low)/(2*factor);
    let min=log?Math.exp(center-half):center-half;
    let max=log?Math.exp(center+half):center+half;
    if(original && Number.isFinite(original.min)&&Number.isFinite(original.max)){
      if(factor>1){min=Math.max(min,original.min);max=Math.min(max,original.max);}
    }
    options.min=min;options.max=max;
  }
  chart.update('none');
}
function resetChartZoom(chart){
  if(typeof chart.resetZoom==='function'){chart.resetZoom();return;}
  const scales=chart.options.scales||{};
  for(const [id,bounds] of Object.entries(chart.$melOriginalBounds||{})){
    if(scales[id]){scales[id].min=bounds.min;scales[id].max=bounds.max;}
  }
  chart.update('none');
}
function installChartToolbar(chart){
  const canvas=chart?.canvas;
  const card=canvas?.closest?.('.chart-panel, .lightcurve-card');
  if(!canvas||!card)return;
  card.querySelector('.chart-zoom-toolbar')?.remove();
  const anchor=card.querySelector('.chart-heading, .lightcurve-card-head');
  if(!anchor)return;
  const toolbar=document.createElement('div');toolbar.className='chart-zoom-toolbar';toolbar.setAttribute('aria-label','Controles do gráfico');
  const makeButton=(label,title,action,extra='')=>{const b=document.createElement('button');b.type='button';b.className=`chart-tool-button ${extra}`.trim();b.textContent=label;b.title=title;b.setAttribute('aria-label',title);b.addEventListener('click',()=>action(chart));toolbar.appendChild(b);};
  makeButton('−','Diminuir zoom',c=>changeChartZoom(c,1/1.25));
  makeButton('+','Aumentar zoom',c=>changeChartZoom(c,1.25));
  makeButton('Reset','Restaurar escala original',c=>resetChartZoom(c),'chart-tool-reset');
  makeButton('PNG','Salvar este gráfico como PNG',c=>{const a=document.createElement('a');a.href=c.toBase64Image('image/png',1);a.download=`${(c.canvas.id||'grafico').replace(/[^a-z0-9_-]+/gi,'_')}.png`;a.click();},'chart-tool-download');
  const hint=document.createElement('span');hint.className='chart-zoom-hint';hint.textContent=(window.ChartZoom||chart.zoom)?'Roda/pinça: zoom · Shift + arraste: mover':'Use +/− para zoom';toolbar.appendChild(hint);
  anchor.insertAdjacentElement('afterend',toolbar);
}
function makeChart(ctx,config){if(!window.Chart)throw new Error('A biblioteca de gráficos não carregou. Confira a conexão à internet e recarregue a página.');const c=new Chart(ctx,config);state.charts.push(c);installChartToolbar(c);return c;}
function renderResults(results,valid){
  const an=state.latestAnalysis;const source=an.source||'Fonte sem nome';
  el('resultsSubtitle').textContent=`${source} · ${an.instrument} · m = ${an.m}, r = ${String(an.r).replace('.',',')}σ`;
  el('metricBands').textContent=`${valid.length}/8`;
  el('metricMean').textContent=valid.length?formatNum(mean(valid.map(x=>x.value))):'—';
  const max=valid.length?valid.reduce((a,b)=>a.value>b.value?a:b):null;
  el('metricMax').textContent=max?formatNum(max.value):'—';el('metricMaxBand').textContent=max?max.def.name:'nenhuma banda válida';
  const maxPoints=results.reduce((a,b)=>Math.max(a,b.n),0);el('metricPoints').textContent=formatInt(maxPoints);
  const validModulations=results.filter(r=>Number.isFinite(r.modulationIndex));
  el('metricModMean').textContent=validModulations.length?`${formatNum(mean(validModulations.map(r=>r.modulationIndex)),2)}%`:'—';
  const tbody=el('resultsTable').querySelector('tbody');
  tbody.innerHTML=results.map(r=>{
    const sampenOK=Number.isFinite(r.value), sampenStatus=sampenOK?'OK':(r.reason||'Indisponível');
    const mod=r.modulationResult||{};
    const modStatus=mod.status==='OK'?'OK':(mod.reason||'Indisponível');
    const sampenClass=sampenOK?'':'warning';
    const modClass=Number.isFinite(r.modulationIndex)?'':(mod.status==='negative_intrinsic_variance'||mod.status==='nonpositive_mean'?'warning':'failed');
    return `<tr><td><span class="band-dot" style="background:${r.def.color}"></span>${r.def.name}</td><td>${formatInt(r.n)}</td><td>${formatNum(r.sigma,3)}</td><td><strong>${formatNum(r.value,4)}</strong></td><td><strong>${Number.isFinite(r.modulationIndex)?formatNum(r.modulationIndex,2)+'%':'—'}</strong></td><td><span class="result-status ${sampenClass}" title="${escapeHtml(sampenStatus)}">${escapeHtml(sampenStatus)}</span></td><td><span class="result-status ${modClass}" title="${escapeHtml(modStatus)}">${escapeHtml(modStatus)}</span><br><small class="microcopy">N usado: ${formatInt(mod.nUsed??0)} · erros excluídos: ${formatInt(mod.nErrorExcluded??0)}</small></td></tr>`;
  }).join('');
  destroyCharts();
  const ctx=el('entropyChart').getContext('2d');
  makeChart(ctx,{type:'bar',data:{labels:results.map(r=>r.def.short),datasets:[{data:results.map(r=>Number.isFinite(r.value)?r.value:null),backgroundColor:results.map(r=>r.def.color+'cc'),borderColor:results.map(r=>r.def.color),borderWidth:1,borderRadius:4,maxBarThickness:42}]},options:{...chartDefaults(),scales:{...chartDefaults().scales,y:{...chartDefaults().scales.y,beginAtZero:true,title:{display:true,text:'Sample Entropy',color:'#93a3c0',font:{family:'DM Mono',size:10}}},x:{...chartDefaults().scales.x,title:{display:true,text:'Banda',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
  const modCanvas=el('modulationChart');
  makeChart(modCanvas.getContext('2d'),{type:'bar',data:{labels:results.map(r=>r.def.short),datasets:[{label:'Índice de modulação intrínseco (%)',data:results.map(r=>Number.isFinite(r.modulationIndex)?r.modulationIndex:null),backgroundColor:results.map(r=>r.def.color+'cc'),borderColor:results.map(r=>r.def.color),borderWidth:1,borderRadius:4,maxBarThickness:42}]},options:{...chartDefaults(),scales:{...chartDefaults().scales,y:{...chartDefaults().scales.y,beginAtZero:true,title:{display:true,text:'m intrínseco (%)',color:'#93a3c0',font:{family:'DM Mono',size:10}}},x:{...chartDefaults().scales.x,title:{display:true,text:'Banda',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
  renderLightcurves(results);
  renderOverlayLightcurve(results);
  const cadence=results.map(r=>r.cadence.cv).filter(Number.isFinite); const irregular=cadence.some(v=>v>0.1);
  el('methodNoteText').textContent=`SampEn calculada pelo núcleo ${an.algorithmVersion||'científico'} com H_SE = −ln(A/B), distância de Chebyshev e r = ${String(an.r).replace('.',',')} × σ populacional de cada banda. ${irregular?'Os intervalos temporais variam entre observações; SampEn usa a ordem dos pontos, não pondera os intervalos reais. ':'SampEn usa a sequência de pontos e não pondera diretamente os intervalos reais. '}A modulação intrínseca segue m = 100 × √(S² − média(erro²)) / fluxo médio e usa apenas pares fluxo–incerteza válidos. Resultados indefinidos permanecem indisponíveis, não zero.`;
  el('generatedAt').textContent=`Processado em ${new Date().toLocaleString('pt-BR')}`;
}
function renderLightcurves(results){
  const grid=el('lightcurveGrid');const normalize=el('normalizeCurves').checked;
  grid.innerHTML=results.map((r,i)=>`<article class="lightcurve-card"><div class="lightcurve-card-head"><strong><span class="band-dot" style="background:${r.def.color}"></span>${r.def.name}</strong><span>SampEn ${formatNum(r.value,3)} · m ${Number.isFinite(r.modulationIndex)?formatNum(r.modulationIndex,2)+'%':'—'}</span></div><div class="lightcurve-canvas"><canvas id="lc-${i}" aria-label="Curva de luz ${r.def.name}"></canvas></div><div class="curve-meta"><span>N <b>${formatInt(r.n)}</b></span><span>média <b>${formatNum(r.mean,3)}</b></span><span>σ <b>${formatNum(r.std,3)}</b></span></div></article>`).join('');
  results.forEach((r,i)=>{
    const vals=r.points.map(p=>p.y);const mu=mean(vals)||0;const sd=std(vals)||1;
    const data=r.points.map(p=>({x:p.x,y:normalize?(p.y-mu)/sd:p.y}));
    const options={...chartDefaults(),parsing:false,scales:{...chartDefaults().scales,x:{...chartDefaults().scales.x,type:'linear',title:{display:true,text:state.latestAnalysis.timeLabel,color:'#8797b3',font:{family:'DM Mono',size:9}}},y:{...chartDefaults().scales.y,title:{display:true,text:normalize?'Fluxo normalizado (z-score)':'Taxa / fluxo',color:'#8797b3',font:{family:'DM Mono',size:9}}}},plugins:{...chartDefaults().plugins,tooltip:{...chartDefaults().plugins.tooltip,callbacks:{label:c=>`${c.parsed.y.toLocaleString('pt-BR',{maximumFractionDigits:5})}`}}}};
    makeChart(el(`lc-${i}`).getContext('2d'),{type:'line',data:{datasets:[{data,borderColor:r.def.color,backgroundColor:r.def.color+'22',borderWidth:1.5,pointRadius:0,pointHoverRadius:3,tension:0,spanGaps:false}]},options});
  });
}
function renderOverlayLightcurve(results){
  const canvas=el('lightcurveOverlayChart'); if(!canvas)return;
  const normalize=el('normalizeCurves').checked;
  const datasets=results.filter(r=>r.points&&r.points.length).map(r=>{
    const vals=r.points.map(p=>p.y), mu=mean(vals)||0, sd=std(vals)||1;
    const data=r.points.map(p=>({x:p.x,y:normalize?(p.y-mu)/sd:p.y}));
    return {label:r.def.name,data,borderColor:r.def.color,backgroundColor:r.def.color+'22',borderWidth:1.45,pointRadius:0,pointHoverRadius:2.5,tension:0,spanGaps:false};
  });
  makeChart(canvas.getContext('2d'),{type:'line',data:{datasets},options:{...chartDefaults(),parsing:false,interaction:{mode:'nearest',intersect:false},plugins:{...chartDefaults().plugins,legend:{display:true,position:'bottom',labels:{color:'#9cabc7',boxWidth:8,boxHeight:8,font:{size:9}}}},scales:{...chartDefaults().scales,x:{...chartDefaults().scales.x,type:'linear',title:{display:true,text:state.latestAnalysis?.timeLabel||'Tempo',color:'#93a3c0',font:{family:'DM Mono',size:10}}},y:{...chartDefaults().scales.y,title:{display:true,text:normalize?'Fluxo normalizado (z-score)':'Taxa / fluxo',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
}

async function calculateTemporalSampen(){
  if(!state.results.length||!state.latestAnalysis){el('temporalSampenStatus').textContent='Primeiro importe uma curva e calcule a SampEn por banda.';return;}
  const windowSize=Number(el('sampenWindowPoints').value), step=Number(el('sampenWindowStep').value), m=state.latestAnalysis.m, r=state.latestAnalysis.r;
  if(!Number.isInteger(windowSize)||windowSize<=m+1||!Number.isInteger(step)||step<1){el('temporalSampenStatus').textContent='Confira o tamanho e o passo das janelas.';return;}
  state.temporalSampenRunId=(state.temporalSampenRunId||0)+1;
  const runId=state.temporalSampenRunId;
  state.temporalSampenCancelRequested=false;
  const btn=el('calculateTemporalSampenBtn'), cancelBtn=el('cancelTemporalSampenBtn');
  btn.disabled=true;btn.textContent='Calculando…';if(cancelBtn){cancelBtn.hidden=false;cancelBtn.disabled=false;cancelBtn.textContent='Cancelar cálculo';}
  el('temporalSampenStatus').textContent=`Preparando janelas de ${windowSize} pontos com passo ${step}…`;
  let cancelled=false;
  try{
    const datasets=[];let totalWindows=0,validEntropy=0,processed=0;
    outer: for(const band of state.results){
      const points=band.points||[];const data=[];
      for(let start=0;start+windowSize<=points.length;start+=step){
        if(state.temporalSampenCancelRequested||state.temporalSampenRunId!==runId){cancelled=true;break outer;}
        const slice=points.slice(start,start+windowSize);const value=sampleEntropy(slice.map(p=>p.y),m,r);
        const center=slice[Math.floor(slice.length/2)];
        data.push({x:center?center.x:start+windowSize/2,y:Number.isFinite(value.value)?value.value:null});
        totalWindows++;processed++;if(Number.isFinite(value.value))validEntropy++;
        // Yield after every window for large N, so progress and cancel remain responsive.
        const yieldEvery=windowSize>=500?1:8;
        if(processed%yieldEvery===0){el('temporalSampenStatus').textContent=`Calculando ${windowSize} pontos/janela… ${processed.toLocaleString('pt-BR')} janelas avaliadas; ${validEntropy.toLocaleString('pt-BR')} SampEn finitas.`;await new Promise(resolve=>setTimeout(resolve,0));}
      }
      if(data.length)datasets.push({label:band.def.name,data,borderColor:band.def.color,backgroundColor:band.def.color+'22',borderWidth:1.4,pointRadius:windowSize>=500?1.2:2.1,pointHoverRadius:4,tension:0,spanGaps:false});
    }
    if(state.temporalSampenChart){try{removeChartToolbar(state.temporalSampenChart.canvas);state.temporalSampenChart.destroy()}catch(_){}state.temporalSampenChart=null;}
    const canvas=el('temporalSampenOverlayChart');
    if(datasets.length){
      state.temporalSampenChart=new Chart(canvas.getContext('2d'),{type:'line',data:{datasets},options:{...chartDefaults(),parsing:false,interaction:{mode:'nearest',intersect:false},plugins:{...chartDefaults().plugins,legend:{display:true,position:'bottom',labels:{color:'#9cabc7',boxWidth:8,boxHeight:8,font:{size:9}}},tooltip:{...chartDefaults().plugins.tooltip,callbacks:{label:c=>`${c.dataset.label}: SampEn ${Number.isFinite(c.parsed.y)?c.parsed.y.toFixed(4):'indisponível'}`}}},scales:{...chartDefaults().scales,x:{...chartDefaults().scales.x,type:'linear',title:{display:true,text:state.latestAnalysis.timeLabel,color:'#93a3c0',font:{family:'DM Mono',size:10}}},y:{...chartDefaults().scales.y,beginAtZero:true,title:{display:true,text:'Sample Entropy',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
      installChartToolbar(state.temporalSampenChart);
    }
    const prefix=cancelled?'Cancelado parcialmente. ':'Concluído. ';
    el('temporalSampenStatus').textContent=`${prefix}${validEntropy.toLocaleString('pt-BR')} SampEn finitas de ${totalWindows.toLocaleString('pt-BR')} janelas processadas; ${windowSize} pontos/janela, passo ${step}, m=${m}, r=${String(r).replace('.',',')}σ.${cancelled?' Você pode alterar os parâmetros e executar novamente.':''}`;
  }catch(err){el('temporalSampenStatus').textContent=`Falha no cálculo: ${err.message||err}`;}
  finally{btn.disabled=false;btn.textContent='Calcular SampEn temporal';if(cancelBtn){cancelBtn.hidden=true;cancelBtn.disabled=false;}}
}

el('normalizeCurves').addEventListener('change',()=>{if(state.results.length)renderResults(state.results,state.results.filter(r=>Number.isFinite(r.value)));});
el('calculateTemporalSampenBtn')?.addEventListener('click',calculateTemporalSampen);
el('cancelTemporalSampenBtn')?.addEventListener('click',()=>{state.temporalSampenCancelRequested=true;const b=el('cancelTemporalSampenBtn');if(b){b.disabled=true;b.textContent='Cancelando…';}el('temporalSampenStatus').textContent='Cancelamento solicitado; a janela atual será concluída antes de parar.';});

function downloadBlob(blob, filename){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.style.display='none';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}
async function downloadRemoteUrl(rawUrl, fallbackFilename='curva-de-luz.lc.gz'){
  const url=safeHttpUrl(rawUrl);
  if(!url) throw new Error('O endereço não é uma URL HTTP(S) válida.');
  const response=await fetch(url.href,{method:'GET',mode:'cors',redirect:'follow'});
  if(!response.ok) throw new Error(`O servidor respondeu HTTP ${response.status}.`);
  const blob=await response.blob();
  if(!blob.size) throw new Error('O servidor retornou um arquivo vazio.');
  let filename=filenameFromUrl(new URL(response.url||url.href),response)||fallbackFilename;
  if(!filename || filename==='curva-remota.lc') filename=fallbackFilename;
  downloadBlob(blob,filename);
  return {filename,size:blob.size};
}
function downloadFailureText(error){
  if(error instanceof TypeError) return 'O navegador não conseguiu ler o arquivo porque o servidor pode bloquear CORS ou a conexão falhou.';
  return error?.message||'Não foi possível iniciar o download automático.';
}
el('downloadCsvBtn').addEventListener('click',()=>{
  if(!state.results.length)return;
  const an=state.latestAnalysis;
  const rows=[['source',an.source],['instrument',an.instrument],['algorithm_version',an.algorithmVersion||''],['embedding_m',an.m],['tolerance_multiplier_sigma',an.r],['sampen_formula','-ln(A/B)'],['modulation_formula','100*sqrt(observed_variance-mean(error^2))/mean_flux'],[],['band_keV','N_rate_valid','N_modulation_used','N_excluded_missing_invalid_error','mean_rate','sampen_sigma','A_matches','B_matches','SampEn','modulation_intrinsic_percent','observed_variance','noise_variance','intrinsic_variance','r_modulation_status','sampen_status']];
  for(const r of state.results){const mod=r.modulationResult||{};rows.push([r.def.name,r.n,mod.nUsed??'',mod.nErrorExcluded??'',r.mean??'',r.sigma??'',r.A??'',r.B??'',r.value??'',r.modulationIndex??'',mod.observedVariance??'',mod.noiseVariance??'',mod.intrinsicVariance??'',mod.status||'',r.reason||'OK']);}
  const csv='\uFEFF'+rows.map(row=>row.map(v=>{const s=String(v??'');return /[",\n;]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}).join(';')).join('\r\n');
  downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),`multiband_entropy_${slug(an.source)}.csv`);
});
function downloadChartPng(canvasId, filename){const canvas=el(canvasId);if(!canvas)return;canvas.toBlob(blob=>{if(blob)downloadBlob(blob,filename);});}
el('downloadPngBtn').addEventListener('click',()=>downloadChartPng('entropyChart',`sampen_por_banda_${slug(state.latestAnalysis?.source||'fonte')}.png`));
el('downloadModulationPngBtn').addEventListener('click',()=>downloadChartPng('modulationChart',`modulacao_intrinseca_por_banda_${slug(state.latestAnalysis?.source||'fonte')}.png`));
function slug(s){return String(s||'fonte').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70)||'fonte';}

el('analyzeBtn').addEventListener('click',()=>{
  const btn=el('analyzeBtn');btn.disabled=true;btn.innerHTML='<span class="loading-spinner"></span><span>Calculando…</span>';
  setTimeout(()=>{try{analyze();}catch(e){message(e.message||'Falha inesperada na análise.','error');}finally{btn.disabled=false;btn.innerHTML='<span>Calcular SampEn + modulação</span><span class="button-arrow">↗</span>'; }},25);
});
const dz=el('dropzone');dz.addEventListener('click',()=>el('fileInput').click());dz.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el('fileInput').click();}});el('fileInput').addEventListener('change',e=>handleFile(e.target.files?.[0]));
for(const eventName of ['dragenter','dragover'])dz.addEventListener(eventName,e=>{e.preventDefault();dz.classList.add('dragover');});for(const eventName of ['dragleave','drop'])dz.addEventListener(eventName,e=>{e.preventDefault();dz.classList.remove('dragover');});dz.addEventListener('drop',e=>handleFile(e.dataTransfer?.files?.[0]));

function makeDemo(){
  const header=['MJD','RATE_14_20','RATE_20_24','RATE_24_35','RATE_35_50','RATE_50_75','RATE_75_100','RATE_100_150','RATE_150_195','ERR_14_20','ERR_20_24','ERR_24_35','ERR_35_50','ERR_50_75','ERR_75_100','ERR_100_150','ERR_150_195'];
  const rows=[];let seed=20261011;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<190;i++){const t=56500+i*2.3+(rand()-.5)*.35;const row=[t];const rates=[];for(let b=0;b<8;b++){const trend=0.1+0.015*b;const val=trend+(.3/(1+b*.3))*Math.sin(i*(.11+b*.018))+(.09/(1+b*.1))*(rand()-.5)+.045*Math.sin(i*.037+b);rates.push(val);}row.push(...rates);row.push(...rates.map((v,b)=>.04+.007*b+rand()*.02));rows.push(row);}
  const parsed={filename:'demonstracao_swift_bat_8band.lc',header,rows,delimiter:'whitespace',time:0,rates:Array.from({length:8},(_,i)=>i+1),errors:Array.from({length:8},(_,i)=>i+9)};
  populateMapping(parsed);state.parsed=true;
  el('sourceName').value='Fonte demonstrativa';el('instrumentName').value='Swift-BAT (simulado)';
  fileStatus('Dados demonstrativos gerados no navegador · 190 épocas × 8 bandas','success');message('Esta é uma série sintética para testar a interface, não são dados reais de uma fonte astronômica. Confira o mapeamento e clique em calcular.');
}
el('demoBtn').addEventListener('click',makeDemo);

// Import tabs and direct-URL loading. Browser cross-origin (CORS) policies can block some hosts.
function setupImportTabs() {
  const tabs = [...document.querySelectorAll('.import-tab[data-tab]')];
  const panels = [...document.querySelectorAll('.import-tab-panel')];
  function activate(tab) {
    const target = tab.dataset.tab;
    for (const button of tabs) {
      const active = button === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels) panel.classList.toggle('hidden', panel.id !== target);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activate(tabs[next]); tabs[next].focus();
    });
  });
  if (tabs.length) activate(tabs[0]);
}
function safeHttpUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch (_) { return null; }
}
function updateDirectLink() {
  const input = el('directUrlInput'), link = el('openDirectLink');
  const url = safeHttpUrl(input.value);
  if (url) {
    link.href = url.href;
    link.classList.remove('disabled-link');
    link.setAttribute('aria-disabled', 'false');
  } else {
    link.href = '#';
    link.classList.add('disabled-link');
    link.setAttribute('aria-disabled', 'true');
  }
}
function filenameFromUrl(url, response) {
  const disposition = response?.headers?.get('content-disposition') || '';
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  const candidate = utf8 ? decodeURIComponent(utf8[1]) : (plain ? plain[1].trim() : decodeURIComponent(url.pathname.split('/').pop() || 'curva-remota.lc'));
  return (candidate || 'curva-remota.lc').replace(/[\\/:*?"<>|]+/g, '_');
}
async function importFromDirectUrl() {
  const input = el('directUrlInput'), button = el('loadUrlBtn'), help = el('urlHelp');
  const url = safeHttpUrl(input.value);
  if (!url) {
    help.textContent = 'Cole um endereço completo começando com https:// ou http://.';
    help.classList.add('error'); input.focus(); return;
  }
  help.classList.remove('error');
  button.disabled = true;
  button.innerHTML = '<span class="loading-spinner"></span> Baixando…';
  fileStatus('Baixando o arquivo pelo link informado…');
  try {
    const response = await fetch(url.href, { method: 'GET', mode: 'cors', redirect: 'follow' });
    if (!response.ok) throw new Error(`O servidor respondeu HTTP ${response.status}.`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('O servidor retornou um arquivo vazio.');
    const filename = filenameFromUrl(new URL(response.url || url.href), response);
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream', lastModified: Date.now() });
    help.textContent = `Download recebido (${(blob.size / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB). O laboratório está lendo o arquivo.`;
    await handleFile(file);
  } catch (error) {
    const detail = error instanceof TypeError
      ? 'O navegador bloqueou o acesso direto ao servidor (CORS) ou não conseguiu conectar.'
      : (error.message || 'Falha ao baixar o arquivo.');
    fileStatus(`Não foi possível importar pela URL: ${detail}`, 'error');
    message('Abra o link para baixar o arquivo e, depois, carregue-o pela aba “Arquivo local”.', 'error');
    help.textContent = `${detail} Isso é uma restrição do servidor/navegador, não necessariamente um problema no arquivo. Use “Abrir / baixar link” e depois selecione o arquivo baixado em “Arquivo local”.`;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Tentar importar <span class="button-arrow">↗</span>';
  }
}
setupImportTabs();
el('directUrlInput').addEventListener('input', updateDirectLink);
el('loadUrlBtn').addEventListener('click', importFromDirectUrl);
el('openDirectLink').addEventListener('click', async event => {
  event.preventDefault();
  const link=el('openDirectLink'),help=el('urlHelp');
  if (link.getAttribute('aria-disabled') === 'true') {
    help.textContent = 'Cole primeiro um link completo começando com https:// ou http://.';
    help.classList.add('error');
    return;
  }
  if(link.dataset.downloading==='true') return;
  link.dataset.downloading='true';help.classList.remove('error');
  help.textContent='Tentando baixar o arquivo diretamente…';
  try{
    const result=await downloadRemoteUrl(link.href,'curva-de-luz.lc.gz');
    help.textContent=`Download iniciado: ${result.filename} (${(result.size/1024/1024).toLocaleString('pt-BR',{maximumFractionDigits:2})} MB).`;
  }catch(error){
    help.classList.add('error');
    help.textContent=`O navegador não conseguiu forçar o download. ${downloadFailureText(error)} Para salvar mesmo assim, clique com o botão direito neste link e escolha “Salvar link como…”.`;
  }finally{link.dataset.downloading='false';}
});

// NASA Swift-BAT library helper: construct the official per-source snapshot URL.
function prepareNasaLink(){
  const input=el('nasaSourceName');
  let source=input.value.trim().replace(/^BAT_157m_eight_band_snapshot_/i,'').replace(/\.lc(?:\.gz)?$/i,'').replace(/\.gz$/i,'').trim();
  source=source.replace(/^SWIFT[_ ]+/i,'SWIFT_').replace(/[\s]+/g,'_');
  if(!source || !/^SWIFT_[A-Za-z0-9.+-]+$/i.test(source)){
    message('Digite o nome Swift como aparece no catálogo, por exemplo: SWIFT J0010.5+1057.','error');
    input.focus();return;
  }
  const url='https://swift.gsfc.nasa.gov/bat_survey/bs157mon/8band_snapshot_lc/'+encodeURIComponent('BAT_157m_eight_band_snapshot_'+source+'.lc.gz');
  const link=el('nasaDownloadLink');
  link.href=url;link.classList.remove('hidden');
  el('nasaDownloadLabel').textContent=source.replace(/^SWIFT_/,'SWIFT ')+' · arquivo oficial .lc.gz';
  el('sourceName').value=source.replace(/^SWIFT_/,'SWIFT ').replaceAll('_',' ');
  el('instrumentName').value='Swift-BAT';
  el('nasaDownloadHelp').textContent='Clique em “Baixar curva .lc.gz” para tentar salvar diretamente. Se o servidor bloquear, use o botão direito → “Salvar link como…”.';
  message('Link oficial preparado. Clique em “Baixar curva .lc.gz” para salvar o arquivo.');
}
el('nasaDownloadLink').addEventListener('click',async event=>{
  event.preventDefault();
  const link=el('nasaDownloadLink'),help=el('nasaDownloadHelp');
  if(!link.href||link.href.endsWith('#')) return;
  if(link.dataset.downloading==='true') return;
  link.dataset.downloading='true';help.classList.remove('error');help.textContent='Baixando a curva oficial da NASA…';
  try{
    const result=await downloadRemoteUrl(link.href,'curva-swift-bat.lc.gz');
    help.textContent=`Download iniciado: ${result.filename} (${(result.size/1024/1024).toLocaleString('pt-BR',{maximumFractionDigits:2})} MB).`;
    message('Download da curva NASA iniciado.');
  }catch(error){
    help.classList.add('error');
    help.textContent=`O navegador não conseguiu salvar automaticamente. ${downloadFailureText(error)} Para tentar salvar sem abrir o arquivo, clique com o botão direito em “Baixar curva .lc.gz” e escolha “Salvar link como…”.`;
    message('O servidor NASA pode bloquear downloads iniciados por outro site; veja a orientação abaixo do link.','error');
  }finally{link.dataset.downloading='false';}
});

el('nasaPrepareBtn').addEventListener('click',prepareNasaLink);
el('nasaSourceName').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();prepareNasaLink();}});

// Keep the eight-band mapping specific to the Swift-BAT 157-month products, while supporting arbitrary column names via selectors.


// ==============================================================
// Catalog plot builder: creates figures from individual-source
// CSV. All catalog graphs are calculated from the imported rows;
// are explicitly labeled as summary statistics, not raw records.
// ============================================================== 
state.articleCharts = [];
state.articleTable = null;
state.articleCleanRows = [];
state.articleHeader = [];
state.articleRawRows = [];

const ARTICLE_PALETTE = ['#8a8dff','#5cdec2','#ffbd78','#f285a3','#71b7ff','#d0a1ff','#b1d765','#ff9e6d','#c4d2ec','#d68aff'];

function destroyArticleCharts(){
  for(const chart of (state.articleCharts || [])){try{removeChartToolbar(chart.canvas);chart.destroy();}catch(_){}}
  state.articleCharts=[];
}
function makeArticleChart(id, config){
  if(!window.Chart) throw new Error('A biblioteca de gráficos não carregou. Confira a conexão à internet e recarregue a página.');
  const canvas=el(id);
  if(!canvas) throw new Error(`Canvas ausente: ${id}`);
  const chart=new Chart(canvas.getContext('2d'),config);
  state.articleCharts.push(chart);
  installChartToolbar(chart);
  return chart;
}
const ARTICLE_ERROR_BARS = {
  id:'articleErrorBars',
  afterDatasetsDraw(chart, args, opts){
    if(!opts || !Array.isArray(opts.errors)) return;
    const meta=chart.getDatasetMeta(0), y=chart.scales.y, ctx=chart.ctx;
    if(!meta || !y) return;
    ctx.save(); ctx.strokeStyle=opts.color || '#d6e1f8'; ctx.lineWidth=1.5;
    meta.data.forEach((element,i)=>{
      const mean=chart.data.datasets[0].data[i], err=opts.errors[i];
      if(!Number.isFinite(mean)||!Number.isFinite(err)) return;
      const top=y.getPixelForValue(mean+err), bottom=y.getPixelForValue(Math.max(0,mean-err));
      const x=element.x, cap=6;
      ctx.beginPath(); ctx.moveTo(x,top); ctx.lineTo(x,bottom);
      ctx.moveTo(x-cap,top); ctx.lineTo(x+cap,top);
      ctx.moveTo(x-cap,bottom); ctx.lineTo(x+cap,bottom); ctx.stroke();
    });
    ctx.restore();
  }
};

function parseDelimitedLine(line, delimiter){
  const out=[]; let token='', quoted=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){
      if(quoted && line[i+1]==='"'){token+='"';i++;}
      else quoted=!quoted;
    } else if(c===delimiter && !quoted){out.push(token.trim());token='';}
    else token+=c;
  }
  out.push(token.trim());
  return out.map(v=>v.replace(/^\uFEFF/,'').trim());
}
function parseArticleCatalog(text, filename='catalogo.csv'){
  const lines=String(text||'').replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>line.trim() && !line.trim().startsWith('#'));
  if(lines.length<2) throw new Error('A tabela precisa ter um cabeçalho e pelo menos uma linha de dados.');
  // Detect separator from the header only, so decimal commas in pt-BR
  // numeric cells do not overwhelm a semicolon-delimited CSV.
  const sample=lines[0];
  const counts={',':(sample.match(/,/g)||[]).length,';':(sample.match(/;/g)||[]).length,'\t':(sample.match(/\t/g)||[]).length};
  const delimiter=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
  if(!delimiter || counts[delimiter]===0) throw new Error('Não identifiquei separadores. Use CSV com vírgulas, CSV com ponto e vírgula ou TSV.');
  const header=parseDelimitedLine(lines[0],delimiter);
  if(header.length<2) throw new Error('Não encontrei colunas no cabeçalho.');
  const rows=[];
  for(let i=1;i<lines.length;i++){
    const row=parseDelimitedLine(lines[i],delimiter);
    if(!row.some(v=>v!=='')) continue;
    while(row.length<header.length) row.push('');
    rows.push(row.slice(0,header.length));
  }
  if(!rows.length) throw new Error('Não encontrei registros individuais.');
  return {filename,header,rows,delimiter};
}
function findArticleColumn(header, patterns){
  const normalized=header.map(h=>normName(h));
  for(const p of patterns){const i=normalized.findIndex(n=>p.test(n));if(i>=0)return String(i);}
  return '-1';
}
function populateArticleSelect(id, header, allowBlank, autoValue='-1'){
  const select=el(id); if(!select)return;
  select.innerHTML='';
  const blank=document.createElement('option'); blank.value='-1'; blank.textContent=allowBlank?'Não disponível':'Selecione uma coluna'; select.appendChild(blank);
  header.forEach((h,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=`${i+1}. ${h}`;select.appendChild(option);});
  select.value=autoValue;
}
function articleNumber(value, delimiter){
  if(value==null) return null;
  let s=String(value).trim().replace(/[\s\u00a0]/g,'');
  if(!s || /^(na|n\/a|nan|null|none|—|-|inf|infinity)$/i.test(s))return null;
  // For semicolon-delimited CSV, comma decimals are common in pt-BR.
  if(delimiter===';' && s.includes(',') && !s.includes('.')) s=s.replace(',','.');
  else if(s.includes(',') && !s.includes('.')) s=s.replace(',','.');
  const n=Number(s); return Number.isFinite(n)?n:null;
}
function downloadTextFile(content, filename, mime='text/csv;charset=utf-8'){
  const blob=new Blob(['\uFEFF',content],{type:mime}); const url=URL.createObjectURL(blob); const a=document.createElement('a');a.href=url;a.download=filename;a.style.display='none';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
}
function downloadArticleTemplate(){
  const template='source,class,sampen,modulation_index_percent,bubble_size\n';
  downloadTextFile(template,'modelo_catalogo_sampen_modulacao.csv');
}
function setupArticleMapping(parsed){
  state.articleTable=parsed;
  state.articleHeader=parsed.header;
  state.articleRawRows=parsed.rows;
  populateArticleSelect('articleSourceColumn',parsed.header,true,findArticleColumn(parsed.header,[/^source$/, /^fonte$/, /object name/, /^object$/, /^target$/, /^name$/]));
  populateArticleSelect('articleClassColumn',parsed.header,true,findArticleColumn(parsed.header,[/^class$/, /^classe$/, /optical class/, /classification/, /^tipo$/]));
  populateArticleSelect('articleSampenColumn',parsed.header,false,findArticleColumn(parsed.header,[/^sampen$/, /sample entropy/, /^hse$/, /^h se$/, /^entropy$/]));
  populateArticleSelect('articleModulationColumn',parsed.header,true,findArticleColumn(parsed.header,[/modulation index/, /intrinsic modulation/, /modulation percent/, /^mi$/, /^m percent$/, /^m pct$/]));
  populateArticleSelect('articleBubbleSizeColumn',parsed.header,true,findArticleColumn(parsed.header,[/^n pontos$/, /^n points$/, /number of epochs/, /^epochs$/, /snr/, /signal.to.noise/, /exposure/, /variability/, /variabilidade/]));
  el('articleFileLabel').textContent=`${parsed.filename} · ${parsed.rows.length.toLocaleString('pt-BR')} linhas`;
  el('articleMappingPanel').classList.remove('hidden');
  el('articleUploadEmpty').classList.add('hidden');
  el('analyzeArticleDataBtn').disabled=(el('articleSampenColumn').value==='-1');
  el('articleDataStatus').textContent='Mapeie as colunas e clique em “Gerar gráficos”. Se o índice de modulação não estiver na tabela, o histograma e o resumo de SampEn ainda poderão ser criados.';
}
function collectArticleRows(){
  if(!state.articleTable) throw new Error('Carregue um catálogo CSV/TSV antes de gerar os gráficos.');
  const ix={source:Number(el('articleSourceColumn').value),cls:Number(el('articleClassColumn').value),sampen:Number(el('articleSampenColumn').value),mod:Number(el('articleModulationColumn').value),size:Number(el('articleBubbleSizeColumn').value)};
  if(ix.sampen<0 || !Number.isFinite(ix.sampen)) throw new Error('Selecione a coluna de Sample Entropy.');
  const records=state.articleRawRows.map((row,index)=>({
    source:ix.source>=0?(row[ix.source]||`Fonte ${index+1}`):`Fonte ${index+1}`,
    className:ix.cls>=0?(row[ix.cls]||'Sem classe'):'Sem classe',
    sampen:articleNumber(row[ix.sampen],state.articleTable.delimiter),
    modulation:ix.mod>=0?articleNumber(row[ix.mod],state.articleTable.delimiter):null,
    bubbleSize:ix.size>=0?articleNumber(row[ix.size],state.articleTable.delimiter):null,
    rowNumber:index+2
  }));
  const clean=records.filter(r=>Number.isFinite(r.sampen));
  if(!clean.length) throw new Error('Nenhum valor numérico válido encontrado na coluna de Sample Entropy.');
  state.articleCleanRows=clean;
  return clean;
}
function pearsonCoefficient(rows){
  const pairs=rows.filter(r=>Number.isFinite(r.sampen)&&Number.isFinite(r.modulation));
  if(pairs.length<3)return null;
  const xs=pairs.map(r=>r.modulation), ys=pairs.map(r=>r.sampen); const mx=mean(xs),my=mean(ys);
  const num=pairs.reduce((s,r)=>s+(r.modulation-mx)*(r.sampen-my),0);
  const den=Math.sqrt(pairs.reduce((s,r)=>s+(r.modulation-mx)**2,0)*pairs.reduce((s,r)=>s+(r.sampen-my)**2,0));
  return den>0?num/den:null;
}
function spearmanCoefficient(rows){
  const pairs=rows.filter(r=>Number.isFinite(r.sampen)&&Number.isFinite(r.modulation));
  if(pairs.length<3)return null;
  function rank(values){const sorted=values.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v), ranks=Array(values.length);let p=0;while(p<sorted.length){let q=p+1;while(q<sorted.length&&sorted[q].v===sorted[p].v)q++;const avg=(p+1+q)/2;for(let k=p;k<q;k++)ranks[sorted[k].i]=avg;p=q;}return ranks;}
  const rx=rank(pairs.map(r=>r.modulation)), ry=rank(pairs.map(r=>r.sampen));
  const mx=mean(rx), my=mean(ry); let num=0,dx=0,dy=0;
  for(let i=0;i<rx.length;i++){const x=rx[i]-mx,y=ry[i]-my;num+=x*y;dx+=x*x;dy+=y*y;}
  return dx>0&&dy>0?num/Math.sqrt(dx*dy):null;
}
function regressionLogLog(rows){
  const pairs=rows.filter(r=>Number.isFinite(r.sampen)&&r.sampen>0&&Number.isFinite(r.modulation)&&r.modulation>0);
  if(pairs.length<3)return {slope:null, intercept:null, n:pairs.length};
  const x=pairs.map(r=>Math.log(r.modulation)), y=pairs.map(r=>Math.log(r.sampen));
  const mx=mean(x), my=mean(y); let num=0,den=0;
  for(let i=0;i<x.length;i++){num+=(x[i]-mx)*(y[i]-my);den+=(x[i]-mx)**2;}
  if(den===0)return {slope:null,intercept:null,n:pairs.length};
  const slope=num/den; return {slope,intercept:my-slope*mx,n:pairs.length};
}
function summarizeByClass(rows,key){
  const groups=new Map();
  for(const row of rows){const val=row[key];if(!Number.isFinite(val))continue;const name=row.className||'Sem classe';if(!groups.has(name))groups.set(name,[]);groups.get(name).push(val);}
  return [...groups.entries()].map(([name,values])=>({name,n:values.length,mean:mean(values),sd:values.length>1?stdSample(values):0})).filter(g=>g.n>0).sort((a,b)=>b.n-a.n);
}
function stdSample(values){if(values.length<2)return 0;const avg=mean(values);return Math.sqrt(values.reduce((s,v)=>s+(v-avg)**2,0)/(values.length-1));}
function renderArticleBars(canvasId, groups, fieldLabel, colorA='#8a8dff'){
  if(!groups.length){return;}
  const base=chartDefaults();
  makeArticleChart(canvasId,{
    type:'bar',
    data:{labels:groups.map(g=>`${g.name} · N=${g.n}`),datasets:[{label:fieldLabel,data:groups.map(g=>g.mean),backgroundColor:groups.map((_,i)=>ARTICLE_PALETTE[i%ARTICLE_PALETTE.length]+'cc'),borderColor:groups.map((_,i)=>ARTICLE_PALETTE[i%ARTICLE_PALETTE.length]),borderWidth:1,borderRadius:4,maxBarThickness:55}]},
    plugins:[ARTICLE_ERROR_BARS],
    options:{...base,plugins:{...base.plugins,legend:{display:false},articleErrorBars:{errors:groups.map(g=>g.sd),color:'#e4eaff'},tooltip:{...base.plugins.tooltip,callbacks:{label:c=>{const g=groups[c.dataIndex];return [`Média: ${g.mean.toLocaleString('pt-BR',{maximumFractionDigits:4})}`,`DP: ${g.sd.toLocaleString('pt-BR',{maximumFractionDigits:4})}`,`N: ${g.n}`];}}}},scales:{...base.scales,y:{...base.scales.y,beginAtZero:true,title:{display:true,text:fieldLabel,color:'#93a3c0',font:{family:'DM Mono',size:10}}},x:{...base.scales.x,ticks:{...base.scales.x.ticks,maxRotation:25,minRotation:0}}}}
  });
}
function renderArticleResults(rows){
  destroyArticleCharts();
  const validPairs=rows.filter(r=>Number.isFinite(r.sampen)&&r.sampen>0&&Number.isFinite(r.modulation)&&r.modulation>0);
  const corrPairs=rows.filter(r=>Number.isFinite(r.sampen)&&Number.isFinite(r.modulation)&&r.modulation>=0);
  const r=pearsonCoefficient(corrPairs), rho=spearmanCoefficient(corrPairs), fit=regressionLogLog(rows);
  el('articleDynamicResults').classList.remove('hidden');
  el('articleMetricRows').textContent=rows.length.toLocaleString('pt-BR');
  el('articleMetricSampen').textContent=rows.filter(x=>Number.isFinite(x.sampen)).length.toLocaleString('pt-BR');
  el('articleMetricPairs').textContent=validPairs.length.toLocaleString('pt-BR');
  el('articleMetricPearson').textContent=r==null?'—':r.toLocaleString('pt-BR',{minimumFractionDigits:3,maximumFractionDigits:3});
  // Histogram: the exact individual distribution is derived from the loaded rows.
  const vals=rows.map(x=>x.sampen).filter(Number.isFinite);
  let lo=vals.reduce((a,b)=>Math.min(a,b),Infinity), hi=vals.reduce((a,b)=>Math.max(a,b),-Infinity);
  const nBins=Math.min(30,Math.max(6,Math.ceil(Math.sqrt(vals.length))));
  if(lo===hi){lo-=0.5;hi+=0.5;}
  const width=(hi-lo)/nBins; const bins=Array.from({length:nBins},(_,i)=>({i,low:lo+i*width,high:i===nBins-1?hi:lo+(i+1)*width,count:0}));
  vals.forEach(v=>{let i=hi===lo?0:Math.floor((v-lo)/width);i=Math.max(0,Math.min(nBins-1,i));bins[i].count++;});
  const base=chartDefaults();
  makeArticleChart('articleSampenHistogram',{type:'bar',data:{labels:bins.map(b=>`${b.low.toFixed(2)}–${b.high.toFixed(2)}`),datasets:[{label:'Número de fontes',data:bins.map(b=>b.count),backgroundColor:'#8a8dffbb',borderColor:'#8a8dff',borderWidth:1,borderRadius:2}]},options:{...base,plugins:{...base.plugins,legend:{display:false},tooltip:{...base.plugins.tooltip,callbacks:{label:c=>`${c.parsed.y} fonte(s)`}}},scales:{...base.scales,y:{...base.scales.y,beginAtZero:true,title:{display:true,text:'Contagem',color:'#93a3c0',font:{family:'DM Mono',size:10}}},x:{...base.scales.x,ticks:{...base.scales.x.ticks,maxTicksLimit:9,maxRotation:45,minRotation:0},title:{display:true,text:'Sample Entropy',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
  // Overlay histograms by class using identical bin edges.
  const histClasses=[...new Set(rows.map(x=>x.className||'Sem classe'))].slice(0,7);
  const overlaySets=histClasses.map((cls,i)=>{
    const counts=Array(nBins).fill(0);
    rows.filter(x=>(x.className||'Sem classe')===cls&&Number.isFinite(x.sampen)).forEach(x=>{let b=hi===lo?0:Math.floor((x.sampen-lo)/width);b=Math.max(0,Math.min(nBins-1,b));counts[b]++;});
    const color=ARTICLE_PALETTE[i%ARTICLE_PALETTE.length];
    return {label:cls,data:counts,backgroundColor:color+'55',borderColor:color,borderWidth:1,grouped:false,barPercentage:1,categoryPercentage:0.92};
  });
  makeArticleChart('articleSampenHistogramOverlay',{type:'bar',data:{labels:bins.map(b=>`${b.low.toFixed(2)}–${b.high.toFixed(2)}`),datasets:overlaySets},options:{...base,plugins:{...base.plugins,legend:{display:histClasses.length>1,position:'bottom',labels:{color:'#9cabc7',font:{size:9},boxWidth:8}},tooltip:{...base.plugins.tooltip,callbacks:{label:c=>`${c.dataset.label}: ${c.parsed.y} registro(s)`}}},scales:{...base.scales,y:{...base.scales.y,beginAtZero:true,title:{display:true,text:'Contagem',color:'#93a3c0',font:{family:'DM Mono',size:10}}},x:{...base.scales.x,ticks:{...base.scales.x.ticks,maxTicksLimit:9,maxRotation:45,minRotation:0},title:{display:true,text:'Sample Entropy',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
  // Scatter and power-law fit: keep only positive m and SampEn on logarithmic axes.
  const classes=[...new Set(validPairs.map(x=>x.className||'Sem classe'))];
  const datasets=classes.map((cls,i)=>({label:cls,data:validPairs.filter(x=>(x.className||'Sem classe')===cls).map(x=>({x:x.modulation,y:x.sampen,source:x.source})),backgroundColor:ARTICLE_PALETTE[i%ARTICLE_PALETTE.length],borderColor:ARTICLE_PALETTE[i%ARTICLE_PALETTE.length],pointRadius:3.5,pointHoverRadius:5}));
  if(fit.slope!==null&&validPairs.length){
    const minM=validPairs.reduce((a,b)=>Math.min(a,b.modulation),Infinity),maxM=validPairs.reduce((a,b)=>Math.max(a,b.modulation),-Infinity);
    if(minM>0&&maxM>minM){datasets.push({label:`Ajuste log–log (expoente ${fit.slope.toFixed(3)})`,data:[{x:minM,y:Math.exp(fit.intercept+fit.slope*Math.log(minM))},{x:maxM,y:Math.exp(fit.intercept+fit.slope*Math.log(maxM))}],type:'line',showLine:true,pointRadius:0,borderColor:'#f1f4ff',borderDash:[6,5],borderWidth:1.5});}
  }
  makeArticleChart('articleSampenModulationScatter',{type:'scatter',data:{datasets},options:{...base,plugins:{...base.plugins,legend:{display:classes.length>1,labels:{color:'#9cabc7',font:{size:10}}},tooltip:{...base.plugins.tooltip,callbacks:{label:c=>{const p=c.raw;return `${p.source||c.dataset.label}: m=${p.x.toLocaleString('pt-BR',{maximumFractionDigits:4})}%; SampEn=${p.y.toLocaleString('pt-BR',{maximumFractionDigits:4})}`;}}}},scales:{x:{type:'logarithmic',grid:{color:'rgba(128,149,190,.08)'},ticks:{color:'#7787a5',font:{family:'DM Mono',size:9}},title:{display:true,text:'Índice de modulação intrínseco (%) · log',color:'#93a3c0',font:{family:'DM Mono',size:10}}},y:{type:'logarithmic',grid:{color:'rgba(128,149,190,.1)'},ticks:{color:'#7787a5',font:{family:'DM Mono',size:9}},title:{display:true,text:'Sample Entropy · log',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
  const bubblePairs=rows.filter(x=>Number.isFinite(x.sampen)&&x.sampen>0&&Number.isFinite(x.modulation)&&x.modulation>0&&Number.isFinite(x.bubbleSize)&&x.bubbleSize>0);
  if(bubblePairs.length>=2){
    const sizes=bubblePairs.map(x=>x.bubbleSize),minSize=Math.min(...sizes),maxSize=Math.max(...sizes);
    const bubbleClasses=[...new Set(bubblePairs.map(x=>x.className||'Sem classe'))];
    const bubbleSets=bubbleClasses.map((cls,i)=>({label:cls,data:bubblePairs.filter(x=>(x.className||'Sem classe')===cls).map(x=>({x:x.modulation,y:x.sampen,r:minSize===maxSize?7:4+10*Math.sqrt(Math.max(0,(x.bubbleSize-minSize)/(maxSize-minSize))),source:x.source,sizeValue:x.bubbleSize})),backgroundColor:ARTICLE_PALETTE[i%ARTICLE_PALETTE.length]+'99',borderColor:ARTICLE_PALETTE[i%ARTICLE_PALETTE.length],borderWidth:1}));
    makeArticleChart('articleSampenModulationBubble',{type:'bubble',data:{datasets:bubbleSets},options:{...base,plugins:{...base.plugins,legend:{display:bubbleClasses.length>1,position:'bottom',labels:{color:'#9cabc7',font:{size:9}}},tooltip:{...base.plugins.tooltip,callbacks:{label:c=>{const p=c.raw;return `${p.source||c.dataset.label}: m=${p.x.toLocaleString('pt-BR',{maximumFractionDigits:4})}%; SampEn=${p.y.toLocaleString('pt-BR',{maximumFractionDigits:4})}; tamanho=${p.sizeValue}`;}}}},scales:{x:{type:'logarithmic',grid:{color:'rgba(128,149,190,.08)'},ticks:{color:'#7787a5',font:{family:'DM Mono',size:9}},title:{display:true,text:'Índice de modulação intrínseco (%) · log',color:'#93a3c0',font:{family:'DM Mono',size:10}}},y:{type:'logarithmic',grid:{color:'rgba(128,149,190,.1)'},ticks:{color:'#7787a5',font:{family:'DM Mono',size:9}},title:{display:true,text:'Sample Entropy · log',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
    el('articleBubbleNote').textContent=`Bolhas geradas com ${bubblePairs.length} pares válidos. O raio representa a variável numérica selecionada (${el('articleBubbleSizeColumn').selectedIndex>0?el('articleBubbleSizeColumn').selectedOptions[0].text:'3ª variável'}); valores não positivos ou ausentes não entram na bolha.`;
  }else{
    const c=el('articleSampenModulationBubble');if(c){const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle='#8190ad';ctx.textAlign='center';ctx.font='12px sans-serif';ctx.fillText('Selecione uma 3ª variável positiva e importe m e SampEn positivos.',c.width/2,Math.max(25,c.height/2));}
    el('articleBubbleNote').textContent='A bolha requer SampEn, índice de modulação e uma terceira variável numérica positiva. Escolha o tamanho da bolha no mapeamento para habilitar este gráfico.';
  }

  const sampenGroups=summarizeByClass(rows,'sampen');
  renderArticleBars('articleSampenByClass',sampenGroups,'SampEn média ± DP');
  const modulationGroups=summarizeByClass(rows,'modulation');
  if(modulationGroups.length) renderArticleBars('articleModulationByClass',modulationGroups,'Índice de modulação médio (%) ± DP');
  else {
    // Empty state if no modulation column/data was provided.
    const c=el('articleModulationByClass'); if(c){const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle='#8190ad';ctx.textAlign='center';ctx.font='12px sans-serif';ctx.fillText('Importe o índice de modulação para gerar este gráfico.',c.width/2,Math.max(25,c.height/2));}
  }
  el('articleScatterNote').textContent=`Dispersão gerada de ${validPairs.length} pares com SampEn > 0 e índice de modulação > 0. Pearson = ${r==null?'indisponível':r.toFixed(4)}; Spearman = ${rho==null?'indisponível':rho.toFixed(4)}; expoente log–log = ${fit.slope==null?'indisponível':fit.slope.toFixed(4)} (N=${fit.n}). As estatísticas são calculadas a partir da tabela importada.`;
  state.articleDisplayRows=rows;state.articleTablePage=0;renderArticleTablePage();
  el('articleValidRowsLabel').textContent=`${rows.length.toLocaleString('pt-BR')} linhas válidas`;
  el('downloadArticleCleanBtn').disabled=false;
}
function renderPagedTable({rows,tableId,pageLabelId,prevButtonId,nextButtonId,page,size,renderRow,emptyColumns}){
  const tbody=el(tableId)?.querySelector('tbody');
  if(!tbody)return {page:0,pages:1};
  const selectId=tableId==='articleDataTable'?'articleRowsPerPage':'batchRowsPerPage';
  const select=el(selectId);
  const sizeValue=select?.value||String(size||100);
  const pageSize=sizeValue==='all'?Math.max(rows.length,1):Math.max(1,Number(sizeValue)||100);
  const pages=Math.max(1,Math.ceil(rows.length/pageSize));
  const currentPage=Math.min(Math.max(0,page||0),pages-1);
  const start=currentPage*pageSize,end=Math.min(rows.length,start+pageSize);
  tbody.innerHTML=rows.slice(start,end).map(renderRow).join('') || `<tr><td colspan="${emptyColumns}" class="empty-cell">Nenhum registro para mostrar.</td></tr>`;
  const label=el(pageLabelId);if(label)label.textContent=rows.length?`Linhas ${(start+1).toLocaleString('pt-BR')}–${end.toLocaleString('pt-BR')} de ${rows.length.toLocaleString('pt-BR')}`:'0 registros';
  const prev=el(prevButtonId),next=el(nextButtonId);if(prev)prev.disabled=currentPage<=0;if(next)next.disabled=currentPage>=pages-1;
  return {page:currentPage,pages,pageSize};
}
function renderArticleTablePage(){
  const rows=state.articleDisplayRows||[];
  const result=renderPagedTable({rows,tableId:'articleDataTable',pageLabelId:'articlePageLabel',prevButtonId:'articlePrevPage',nextButtonId:'articleNextPage',page:state.articleTablePage||0,renderRow:row=>`<tr><td>${escapeHtml(row.source)}</td><td>${escapeHtml(row.className)}</td><td>${Number.isFinite(row.sampen)?row.sampen.toLocaleString('pt-BR',{maximumFractionDigits:8}):'—'}</td><td>${Number.isFinite(row.modulation)?row.modulation.toLocaleString('pt-BR',{maximumFractionDigits:8}):'—'}</td></tr>`,emptyColumns:4});
  state.articleTablePage=result.page;
}
function renderBatchTablePage(){
  const rows=batchState.rows||[];
  const result=renderPagedTable({rows,tableId:'batchDataTable',pageLabelId:'batchPageLabel',prevButtonId:'batchPrevPage',nextButtonId:'batchNextPage',page:batchState.tablePage||0,renderRow:r=>`<tr><td>${escapeHtml(r.source)}</td><td>${Number.isFinite(r.window)?r.window:'—'}</td><td>${escapeHtml(r.band)}</td><td>${escapeHtml(r.className)}</td><td>${Number.isFinite(r.time)?r.time.toLocaleString('pt-BR',{maximumFractionDigits:8}):'—'}</td><td>${Number.isFinite(r.flux)?r.flux.toLocaleString('pt-BR',{maximumFractionDigits:8}):'—'}</td><td>${Number.isFinite(r.sampen)?r.sampen.toLocaleString('pt-BR',{maximumFractionDigits:8}):'—'}</td><td>${Number.isFinite(r.variability)?r.variability.toLocaleString('pt-BR',{maximumFractionDigits:8}):'—'}</td><td>${Number.isFinite(r.modulation)?r.modulation.toLocaleString('pt-BR',{maximumFractionDigits:8}):'—'}</td><td>${Number.isFinite(r.sizeValue)?r.sizeValue.toLocaleString('pt-BR',{maximumFractionDigits:8}):'—'}</td></tr>`,emptyColumns:10});
  batchState.tablePage=result.page;
}
function handleArticleFile(file){
  if(!file)return;
  file.text().then(text=>{
    const parsed=parseArticleCatalog(text,file.name);
    setupArticleMapping(parsed);
    el('articleDataStatus').textContent=`Arquivo lido: ${parsed.rows.length.toLocaleString('pt-BR')} linhas e ${parsed.header.length} colunas. Confira o mapeamento.`;
  }).catch(err=>{
    el('articleMappingPanel').classList.add('hidden');el('articleUploadEmpty').classList.remove('hidden');
    el('articleUploadEmpty').textContent=err.message||'Não foi possível ler esse catálogo.';
  });
}
function exportArticleCleanRows(){
  if(!state.articleCleanRows.length)return;
  const q=v=>{const s=v==null?'':String(v);return '"'+s.replace(/"/g,'""')+'"';};
  const lines=[['source','class','sampen','modulation_index_percent','bubble_size'].join(',')];
  for(const r of state.articleCleanRows) lines.push([r.source,r.className,Number.isFinite(r.sampen)?r.sampen:'',Number.isFinite(r.modulation)?r.modulation:'',Number.isFinite(r.bubbleSize)?r.bubbleSize:''].map(q).join(','));
  downloadTextFile(lines.join('\n'),'catalogo_sampen_modulacao_limpo.csv');
}
function setupArticleLab(){
  el('downloadArticleTemplateBtn')?.addEventListener('click',downloadArticleTemplate);
  el('articleDataFile')?.addEventListener('change',event=>handleArticleFile(event.target.files&&event.target.files[0]));
  el('analyzeArticleDataBtn')?.addEventListener('click',()=>{
    try{
      const rows=collectArticleRows();
      renderArticleResults(rows);
      el('articleDataStatus').textContent=`Gráficos gerados. ${rows.length.toLocaleString('pt-BR')} linhas com SampEn numérica; todos os cálculos permanecem no navegador.`;
      el('articleDynamicResults').scrollIntoView({behavior:'smooth',block:'start'});
    }catch(err){el('articleDataStatus').textContent=err.message||'Não foi possível gerar os gráficos.';el('articleDataStatus').classList.add('error');}
  });
  el('downloadArticleCleanBtn')?.addEventListener('click',exportArticleCleanRows);
  el('articleRowsPerPage')?.addEventListener('change',()=>{state.articleTablePage=0;renderArticleTablePage();});
  el('articlePrevPage')?.addEventListener('click',()=>{state.articleTablePage=Math.max(0,(state.articleTablePage||0)-1);renderArticleTablePage();});
  el('articleNextPage')?.addEventListener('click',()=>{state.articleTablePage=(state.articleTablePage||0)+1;renderArticleTablePage();});
  for(const id of ['articleSampenColumn','articleModulationColumn','articleClassColumn','articleSourceColumn','articleBubbleSizeColumn']) el(id)?.addEventListener('change',()=>{el('analyzeArticleDataBtn').disabled=!state.articleTable||el('articleSampenColumn').value==='-1';});
}
setupArticleLab();

// ==============================================================
// Multisource chart gallery: compatible with Python CSV exports.
// ==============================================================
const batchState = { table: null, rawRows: [], rows: [], charts: [], tablePage: 0, mapped: {source:false, className:false, window:false, band:false, variability:false, modulation:false, size:false} };
function destroyBatchCharts(){for(const c of batchState.charts){try{removeChartToolbar(c.canvas);c.destroy()}catch(_){}}batchState.charts=[];}
function setHeatmapZoom(factor){
  const wrap=el('batchHeatmap');if(!wrap)return;
  const current=Number(wrap.dataset.zoomScale||1);
  const next=Math.max(0.6,Math.min(2.5,current*factor));
  wrap.dataset.zoomScale=String(next);wrap.style.setProperty('--heatmap-scale',String(next));
  const label=el('batchHeatmapZoomValue');if(label)label.textContent=`${Math.round(next*100)}%`;
}

function makeBatchChart(id, config){const canvas=el(id);if(!canvas)return null;try{if(window.Chart&&typeof window.Chart.getChart==='function'){const prior=window.Chart.getChart(canvas);if(prior){removeChartToolbar(prior.canvas);prior.destroy();batchState.charts=batchState.charts.filter(chart=>chart!==prior);}}}catch(_){}const c=new Chart(canvas.getContext('2d'),config);batchState.charts.push(c);installChartToolbar(c);return c;}
function clearCanvasMessage(id, text){const canvas=el(id);if(!canvas)return;removeChartToolbar(canvas);const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#8190ad';ctx.textAlign='center';ctx.font='12px sans-serif';ctx.fillText(text,canvas.width/2,Math.max(24,canvas.height/2));}
function downloadBatchTemplate(){
  const template='fonte,janela,banda,tempo,fluxo,sampen,classe_fonte,variabilidade_robusta,modulation_index_percent,n_pontos,snr_media\n';
  downloadTextFile(template,'modelo_resultados_python_multifonte.csv');
}
function setupBatchMapping(parsed){
  batchState.table=parsed;batchState.rawRows=parsed.rows;
  const headers=parsed.header;
  populateArticleSelect('batchSourceColumn',headers,true,findArticleColumn(headers,[/^fonte$/, /^source$/, /object name/, /^object$/, /^target$/, /^name$/]));
  populateArticleSelect('batchClassColumn',headers,true,findArticleColumn(headers,[/classe fonte/, /classe_fonte/, /^class$/, /^classe$/, /optical class/, /classification/, /^tipo$/]));
  populateArticleSelect('batchWindowColumn',headers,true,findArticleColumn(headers,[/^janela$/, /^window$/, /window index/, /indice temporal/, /segmento/]));
  populateArticleSelect('batchBandColumn',headers,true,findArticleColumn(headers,[/^banda$/, /^band$/, /energy band/]));
  populateArticleSelect('batchTimeColumn',headers,true,findArticleColumn(headers,[/^tempo$/, /^time$/, /^mjd$/, /timestamp/, /^date$/]));
  populateArticleSelect('batchFluxColumn',headers,true,findArticleColumn(headers,[/^fluxo$/, /^flux$/, /^rate$/, /^taxa$/, /flux value/, /count per second/]));
  populateArticleSelect('batchSampenColumn',headers,true,findArticleColumn(headers,[/^sampen$/, /sample entropy/, /^hse$/, /^h se$/, /^entropy$/]));
  populateArticleSelect('batchVariabilityColumn',headers,true,findArticleColumn(headers,[/variabilidade robusta/, /variabilidade_robusta/, /robust variability/, /^variability$/, /variabilidade/]));
  populateArticleSelect('batchModulationColumn',headers,true,findArticleColumn(headers,[/modulation index/, /intrinsic modulation/, /modulation percent/, /modulation_index_percent/, /indice de modulacao/, /índice de modulação/, /^mi$/, /^m pct$/]));
  populateArticleSelect('batchBubbleSizeColumn',headers,true,findArticleColumn(headers,[/^n pontos$/, /^n validos$/, /n points/, /epochs/, /signal.to.noise/, /^snr/, /exposure/, /numero de pontos/, /number of observations/]));
  el('batchFileLabel').textContent=`${parsed.filename} · ${parsed.rows.length.toLocaleString('pt-BR')} linhas`;
  el('batchMappingPanel').classList.remove('hidden');el('batchUploadEmpty').classList.add('hidden');
  el('buildBatchGalleryBtn').disabled=(el('batchSampenColumn').value==='-1'&&!(el('batchTimeColumn').value!=='-1'&&el('batchFluxColumn').value!=='-1'));
  el('batchDataStatus').textContent='Confira o mapeamento. Para resultados, selecione SampEn; para curvas brutas, selecione tempo e fluxo/RATE. Fonte e banda habilitam a comparação de curvas entre objetos.';
}
function collectBatchRows(){
  if(!batchState.table)throw new Error('Carregue primeiro um CSV/TSV de resultados Python.');
  const ix={source:Number(el('batchSourceColumn').value),cls:Number(el('batchClassColumn').value),window:Number(el('batchWindowColumn').value),band:Number(el('batchBandColumn').value),time:Number(el('batchTimeColumn').value),flux:Number(el('batchFluxColumn').value),sampen:Number(el('batchSampenColumn').value),variability:Number(el('batchVariabilityColumn').value),modulation:Number(el('batchModulationColumn').value),size:Number(el('batchBubbleSizeColumn').value)};
  batchState.mapped={source:ix.source>=0,className:ix.cls>=0,window:ix.window>=0,band:ix.band>=0,time:ix.time>=0,flux:ix.flux>=0,sampen:ix.sampen>=0,variability:ix.variability>=0,modulation:ix.modulation>=0,size:ix.size>=0};
  const rawCurveMapped=ix.time>=0&&ix.flux>=0;
  if(ix.sampen<0&&!rawCurveMapped)throw new Error('Mapeie Sample Entropy ou, para curvas brutas, mapeie tempo e fluxo/RATE.');
  const rows=batchState.rawRows.map((row,i)=>({
    source:ix.source>=0?(row[ix.source]||`Registro ${i+1}`):`Registro ${i+1}`,
    className:ix.cls>=0?(row[ix.cls]||'Sem classe'):'Sem classe',
    window:ix.window>=0?articleNumber(row[ix.window],batchState.table.delimiter):null,
    band:ix.band>=0?(row[ix.band]||'Sem banda'):'Sem banda',
    time:ix.time>=0?articleNumber(row[ix.time],batchState.table.delimiter):null,
    flux:ix.flux>=0?articleNumber(row[ix.flux],batchState.table.delimiter):null,
    sampen:ix.sampen>=0?articleNumber(row[ix.sampen],batchState.table.delimiter):null,
    variability:ix.variability>=0?articleNumber(row[ix.variability],batchState.table.delimiter):null,
    modulation:ix.modulation>=0?articleNumber(row[ix.modulation],batchState.table.delimiter):null,
    sizeValue:ix.size>=0?articleNumber(row[ix.size],batchState.table.delimiter):null,
    rowNumber:i+2
  })).filter(r=>Number.isFinite(r.sampen)||(Number.isFinite(r.time)&&Number.isFinite(r.flux)));
  if(!rows.length)throw new Error('Não encontrei valores válidos de SampEn nem pares tempo/fluxo. Confira o mapeamento.');
  batchState.rows=rows;batchState.tablePage=0;
  return rows;
}
function batchGroupMean(rows, keys, valueKey='sampen'){
  const map=new Map();
  for(const r of rows){if(!Number.isFinite(r[valueKey]))continue;const key=keys.map(k=>String(r[k]??'')).join('\u001f');if(!map.has(key))map.set(key,{...Object.fromEntries(keys.map(k=>[k,r[k]])),className:r.className,values:[]});map.get(key).values.push(r[valueKey]);}
  return [...map.values()].map(g=>({...g,mean:mean(g.values),sd:stdSample(g.values),n:g.values.length}));
}
function batchDistributionRows(rows){
  if(el('batchDistributionMode').value==='records'||!batchState.mapped.source)return rows.filter(r=>Number.isFinite(r.sampen));
  return batchGroupMean(rows,['source'],'sampen').map(g=>({source:g.source,className:g.className||'Sem classe',sampen:g.mean,n:g.n}));
}
function batchBuildBins(values){
  const vals=values.filter(Number.isFinite);if(!vals.length)return [];
  let lo=Math.min(...vals),hi=Math.max(...vals);const n=Math.min(30,Math.max(6,Math.ceil(Math.sqrt(vals.length))));if(lo===hi){lo-=0.5;hi+=0.5;}
  const w=(hi-lo)/n;const bins=Array.from({length:n},(_,i)=>({low:lo+i*w,high:i===n-1?hi:lo+(i+1)*w,count:0}));
  vals.forEach(v=>{let i=Math.floor((v-lo)/w);i=Math.max(0,Math.min(n-1,i));bins[i].count++;});return bins;
}
function batchCorrelation(rows, xKey, yKey){
  const pairs=rows.filter(r=>Number.isFinite(r[xKey])&&Number.isFinite(r[yKey]));if(pairs.length<3)return {pearson:null,spearman:null,n:pairs.length};
  const xs=pairs.map(r=>r[xKey]),ys=pairs.map(r=>r[yKey]);
  const pearson=(a,b)=>{const ma=mean(a),mb=mean(b);let num=0,da=0,db=0;for(let i=0;i<a.length;i++){num+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2;}return da>0&&db>0?num/Math.sqrt(da*db):null;};
  const rank=a=>{const s=a.map((v,i)=>({v,i})).sort((p,q)=>p.v-q.v),out=Array(a.length);let i=0;while(i<s.length){let j=i+1;while(j<s.length&&s[j].v===s[i].v)j++;const av=(i+1+j)/2;for(let k=i;k<j;k++)out[s[k].i]=av;i=j;}return out;};
  return {pearson:pearson(xs,ys),spearman:pearson(rank(xs),rank(ys)),n:pairs.length};
}
function batchColor(i,alpha='cc'){return (ARTICLE_PALETTE[i%ARTICLE_PALETTE.length]||'#8a8dff')+alpha;}
function renderRawSourceOverlay(rows){
  const hasRaw=batchState.mapped.source&&batchState.mapped.band&&batchState.mapped.time&&batchState.mapped.flux;
  if(!hasRaw){clearCanvasMessage('batchLightcurveSourceOverlay','Mapeie fonte, banda, tempo e fluxo/RATE');el('batchRawOverlayNote').textContent='Este gráfico precisa de uma tabela ponto a ponto com colunas reais de fonte, banda, tempo e fluxo/RATE. Uma tabela de resultados de SampEn por janela não contém necessariamente as curvas brutas.';return;}
  const canvas=el('batchLightcurveSourceOverlay');const chosenBand=el('batchRawBand').value, sourceA=el('batchRawSourceA').value, sourceB=el('batchRawSourceB').value;
  if(!chosenBand||!sourceA){clearCanvasMessage('batchLightcurveSourceOverlay','Selecione a banda e a fonte A');el('batchRawOverlayNote').textContent='Escolha uma banda e pelo menos uma fonte para desenhar a curva.';return;}
  const selected=[sourceA,...(sourceB&&sourceB!==sourceA?[sourceB]:[])];
  const colors=['#8a8dff','#5cdec2'];
  const datasets=selected.map((source,i)=>({label:source,data:rows.filter(r=>r.source===source&&r.band===chosenBand&&Number.isFinite(r.time)&&Number.isFinite(r.flux)).map(r=>({x:r.time,y:r.flux})).sort((a,b)=>a.x-b.x),borderColor:colors[i%colors.length],backgroundColor:colors[i%colors.length]+'22',borderWidth:1.4,pointRadius:0,pointHoverRadius:3,tension:0,spanGaps:false})).filter(d=>d.data.length);
  if(!datasets.length){clearCanvasMessage('batchLightcurveSourceOverlay','Nenhum par tempo/fluxo válido nessa seleção');el('batchRawOverlayNote').textContent='A seleção não tem pontos válidos para plotar.';return;}
  makeBatchChart('batchLightcurveSourceOverlay',{type:'line',data:{datasets},options:{...chartDefaults(),parsing:false,interaction:{mode:'nearest',intersect:false},plugins:{...chartDefaults().plugins,legend:{display:true,position:'bottom',labels:{color:'#9cabc7',font:{size:9},boxWidth:8}},tooltip:{...chartDefaults().plugins.tooltip,callbacks:{label:c=>`${c.dataset.label}: ${c.parsed.y.toLocaleString('pt-BR',{maximumFractionDigits:7})}`}}},scales:{...chartDefaults().scales,x:{...chartDefaults().scales.x,type:'linear',title:{display:true,text:'Tempo (unidade da tabela importada)',color:'#93a3c0',font:{family:'DM Mono',size:10}}},y:{...chartDefaults().scales.y,title:{display:true,text:'Fluxo / RATE (unidade da tabela importada)',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
  el('batchRawOverlayNote').textContent=`Banda ${chosenBand}: ${datasets.map(d=>`${d.label} (${d.data.length} pontos)`).join(' · ')}. As duas curvas mantêm as unidades originais; confirme se tempo, taxa e instrumentos são comparáveis antes de interpretar diferenças.`;
}
function populateRawOverlayControls(rows){
  const bandSel=el('batchRawBand'), aSel=el('batchRawSourceA'), bSel=el('batchRawSourceB');
  const oldBand=bandSel.value,oldA=aSel.value,oldB=bSel.value;
  const ready=batchState.mapped.source&&batchState.mapped.band&&batchState.mapped.time&&batchState.mapped.flux;
  const sources=ready?[...new Set(rows.filter(r=>Number.isFinite(r.time)&&Number.isFinite(r.flux)).map(r=>r.source))].sort((a,b)=>a.localeCompare(b)):[];
  const bands=ready?[...new Set(rows.filter(r=>Number.isFinite(r.time)&&Number.isFinite(r.flux)).map(r=>r.band))].sort((a,b)=>{const na=Number(String(a).match(/\d+/)?.[0]),nb=Number(String(b).match(/\d+/)?.[0]);return Number.isFinite(na)&&Number.isFinite(nb)?na-nb:String(a).localeCompare(String(b));}):[];
  bandSel.innerHTML='';const bo=document.createElement('option');bo.value='';bo.textContent=ready?'Selecione a banda':'Mapeie os campos';bandSel.appendChild(bo);bands.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;bandSel.appendChild(o);});
  aSel.innerHTML='';const ao=document.createElement('option');ao.value='';ao.textContent=ready?'Selecione a fonte':'Mapeie os campos';aSel.appendChild(ao);sources.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;aSel.appendChild(o);});
  bSel.innerHTML='';const none=document.createElement('option');none.value='';none.textContent='Não sobrepor segunda fonte';bSel.appendChild(none);sources.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;bSel.appendChild(o);});
  if(bands.includes(oldBand))bandSel.value=oldBand;else if(bands.length)bandSel.value=bands[0];
  if(sources.includes(oldA))aSel.value=oldA;else if(sources.length)aSel.value=sources[0];
  if(sources.includes(oldB)&&oldB!==aSel.value)bSel.value=oldB;else if(sources.length>1)bSel.value=sources[1];
  if(!ready)el('batchRawOverlayNote').textContent='Para sobrepor curvas brutas, mapeie fonte, banda, tempo e fluxo/RATE no arquivo importado.';
}

function renderBatchGallery(rows){
  destroyBatchCharts();
  el('batchGalleryResults').classList.remove('hidden');
  const sources=batchState.mapped.source?[...new Set(rows.map(r=>r.source))].sort((a,b)=>a.localeCompare(b)):[];
  const bands=[...new Set(rows.map(r=>r.band))].sort((a,b)=>{
    const na=Number(String(a).match(/\d+/)?.[0]),nb=Number(String(b).match(/\d+/)?.[0]);return Number.isFinite(na)&&Number.isFinite(nb)?na-nb:String(a).localeCompare(String(b));
  });
  const validVar=rows.filter(r=>Number.isFinite(r.variability)&&Number.isFinite(r.sampen));
  const validMod=rows.filter(r=>Number.isFinite(r.modulation)&&Number.isFinite(r.sampen)&&r.modulation>0&&r.sampen>0);
  const dist=batchDistributionRows(rows);
  el('batchMetricRows').textContent=rows.length.toLocaleString('pt-BR');
  el('batchMetricSources').textContent=batchState.mapped.source?sources.length.toLocaleString('pt-BR'):'—';
  el('batchMetricBands').textContent=batchState.mapped.band?bands.length.toLocaleString('pt-BR'):'—';
  el('batchMetricPairs').textContent=validVar.length.toLocaleString('pt-BR');
  if(el('batchDistributionMode').value==='source'&&!batchState.mapped.source)el('batchDataStatus').textContent='Aviso: não há coluna fonte mapeada; o histograma usará cada registro, sem agregação por objeto.';
  const timeSource=el('batchTemporalSource');const oldSource=timeSource.value;timeSource.innerHTML='';
  const optAll=document.createElement('option');optAll.value='';optAll.textContent=batchState.mapped.source?'Selecione uma fonte':'Mapeie uma coluna de fonte';timeSource.appendChild(optAll);
  sources.forEach(s=>{const o=document.createElement('option');o.value=s;o.textContent=s;timeSource.appendChild(o);});
  if(sources.includes(oldSource))timeSource.value=oldSource;else if(sources.length===1)timeSource.value=sources[0];
  const base=chartDefaults();
  // Global histogram over selected statistical unit.
  const bins=batchBuildBins(dist.map(r=>r.sampen));
  if(bins.length){
    makeBatchChart('batchGlobalHistogram',{type:'bar',data:{labels:bins.map(b=>`${b.low.toFixed(2)}–${b.high.toFixed(2)}`),datasets:[{label:'Registros',data:bins.map(b=>b.count),backgroundColor:'#8a8dffbb',borderColor:'#8a8dff',borderWidth:1,borderRadius:2}]},options:{...base,plugins:{...base.plugins,legend:{display:false},tooltip:{...base.plugins.tooltip,callbacks:{label:c=>`${c.parsed.y} registro(s)`}}},scales:{...base.scales,y:{...base.scales.y,beginAtZero:true,title:{display:true,text:'Contagem',color:'#93a3c0',font:{family:'DM Mono',size:10}}},x:{...base.scales.x,ticks:{...base.scales.x.ticks,maxTicksLimit:8,maxRotation:45,minRotation:0},title:{display:true,text:'Sample Entropy',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
  }else clearCanvasMessage('batchGlobalHistogram','Sem valores de SampEn');
  // Overlay histograms by class with common bins.
  const clsNames=[...new Set(dist.map(r=>r.className||'Sem classe'))];
  if(bins.length&&clsNames.length){
    const sets=clsNames.slice(0,8).map((cls,i)=>{const counts=Array(bins.length).fill(0);dist.filter(r=>(r.className||'Sem classe')===cls&&Number.isFinite(r.sampen)).forEach(r=>{let k=Math.floor((r.sampen-bins[0].low)/(bins[0].high-bins[0].low));k=Math.max(0,Math.min(bins.length-1,k));counts[k]++;});return {label:cls,data:counts,backgroundColor:batchColor(i,'55'),borderColor:ARTICLE_PALETTE[i%ARTICLE_PALETTE.length],borderWidth:1,grouped:false,barPercentage:1,categoryPercentage:0.92};});
    makeBatchChart('batchClassHistogram',{type:'bar',data:{labels:bins.map(b=>`${b.low.toFixed(2)}–${b.high.toFixed(2)}`),datasets:sets},options:{...base,plugins:{...base.plugins,legend:{display:clsNames.length>1,position:'bottom',labels:{color:'#9cabc7',font:{size:9},boxWidth:8}},tooltip:{...base.plugins.tooltip,callbacks:{label:c=>`${c.dataset.label}: ${c.parsed.y} registro(s)`}}},scales:{...base.scales,y:{...base.scales.y,beginAtZero:true,title:{display:true,text:'Contagem',color:'#93a3c0',font:{family:'DM Mono',size:10}}},x:{...base.scales.x,ticks:{...base.scales.x.ticks,maxTicksLimit:8,maxRotation:45,minRotation:0},title:{display:true,text:'Sample Entropy',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
  }else clearCanvasMessage('batchClassHistogram','Não há classes ou SampEn para sobrepor');
  // Equal-source band profile: each source-band gets one mean first.
  const sourceBandMeans=(batchState.mapped.source&&batchState.mapped.band)?batchGroupMean(rows.filter(r=>r.band!=='Sem banda'),['source','band']):[];
  const profile=bands.filter(b=>b!=='Sem banda').map(b=>{const arr=sourceBandMeans.filter(r=>r.band===b).map(r=>r.mean);return {band:b,n:arr.length,mean:mean(arr),sd:stdSample(arr)};}).filter(r=>Number.isFinite(r.mean));
  if(profile.length){
    makeBatchChart('batchBandProfile',{type:'bar',plugins:[ARTICLE_ERROR_BARS],data:{labels:profile.map(p=>`${p.band} · n=${p.n}`),datasets:[{label:'Média entre fontes',data:profile.map(p=>p.mean),backgroundColor:profile.map((_,i)=>batchColor(i)),borderColor:profile.map((_,i)=>ARTICLE_PALETTE[i%ARTICLE_PALETTE.length]),borderWidth:1,borderRadius:3}]},options:{...base,plugins:{...base.plugins,legend:{display:false},articleErrorBars:{errors:profile.map(p=>p.sd),color:'#e4eaff'},tooltip:{...base.plugins.tooltip,callbacks:{label:c=>{const p=profile[c.dataIndex];return [`Média: ${p.mean.toFixed(4)}`,`DP entre fontes: ${p.sd.toFixed(4)}`,`Fontes: ${p.n}`];}}}},scales:{...base.scales,y:{...base.scales.y,beginAtZero:true,title:{display:true,text:'SampEn média',color:'#93a3c0',font:{family:'DM Mono',size:10}}},x:{...base.scales.x,ticks:{...base.scales.x.ticks,maxRotation:0}}}}});
  }else clearCanvasMessage('batchBandProfile','Mapeie fonte e banda para criar o perfil');
  // Source ranking: first average by source and band, then equally weight bands.
  const bySourceBand=batchGroupMean(rows.filter(r=>r.band!=='Sem banda'),['source','band']);
  const bySourceMap=new Map();
  if(batchState.mapped.source&&bySourceBand.length){for(const x of bySourceBand){if(!bySourceMap.has(x.source))bySourceMap.set(x.source,[]);bySourceMap.get(x.source).push(x.mean);}}
  else if(batchState.mapped.source){for(const x of batchGroupMean(rows,['source'])){if(!bySourceMap.has(x.source))bySourceMap.set(x.source,[]);bySourceMap.get(x.source).push(x.mean);}}
  const ranking=[...bySourceMap.entries()].map(([source,values])=>({source,mean:mean(values)})).filter(x=>Number.isFinite(x.mean)).sort((a,b)=>a.mean-b.mean);
  if(batchState.mapped.source&&ranking.length){makeBatchChart('batchSourceRanking',{type:'bar',data:{labels:ranking.map(x=>x.source),datasets:[{label:'SampEn média',data:ranking.map(x=>x.mean),backgroundColor:ranking.map((_,i)=>batchColor(i)),borderColor:ranking.map((_,i)=>ARTICLE_PALETTE[i%ARTICLE_PALETTE.length]),borderWidth:1,borderRadius:3}]},options:{...base,indexAxis:'y',plugins:{...base.plugins,legend:{display:false},tooltip:{...base.plugins.tooltip,callbacks:{label:c=>`SampEn média: ${c.parsed.x.toFixed(4)}`}}},scales:{x:{...base.scales.x,beginAtZero:true,title:{display:true,text:'SampEn média com peso igual por fonte/banda',color:'#93a3c0',font:{family:'DM Mono',size:10}}},y:{...base.scales.y,ticks:{...base.scales.y.ticks,font:{size:8}}}}}});}else clearCanvasMessage('batchSourceRanking','Mapeie a coluna fonte');
  // Heatmap source × band, cells show mean over windows.
  const heatEl=el('batchHeatmap');heatEl.innerHTML='';
  const heatValues=sourceBandMeans.map(r=>r.mean).filter(Number.isFinite);const hmin=heatValues.length?Math.min(...heatValues):0,hmax=heatValues.length?Math.max(...heatValues):1;
  el('batchHeatmapRange').textContent=heatValues.length?`${hmin.toFixed(3)} — ${hmax.toFixed(3)}`:'Sem dados';
  if(batchState.mapped.source&&batchState.mapped.band&&sourceBandMeans.length&&sources.length&&bands.length){
    const table=document.createElement('table');table.className='batch-heatmap-table';
    const thead=document.createElement('thead'),headRow=document.createElement('tr');const first=document.createElement('th');first.textContent='Fonte';headRow.appendChild(first);
    bands.filter(b=>b!=='Sem banda').forEach(b=>{const th=document.createElement('th');th.textContent=b;headRow.appendChild(th);});thead.appendChild(headRow);table.appendChild(thead);
    const tbody=document.createElement('tbody');
    sources.forEach(source=>{const tr=document.createElement('tr');const th=document.createElement('th');th.textContent=source;tr.appendChild(th);bands.filter(b=>b!=='Sem banda').forEach(b=>{const td=document.createElement('td');const cell=sourceBandMeans.find(r=>r.source===source&&r.band===b);if(cell){const t=hmax===hmin?0.5:(cell.mean-hmin)/(hmax-hmin);td.style.backgroundColor=`rgba(92,222,194,${0.10+0.68*t})`;td.style.color=t>.52?'#071a20':'#e9efff';td.textContent=cell.mean.toFixed(3);td.title=`${source} · ${b}: média ${cell.mean.toFixed(6)}; N=${cell.n}`;}else{td.textContent='—';td.className='heatmap-missing';td.title='Sem valor disponível';}tr.appendChild(td);});tbody.appendChild(tr);});table.appendChild(tbody);heatEl.appendChild(table);
  }else{heatEl.textContent='Mapeie colunas reais de fonte e banda para gerar o heatmap. A galeria não inventa identificadores para reconstruir uma matriz.';}
  // Scatter SampEn × robust variability.
  const varClasses=[...new Set(validVar.map(r=>r.className||'Sem classe'))];
  if(validVar.length&&Number(el('batchVariabilityColumn').value)>=0){
    const sets=varClasses.map((cls,i)=>({label:cls,data:validVar.filter(r=>(r.className||'Sem classe')===cls).map(r=>({x:r.variability,y:r.sampen,source:r.source,window:r.window,band:r.band})),backgroundColor:batchColor(i,'bb'),borderColor:ARTICLE_PALETTE[i%ARTICLE_PALETTE.length],pointRadius:3.5,pointHoverRadius:5}));
    makeBatchChart('batchSampenVariability',{type:'scatter',data:{datasets:sets},options:{...base,plugins:{...base.plugins,legend:{display:varClasses.length>1,position:'bottom',labels:{color:'#9cabc7',font:{size:9}}},tooltip:{...base.plugins.tooltip,callbacks:{label:c=>{const p=c.raw;return `${p.source}${p.band?` · ${p.band}`:''}${Number.isFinite(p.window)?` · janela ${p.window}`:''}: variabilidade=${p.x.toPrecision(5)}; SampEn=${p.y.toFixed(4)}`;}}}},scales:{...base.scales,x:{...base.scales.x,title:{display:true,text:'Variabilidade robusta (unidade do CSV)',color:'#93a3c0',font:{family:'DM Mono',size:10}}},y:{...base.scales.y,title:{display:true,text:'Sample Entropy',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
    const cr=batchCorrelation(validVar,'variability','sampen');el('batchVariabilityNote').textContent=`N=${validVar.length} pares. Pearson=${cr.pearson==null?'indisponível':cr.pearson.toFixed(4)}; Spearman=${cr.spearman==null?'indisponível':cr.spearman.toFixed(4)}. Se houver várias janelas por fonte, correlações sobre registros não constituem amostras independentes.`;
  }else{clearCanvasMessage('batchSampenVariability','Importe e mapeie a variabilidade robusta');el('batchVariabilityNote').textContent='A coluna de variabilidade robusta não está mapeada ou não tem valores finitos.';}
  // Scatter SampEn × intrinsic modulation: only true modulation column, no proxy substitution.
  if(validMod.length&&Number(el('batchModulationColumn').value)>=0){
    const mods=[...new Set(validMod.map(r=>r.className||'Sem classe'))];const sets=mods.map((cls,i)=>({label:cls,data:validMod.filter(r=>(r.className||'Sem classe')===cls).map(r=>({x:r.modulation,y:r.sampen,source:r.source,window:r.window,band:r.band})),backgroundColor:batchColor(i,'bb'),borderColor:ARTICLE_PALETTE[i%ARTICLE_PALETTE.length],pointRadius:3.5,pointHoverRadius:5}));
    makeBatchChart('batchSampenModulation',{type:'scatter',data:{datasets:sets},options:{...base,plugins:{...base.plugins,legend:{display:mods.length>1,position:'bottom',labels:{color:'#9cabc7',font:{size:9}}}},scales:{x:{type:'logarithmic',grid:{color:'rgba(128,149,190,.08)'},ticks:{color:'#7787a5',font:{family:'DM Mono',size:9}},title:{display:true,text:'Índice de modulação (%) · log',color:'#93a3c0',font:{family:'DM Mono',size:10}}},y:{type:'logarithmic',grid:{color:'rgba(128,149,190,.08)'},ticks:{color:'#7787a5',font:{family:'DM Mono',size:9}},title:{display:true,text:'Sample Entropy · log',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
    el('batchModulationNote').textContent=`${validMod.length} pares com SampEn e modulação positivos. A escala logarítmica exclui valores não positivos e a coluna de modulação é distinta do parâmetro mSE.`;
  }else{clearCanvasMessage('batchSampenModulation','Importe uma coluna de modulação intrínseca');el('batchModulationNote').textContent='Não há uma coluna de índice de modulação mapeada com valores positivos; este gráfico não é estimado a partir da SampEn.';}
  // Bubble: variability X, SampEn Y, selected third numeric field encodes radius.
  const bubbleIdx=Number(el('batchBubbleSizeColumn').value);
  const bubbleRows=rows.filter(r=>Number.isFinite(r.variability)&&Number.isFinite(r.sampen)&&Number.isFinite(r.sizeValue)&&r.sizeValue>0);
  if(bubbleRows.length>=2&&Number(el('batchVariabilityColumn').value)>=0&&bubbleIdx>=0){
    const sizes=bubbleRows.map(r=>r.sizeValue),minS=Math.min(...sizes),maxS=Math.max(...sizes),classes=[...new Set(bubbleRows.map(r=>r.className||'Sem classe'))];
    const sets=classes.map((cls,i)=>({label:cls,data:bubbleRows.filter(r=>(r.className||'Sem classe')===cls).map(r=>({x:r.variability,y:r.sampen,r:minS===maxS?7:4+11*Math.sqrt(Math.max(0,(r.sizeValue-minS)/(maxS-minS))),source:r.source,band:r.band,window:r.window,sizeValue:r.sizeValue})),backgroundColor:batchColor(i,'88'),borderColor:ARTICLE_PALETTE[i%ARTICLE_PALETTE.length],borderWidth:1}));
    makeBatchChart('batchBubblePlot',{type:'bubble',data:{datasets:sets},options:{...base,plugins:{...base.plugins,legend:{display:classes.length>1,position:'bottom',labels:{color:'#9cabc7',font:{size:9}}},tooltip:{...base.plugins.tooltip,callbacks:{label:c=>{const p=c.raw;return `${p.source}${p.band?` · ${p.band}`:''}: variabilidade=${p.x.toPrecision(5)}; SampEn=${p.y.toFixed(4)}; tamanho=${p.sizeValue}`;}}}},scales:{...base.scales,x:{...base.scales.x,title:{display:true,text:'Variabilidade robusta (unidade do CSV)',color:'#93a3c0',font:{family:'DM Mono',size:10}}},y:{...base.scales.y,title:{display:true,text:'Sample Entropy',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
    el('batchBubbleNote').textContent=`${bubbleRows.length} bolhas. O raio representa a coluna “${el('batchBubbleSizeColumn').selectedOptions[0]?.text||'terceira variável'}”; apenas valores positivos da variável de tamanho são representados.`;
  }else{clearCanvasMessage('batchBubblePlot','Precisa de variabilidade, SampEn e uma 3ª variável positiva');el('batchBubbleNote').textContent='Mapeie uma coluna numérica de variabilidade e outra de tamanho (por exemplo, número de pontos válidos ou S/N apropriado). O site não fabrica a terceira dimensão.';}
  // Temporal overlay for selected source and each band.
  renderBatchTemporal(rows);
  // Audit table and download button.
  el('batchValidRowsLabel').textContent=`${rows.length.toLocaleString('pt-BR')} linhas válidas`;
  renderBatchTablePage();
  el('downloadBatchCleanBtn').disabled=false;
  populateRawOverlayControls(rows);
  renderRawSourceOverlay(rows);
}
function renderBatchTemporal(rows){
  const source=el('batchTemporalSource').value;const canvas=el('batchTemporalOverlay');
  if(!batchState.mapped.source||!batchState.mapped.window||!batchState.mapped.band){clearCanvasMessage('batchTemporalOverlay','Mapeie fonte, janela e banda');el('batchTemporalNote').textContent='A evolução temporal exige colunas reais de fonte, janela e banda.';return;}
  if(!source){clearCanvasMessage('batchTemporalOverlay','Escolha uma fonte para sobrepor as bandas');el('batchTemporalNote').textContent='Mapeie fonte, janela e banda; depois escolha a fonte no menu.';return;}
  const chosen=rows.filter(r=>r.source===source&&Number.isFinite(r.window)&&r.band!=='Sem banda');
  const bands=[...new Set(chosen.map(r=>r.band))];
  if(!chosen.length||!bands.length){clearCanvasMessage('batchTemporalOverlay','Esta fonte não tem janela/banda utilizável');return;}
  const grouped=batchGroupMean(chosen,['band','window']);
  const datasets=bands.map((band,i)=>({label:band,data:grouped.filter(r=>r.band===band).sort((a,b)=>a.window-b.window).map(r=>({x:r.window,y:r.mean})),borderColor:ARTICLE_PALETTE[i%ARTICLE_PALETTE.length],backgroundColor:batchColor(i,'22'),borderWidth:1.5,pointRadius:2,pointHoverRadius:4,tension:0,spanGaps:false}));
  makeBatchChart('batchTemporalOverlay',{type:'line',data:{datasets},options:{...chartDefaults(),parsing:false,interaction:{mode:'nearest',intersect:false},plugins:{...chartDefaults().plugins,legend:{display:true,position:'bottom',labels:{color:'#9cabc7',font:{size:9},boxWidth:8}}},scales:{...chartDefaults().scales,x:{...chartDefaults().scales.x,type:'linear',title:{display:true,text:'Janela (índice importado)',color:'#93a3c0',font:{family:'DM Mono',size:10}}},y:{...chartDefaults().scales.y,beginAtZero:true,title:{display:true,text:'Sample Entropy',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
  el('batchTemporalNote').textContent=`${source}: ${chosen.length} registros selecionados; ${bands.length} bandas sobrepostas. Valores ausentes não são substituídos por zero.`;
}
function exportBatchRows(){
  if(!batchState.rows.length)return;const quote=v=>{const s=v==null?'':String(v);return '"'+s.replace(/"/g,'""')+'"';};
  const header=['fonte','classe','janela','banda','tempo','fluxo','sampen','variabilidade_robusta','modulation_index_percent','bubble_size'];
  const lines=[header.join(',')];for(const r of batchState.rows)lines.push([r.source,r.className,Number.isFinite(r.window)?r.window:'',r.band,Number.isFinite(r.time)?r.time:'',Number.isFinite(r.flux)?r.flux:'',Number.isFinite(r.sampen)?r.sampen:'',Number.isFinite(r.variability)?r.variability:'',Number.isFinite(r.modulation)?r.modulation:'',Number.isFinite(r.sizeValue)?r.sizeValue:''].map(quote).join(','));
  downloadTextFile(lines.join('\n'),'resultados_multifonte_limpos.csv');
}
function handleBatchFile(file){if(!file)return;file.text().then(text=>{const parsed=parseArticleCatalog(text,file.name);setupBatchMapping(parsed);el('batchDataStatus').textContent=`Arquivo lido: ${parsed.rows.length.toLocaleString('pt-BR')} linhas e ${parsed.header.length} colunas. Confira o mapeamento.`;}).catch(err=>{el('batchMappingPanel').classList.add('hidden');el('batchUploadEmpty').classList.remove('hidden');el('batchUploadEmpty').textContent=err.message||'Não foi possível ler a tabela multifonte.';});}
function setupBatchGallery(){
  el('batchHeatmapZoomIn')?.addEventListener('click',()=>setHeatmapZoom(1.2));
  el('batchHeatmapZoomOut')?.addEventListener('click',()=>setHeatmapZoom(1/1.2));
  el('batchHeatmapZoomReset')?.addEventListener('click',()=>{const wrap=el('batchHeatmap');if(wrap){wrap.dataset.zoomScale='1';wrap.style.setProperty('--heatmap-scale','1');}const label=el('batchHeatmapZoomValue');if(label)label.textContent='100%';});
  el('downloadBatchTemplateBtn')?.addEventListener('click',downloadBatchTemplate);
  el('batchDataFile')?.addEventListener('change',e=>handleBatchFile(e.target.files&&e.target.files[0]));
  el('buildBatchGalleryBtn')?.addEventListener('click',()=>{try{const rows=collectBatchRows();renderBatchGallery(rows);el('batchDataStatus').textContent=`Galeria gerada com ${rows.length.toLocaleString('pt-BR')} registros. Todos os dados permanecem neste navegador.`;el('batchGalleryResults').scrollIntoView({behavior:'smooth',block:'start'});}catch(err){el('batchDataStatus').textContent=err.message||'Não foi possível gerar a galeria.';el('batchDataStatus').classList.add('error');}});
  el('downloadBatchCleanBtn')?.addEventListener('click',exportBatchRows);
  el('batchRowsPerPage')?.addEventListener('change',()=>{batchState.tablePage=0;renderBatchTablePage();});
  el('batchPrevPage')?.addEventListener('click',()=>{batchState.tablePage=Math.max(0,(batchState.tablePage||0)-1);renderBatchTablePage();});
  el('batchNextPage')?.addEventListener('click',()=>{batchState.tablePage=(batchState.tablePage||0)+1;renderBatchTablePage();});
  el('batchTemporalSource')?.addEventListener('change',()=>{if(batchState.rows.length){destroyBatchCharts();renderBatchGallery(batchState.rows);}});
  el('drawRawOverlayBtn')?.addEventListener('click',()=>{if(batchState.rows.length)renderRawSourceOverlay(batchState.rows);});
  for(const id of ['batchRawBand','batchRawSourceA','batchRawSourceB'])el(id)?.addEventListener('change',()=>{if(batchState.rows.length)renderRawSourceOverlay(batchState.rows);});
  for(const id of ['batchSourceColumn','batchClassColumn','batchWindowColumn','batchBandColumn','batchTimeColumn','batchFluxColumn','batchSampenColumn','batchVariabilityColumn','batchModulationColumn','batchBubbleSizeColumn'])el(id)?.addEventListener('change',()=>{const hasSampen=el('batchSampenColumn').value!=='-1',hasRaw=el('batchTimeColumn').value!=='-1'&&el('batchFluxColumn').value!=='-1';el('buildBatchGalleryBtn').disabled=!batchState.table||!(hasSampen||hasRaw);});
}
setupBatchGallery();



// Interface aprimorada dos gráficos: tela expandida e arraste para navegar.
(function setupChartNavigationUI(){
  const attached = new WeakSet();
  function chartFor(canvas){
    if (!window.Chart || !canvas) return null;
    return Object.values(Chart.instances || {}).find(chart => chart.canvas === canvas) || null;
  }
  function setPan(chart, enabled){
    if (!chart) return;
    chart.options.plugins = chart.options.plugins || {};
    chart.options.plugins.zoom = chart.options.plugins.zoom || {};
    chart.options.plugins.zoom.pan = {
      ...(chart.options.plugins.zoom.pan || {}),
      enabled, mode: 'xy', threshold: 4
    };
    chart.update('none');
  }
  function attach(panel){
    if (!panel || attached.has(panel) || !panel.querySelector('canvas')) return;
    const canvas = panel.querySelector('canvas');
    const heading = panel.querySelector('.chart-heading');
    if (!heading) return;
    attached.add(panel);
    panel.classList.add('chart-navigation-ready');
    const tools = document.createElement('div');
    tools.className = 'chart-navigation-tools';
    tools.setAttribute('aria-label','Controles de navegação do gráfico');
    const pan = document.createElement('button');
    pan.type='button'; pan.className='chart-tool-button chart-pan-toggle';
    pan.textContent='Mover: ligado'; pan.setAttribute('aria-pressed','true');
    pan.title='Ativar ou desativar o arraste para mover o gráfico';
    const full = document.createElement('button');
    full.type='button'; full.className='chart-tool-button chart-fullscreen-toggle';
    full.innerHTML='<span aria-hidden="true">⛶</span> Tela cheia';
    full.title='Abrir gráfico em tela cheia';
    const reset = document.createElement('button');
    reset.type='button'; reset.className='chart-tool-button chart-view-reset'; reset.textContent='Reset';
    reset.title='Restaurar os eixos e o zoom';
    tools.append(pan, reset, full);
    heading.appendChild(tools);
    let panEnabled=true;
    function syncPan(){
      const chart=chartFor(canvas); if(chart) setPan(chart,panEnabled);
      pan.textContent=panEnabled?'Mover: ligado':'Mover: desligado';
      pan.setAttribute('aria-pressed',String(panEnabled));
      pan.classList.toggle('is-active',panEnabled);
    }
    pan.addEventListener('click',()=>{panEnabled=!panEnabled;syncPan();});
    reset.addEventListener('click',()=>{
      const chart=chartFor(canvas);
      if(chart && typeof chart.resetZoom==='function') chart.resetZoom();
      else if(chart){ chart.options.scales && Object.values(chart.options.scales).forEach(axis=>{if(axis._originalMin!==undefined)axis.min=axis._originalMin;if(axis._originalMax!==undefined)axis.max=axis._originalMax;}); chart.update(); }
    });
    full.addEventListener('click',()=>{
      const isFull=panel.classList.contains('chart-panel-fullscreen');
      if(isFull){closeFull();return;}
      panel.classList.add('chart-panel-fullscreen');
      document.body.classList.add('chart-fullscreen-open');
      full.innerHTML='<span aria-hidden="true">×</span> Fechar tela cheia';
      full.setAttribute('aria-label','Fechar tela cheia');
      requestAnimationFrame(()=>{const chart=chartFor(canvas);if(chart)chart.resize();});
    });
    function closeFull(){
      panel.classList.remove('chart-panel-fullscreen');
      document.body.classList.remove('chart-fullscreen-open');
      full.innerHTML='<span aria-hidden="true">⛶</span> Tela cheia';
      full.setAttribute('aria-label','Abrir gráfico em tela cheia');
      requestAnimationFrame(()=>{const chart=chartFor(canvas);if(chart)chart.resize();});
    }
    panel.__closeChartFullscreen=closeFull;
    // Charts can be created after the canvas has been inserted into the page.
    let attempts=0; const waitForChart=()=>{const chart=chartFor(canvas);if(chart)setPan(chart,panEnabled);else if(++attempts<60 && canvas.isConnected)requestAnimationFrame(waitForChart);};
    requestAnimationFrame(waitForChart);
  }
  function scan(root=document){
    root.querySelectorAll?.('.chart-panel').forEach(attach);
    root.querySelectorAll?.('.chart-container').forEach(container=>attach(container.closest('.chart-panel')));
  }
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape') document.querySelectorAll('.chart-panel-fullscreen').forEach(panel=>panel.__closeChartFullscreen?.());
  });
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>scan());else scan();
  const observer=new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>{
    if(node.nodeType===1){if(node.matches?.('.chart-panel,.chart-container'))scan(node.parentElement||node);scan(node);}
  })));
  observer.observe(document.documentElement,{childList:true,subtree:true});
})();
