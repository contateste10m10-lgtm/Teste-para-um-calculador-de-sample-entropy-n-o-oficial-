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

// SampEn: Chebyshev distance, non-self pairs (i < j). A is a subset of B.
function sampleEntropy(series, m, toleranceMultiplier) {
  const x = series.filter(v=>Number.isFinite(v));
  if (x.length <= m + 1) return {value:null,reason:'Poucos pontos'};
  const mu = x.reduce((s,v)=>s+v,0)/x.length;
  const variance = x.reduce((s,v)=>s+(v-mu)**2,0)/x.length;
  const sigma = Math.sqrt(variance);
  if (!Number.isFinite(sigma) || sigma === 0) return {value:null,reason:'Série constante'};
  const r = toleranceMultiplier*sigma;
  let B=0, A=0;
  const n = x.length;
  // Count each pair once. Excluding self-matches avoids the bias of approximate entropy.
  for (let i=0;i<n-m;i++) {
    for (let j=i+1;j<n-m;j++) {
      let matchM=true;
      for (let k=0;k<m;k++) if (Math.abs(x[i+k]-x[j+k])>r) { matchM=false; break; }
      if (!matchM) continue;
      B++;
      if (Math.abs(x[i+m]-x[j+m])<=r) A++;
    }
  }
  if (B===0) return {value:null,reason:'Nenhum par mapeado',sigma,r,A,B,n};
  if (A===0) return {value:null,reason:'A = 0 (sem extensões coincidentes)',sigma,r,A,B,n};
  return {value:-Math.log(A/B),sigma,r,A,B,n};
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
      if (Number.isFinite(t) && Number.isFinite(y)) points.push({x:t,y,error:Number.isFinite(err)?Math.abs(err):null});
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
    return {...b,...res,mean:mean(values),std:std(values),n:values.length,cadence:timeCadence(b.points)};
  });
  const valid=results.filter(r=>Number.isFinite(r.value));
  state.results=results;state.latestAnalysis={m,r,source:el('sourceName').value.trim()||state.fileName,instrument:el('instrumentName').value.trim()||'Não informado',timeLabel:timeUnitLabel(state.table.header[state.timeIndex]),timestamp:new Date()};
  renderResults(results, valid);
  el('resultsSection').classList.remove('hidden');
  el('resultsSection').scrollIntoView({behavior:'smooth',block:'start'});
  const missing=results.filter(x=>!Number.isFinite(x.value)).length;
  message(missing?`Análise concluída. ${missing} banda(s) não produziram SampEn finita; veja a coluna Status.`:'Análise concluída com sucesso para as oito bandas.','');
}

function destroyCharts(){for(const c of state.charts){try{c.destroy()}catch{}}state.charts=[];}
function chartDefaults(){return {responsive:true,maintainAspectRatio:false,animation:{duration:350},plugins:{legend:{display:false},tooltip:{backgroundColor:'#0b1020',borderColor:'#35435f',borderWidth:1,titleColor:'#eaf1ff',bodyColor:'#bdcbe4',displayColors:false}},scales:{x:{grid:{color:'rgba(128,149,190,.08)'},ticks:{color:'#7787a5',maxTicksLimit:7,font:{family:'DM Mono',size:9}},border:{color:'#34405a'}},y:{grid:{color:'rgba(128,149,190,.10)'},ticks:{color:'#7787a5',maxTicksLimit:5,font:{family:'DM Mono',size:9}},border:{color:'#34405a'}}}};}
function makeChart(ctx,config){if(!window.Chart)throw new Error('A biblioteca de gráficos não carregou. Confira a conexão à internet e recarregue a página.');const c=new Chart(ctx,config);state.charts.push(c);return c;}
function renderResults(results,valid){
  const an=state.latestAnalysis;const source=an.source||'Fonte sem nome';
  el('resultsSubtitle').textContent=`${source} · ${an.instrument} · m = ${an.m}, r = ${String(an.r).replace('.',',')}σ`;
  el('metricBands').textContent=`${valid.length}/8`;
  el('metricMean').textContent=valid.length?formatNum(mean(valid.map(x=>x.value))):'—';
  const max=valid.length?valid.reduce((a,b)=>a.value>b.value?a:b):null;
  el('metricMax').textContent=max?formatNum(max.value):'—';el('metricMaxBand').textContent=max?max.def.name:'nenhuma banda válida';
  const maxPoints=results.reduce((a,b)=>Math.max(a,b.n),0);el('metricPoints').textContent=formatInt(maxPoints);
  const tbody=el('resultsTable').querySelector('tbody');
  tbody.innerHTML=results.map(r=>{
    const ok=Number.isFinite(r.value), status=ok?'Calculada':(r.reason||'Indisponível');
    const cls=ok?'':'warning';
    return `<tr><td><span class="band-dot" style="background:${r.def.color}"></span>${r.def.name}</td><td>${formatInt(r.n)}</td><td>${formatNum(r.sigma,3)}</td><td><strong>${formatNum(r.value,4)}</strong></td><td><span class="result-status ${cls}" title="${escapeHtml(status)}">${escapeHtml(ok?'OK':status)}</span></td></tr>`;
  }).join('');
  destroyCharts();
  const ctx=el('entropyChart').getContext('2d');
  makeChart(ctx,{type:'bar',data:{labels:results.map(r=>r.def.short),datasets:[{data:results.map(r=>Number.isFinite(r.value)?r.value:null),backgroundColor:results.map(r=>r.def.color+'cc'),borderColor:results.map(r=>r.def.color),borderWidth:1,borderRadius:4,maxBarThickness:42}]},options:{...chartDefaults(),scales:{...chartDefaults().scales,y:{...chartDefaults().scales.y,beginAtZero:true,title:{display:true,text:'Sample Entropy',color:'#93a3c0',font:{family:'DM Mono',size:10}}},x:{...chartDefaults().scales.x,title:{display:true,text:'Banda',color:'#93a3c0',font:{family:'DM Mono',size:10}}}}}});
  renderLightcurves(results);
  const cadence=results.map(r=>r.cadence.cv).filter(Number.isFinite); const irregular=cadence.some(v=>v>0.1);
  el('methodNoteText').textContent=`SampEn foi calculada por banda com distância de Chebyshev, comparando pares não idênticos de padrões de comprimento m e m+1; r = ${String(an.r).replace('.',',')} × σ da própria banda. ${irregular?'Os intervalos temporais variam entre observações em pelo menos uma banda; o cálculo usa a ordem dos pontos, não pondera os intervalos reais. ':'Mesmo quando as datas parecem regulares, SampEn trabalha com a sequência de pontos e não pondera os intervalos reais. '}Valores sem correspondências suficientes são mostrados como indisponíveis, não como zero.`;
  el('generatedAt').textContent=`Processado em ${new Date().toLocaleString('pt-BR')}`;
}
function renderLightcurves(results){
  const grid=el('lightcurveGrid');const normalize=el('normalizeCurves').checked;
  grid.innerHTML=results.map((r,i)=>`<article class="lightcurve-card"><div class="lightcurve-card-head"><strong><span class="band-dot" style="background:${r.def.color}"></span>${r.def.name}</strong><span>SampEn ${formatNum(r.value,3)}</span></div><div class="lightcurve-canvas"><canvas id="lc-${i}" aria-label="Curva de luz ${r.def.name}"></canvas></div><div class="curve-meta"><span>N <b>${formatInt(r.n)}</b></span><span>média <b>${formatNum(r.mean,3)}</b></span><span>σ <b>${formatNum(r.std,3)}</b></span></div></article>`).join('');
  results.forEach((r,i)=>{
    const vals=r.points.map(p=>p.y);const mu=mean(vals)||0;const sd=std(vals)||1;
    const data=r.points.map(p=>({x:p.x,y:normalize?(p.y-mu)/sd:p.y}));
    const options={...chartDefaults(),parsing:false,scales:{...chartDefaults().scales,x:{...chartDefaults().scales.x,type:'linear',title:{display:true,text:state.latestAnalysis.timeLabel,color:'#8797b3',font:{family:'DM Mono',size:9}}},y:{...chartDefaults().scales.y,title:{display:true,text:normalize?'Fluxo normalizado (z-score)':'Taxa / fluxo',color:'#8797b3',font:{family:'DM Mono',size:9}}}},plugins:{...chartDefaults().plugins,tooltip:{...chartDefaults().plugins.tooltip,callbacks:{label:c=>`${c.parsed.y.toLocaleString('pt-BR',{maximumFractionDigits:5})}`}}}};
    makeChart(el(`lc-${i}`).getContext('2d'),{type:'line',data:{datasets:[{data,borderColor:r.def.color,backgroundColor:r.def.color+'22',borderWidth:1.5,pointRadius:0,pointHoverRadius:3,tension:0,spanGaps:false}]},options});
  });
}
el('normalizeCurves').addEventListener('change',()=>{if(state.results.length)renderLightcurves(state.results);});

function downloadBlob(blob, filename){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
el('downloadCsvBtn').addEventListener('click',()=>{
  if(!state.results.length)return;
  const rows=[['source',state.latestAnalysis.source],['instrument',state.latestAnalysis.instrument],['m',state.latestAnalysis.m],['r_sigma',state.latestAnalysis.r],[],['band_keV','N_valid','mean_rate','std_sigma','A_matches','B_matches','SampEn','status']];
  for(const r of state.results)rows.push([r.def.name,r.n,r.mean??'',r.sigma??'',r.A??'',r.B??'',r.value??'',r.reason||'OK']);
  const csv='\uFEFF'+rows.map(row=>row.map(v=>{const s=String(v??'');return /[",\n;]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}).join(';')).join('\r\n');
  downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),`sampen_${slug(state.latestAnalysis.source)}.csv`);
});
el('downloadPngBtn').addEventListener('click',()=>{
  const canvas=el('entropyChart');if(!canvas)return;canvas.toBlob(blob=>{if(blob)downloadBlob(blob,`sampen_por_banda_${slug(state.latestAnalysis?.source||'fonte')}.png`);});
});
function slug(s){return String(s||'fonte').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70)||'fonte';}

el('analyzeBtn').addEventListener('click',()=>{
  const btn=el('analyzeBtn');btn.disabled=true;btn.innerHTML='<span class="loading-spinner"></span><span>Calculando…</span>';
  setTimeout(()=>{try{analyze();}catch(e){message(e.message||'Falha inesperada na análise.','error');}finally{btn.disabled=false;btn.innerHTML='<span>Calcular Sample Entropy</span><span class="button-arrow">↗</span>'; }},25);
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
el('openDirectLink').addEventListener('click', event => {
  if (el('openDirectLink').getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
    el('urlHelp').textContent = 'Cole primeiro um link completo começando com https:// ou http://.';
    el('urlHelp').classList.add('error');
  }
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
  message('Link oficial preparado. Baixe o arquivo .lc.gz e depois carregue-o na área de entrada.');
}
el('nasaPrepareBtn').addEventListener('click',prepareNasaLink);
el('nasaSourceName').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();prepareNasaLink();}});

// Keep the eight-band mapping specific to the Swift-BAT 157-month products, while supporting arbitrary column names via selectors.
