'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');

const app = express();
const PORT = process.env.PORT || 3000;
const CPTEC_BASE = 'https://nowcasting.cptec.inpe.br/api/v1';
const ALLOWED_ORIGIN = (process.env.CLOUDGOD_ORIGIN || 'https://cloudgod-gif-foto.onrender.com').replace(/\/$/, '');

const NOAA_BUCKET = 'https://noaa-goes19.s3.amazonaws.com';
const GLM_PRODUCT = 'GLM-L2-LCFA';
const REQUEST_TIMEOUT_MS = 20000;
const MAX_LIGHTNING_MINUTES = 60;
let h5wasmModulePromise;

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'), (error) => {
    if (error && !res.headersSent) {
      res.status(500).type('text/plain').send('Não foi possível carregar o index.html. Verifique se ele está na raiz do serviço.');
    }
  });
});

function applyCors(req, res) {
  const origin = req.get('Origin');
  if (origin && origin === ALLOWED_ORIGIN) {
    res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Accept');
  }
  return !origin || origin === ALLOWED_ORIGIN;
}

function setApiHeaders(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });
}

// O raster é público e o destino do proxy é rigidamente limitado à REDEMET.
// CORS aberto somente nesta rota de imagem evita falhas quando o dashboard
// é acessado por domínio próprio, domínio Render ou subdomínio alternativo.
function applyRadarImageCors(res) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept',
    'Access-Control-Max-Age': '86400',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Timing-Allow-Origin': '*'
  });
}

function detectImageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return '';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)) return 'image/tiff';
  return '';
}

function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}


// ECMWF IFS HRES 0.25° global 2 m temperature (2t), decoded from original GRIB2.
const ECMWF_ROOT = 'https://data.ecmwf.int/forecasts';
let ecmwfTemperatureCache = null;
let ecmwfTemperatureCacheAt = 0;
let ecmwfTemperatureRequestPromise = null;
const ECMWF_TEMP_CACHE_MS = 20 * 60 * 1000;
const ECMWF_TEMP_TIMEOUT_MS = 12000;


function ecmwfTempColor(tempC) {
  const stops = [[-40,[84,39,143]],[-25,[44,127,184]],[-10,[65,182,196]],[0,[161,218,180]],[10,[255,255,178]],[20,[254,153,41]],[30,[204,76,2]],[40,[127,0,0]]];
  if (tempC <= stops[0][0]) return stops[0][1];
  if (tempC >= stops[stops.length-1][0]) return stops[stops.length-1][1];
  for (let i=0;i<stops.length-1;i++) {
    const [a,ca]=stops[i], [b,cb]=stops[i+1];
    if (tempC>=a && tempC<=b) { const t=(tempC-a)/(b-a); return ca.map((v,k)=>Math.round(v+(cb[k]-v)*t)); }
  }
  return [255,255,255];
}
function crc32(buf) {
  let crc=0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for(let k=0;k<8;k++) crc=(crc&1)?(crc>>>1)^0xedb88320:(crc>>>1);
  }
  return (crc^0xffffffff)>>>0;
}
function pngChunk(type,data) {
  const typeBytes=Buffer.from(type,'ascii');
  const length=Buffer.alloc(4); length.writeUInt32BE(data.length,0);
  const crcInput=Buffer.concat([typeBytes,data]);
  const crc=Buffer.alloc(4); crc.writeUInt32BE(crc32(crcInput),0);
  return Buffer.concat([length,typeBytes,data,crc]);
}
function encodeTemperaturePng(values,lats,lons) {
  if(!values || !lats || !lons || values.length!==lats.length || values.length!==lons.length) throw new Error('Decoder ECMWF retornou grade/coords incompatíveis.');
  const latSet=new Set(), lonSet=new Set();
  for(let i=0;i<values.length;i++){
    if(!Number.isFinite(lats[i])||!Number.isFinite(lons[i]))continue;
    latSet.add(Number(lats[i].toFixed(4)));
    let lon=((lons[i]+180)%360+360)%360-180;
    lonSet.add(Number(lon.toFixed(4)));
  }
  const latArray=[...latSet].sort((a,b)=>b-a), lonArray=[...lonSet].sort((a,b)=>a-b);
  if(latArray.length<2||lonArray.length<2)throw new Error('ECMWF grade não é global lat/lon esperada.');
  const width=lonArray.length,height=latArray.length;
  const latIndex=new Map(latArray.map((v,i)=>[v,i])), lonIndex=new Map(lonArray.map((v,i)=>[v,i]));
  const grid=new Float32Array(width*height); grid.fill(NaN);
  for(let i=0;i<values.length;i++){
    if(!Number.isFinite(values[i])||!Number.isFinite(lats[i])||!Number.isFinite(lons[i]))continue;
    const lat=Number(lats[i].toFixed(4)); let lon=((lons[i]+180)%360+360)%360-180; lon=Number(lon.toFixed(4));
    const row=latIndex.get(lat),col=lonIndex.get(lon);
    if(row!==undefined&&col!==undefined)grid[row*width+col]=values[i]-273.15;
  }
  const raw=Buffer.alloc((width*4+1)*height);
  for(let y=0;y<height;y++){
    const rowOffset=y*(width*4+1); raw[rowOffset]=0;
    for(let x=0;x<width;x++){
      const value=grid[y*width+x], pixel=rowOffset+1+x*4;
      if(!Number.isFinite(value)){raw[pixel+3]=0;continue;}
      const rgb=ecmwfTempColor(value);raw[pixel]=rgb[0];raw[pixel+1]=rgb[1];raw[pixel+2]=rgb[2];raw[pixel+3]=205;
    }
  }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
  return {png:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',require('zlib').deflateSync(raw,{level:6})),pngChunk('IEND',Buffer.alloc(0))]),width,height};
}
let ecmwfDecoderPromise = null;
async function getEcmwfDecoder() {
  if (!ecmwfDecoderPromise) {
    ecmwfDecoderPromise = (async () => {
      // Decoder GRIB2 mantido em TypeScript puro; JPEG2000 é carregado pelo subpath Node.
      const grib = await import('@azohra/meteo.grib');
      const j2k = await import('@azohra/meteo.grib/j2k-node');
      const required = ['splitMessages', 'parseFields', 'parseGrid', 'decodeFieldValues'];
      const missing = required.filter((name) => typeof grib[name] !== 'function');
      if (missing.length) throw new Error('Decoder GRIB2 sem exports necessários: ' + missing.join(', '));
      if (typeof j2k.createNodeJ2kDecoder !== 'function') {
        throw new Error('O decoder JPEG2000 do pacote GRIB2 não está disponível.');
      }
      const decodeJ2k = await j2k.createNodeJ2kDecoder();
      console.log('[CLOUDGOD ECMWF] Decoder GRIB2/JPEG2000 inicializado.');
      return { ...grib, decodeJ2k };
    })().catch((error) => {
      ecmwfDecoderPromise = null;
      throw new Error('Não foi possível inicializar o decoder GRIB2: ' + (error?.message || error));
    });
  }
  return ecmwfDecoderPromise;
}

// Constrói as coordenadas na mesma ordem de varredura dos valores GRIB2.
// O ECMWF IFS HRES 0.25° usa grade latitude/longitude regular (template 3.0).
function ecmwfGridCoordinates(grid, valueCount) {
  if (!grid || grid.kind !== 'latlon') {
    throw new Error('ECMWF HRES retornou uma grade diferente de latitude/longitude regular.');
  }
  const ni = Number(grid.ni), nj = Number(grid.nj);
  if (!Number.isInteger(ni) || !Number.isInteger(nj) || ni < 2 || nj < 2 || ni * nj !== valueCount) {
    throw new Error(`Dimensões GRIB2 incompatíveis: ${ni}x${nj}, valores=${valueCount}.`);
  }
  const lats = new Float64Array(valueCount);
  const lons = new Float64Array(valueCount);
  const iSign = grid.iScansNegatively ? -1 : 1;
  const jSign = grid.jScansPositively ? 1 : -1;
  const firstLat = Number(grid.latitudeOfFirstGridPoint);
  const firstLon = Number(grid.longitudeOfFirstGridPoint);
  const di = Number(grid.iDirectionIncrement);
  const dj = Number(grid.jDirectionIncrement);
  if (![firstLat, firstLon, di, dj].every(Number.isFinite) || di <= 0 || dj <= 0) {
    throw new Error('Metadados de coordenadas inválidos no GRIB2 ECMWF.');
  }

  for (let j = 0; j < nj; j++) {
    for (let i = 0; i < ni; i++) {
      let ii = i;
      let jj = j;
      if (grid.alternativeRowScanning && (grid.jPointsAreConsecutive ? i : j) % 2 === 1) {
        if (grid.jPointsAreConsecutive) jj = nj - 1 - j;
        else ii = ni - 1 - i;
      }
      const index = grid.jPointsAreConsecutive ? (ii * nj + jj) : (jj * ni + ii);
      lats[index] = firstLat + jSign * jj * dj;
      lons[index] = firstLon + iSign * ii * di;
    }
  }
  return { lats, lons };
}

function isEcmwfTwoMetreTemperature(section4) {
  // GRIB2 Section 4, Product Definition Template 4.0.
  // Fixed-surface type 1 (first surface) is byte 17; byte 22 belongs
  // to the scaled value and is NOT the surface-type identifier.
  if (!section4 || section4.length < 29 || section4[4] !== 4) return false;
  const productTemplate = (section4[7] << 8) | section4[8];
  return productTemplate === 0 && section4[9] === 0 && section4[10] === 0 && section4[17] === 103;
}

function ecmwfRunCandidates() {
  const now=new Date(Date.now()-4*60*60*1000); // allow for 0.25° dissemination delay
  now.setUTCMinutes(0,0,0);
  const runs=[];
  for(let d=0;d<3;d++){
    const date=new Date(now);date.setUTCDate(date.getUTCDate()-d);
    const ymd=date.toISOString().slice(0,10).replace(/-/g,''), datePath=ymd; // ECMWF URL uses YYYYMMDD, not YYYY/MM/DD
    for(const hour of [18,12,6,0]){
      if(d===0&&hour>now.getUTCHours())continue;
      const cycleDate=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),hour));
      if(cycleDate>now)continue;
      const hh=String(hour).padStart(2,'0');
      runs.push({ymd,hh,datePath,stamp:`${ymd}${hh}0000`});
    }
  }
  runs.sort((a,b)=>b.stamp.localeCompare(a.stamp));
  return runs.slice(0,8);
}
async function fetchEcmwfTemperatureGrib() {
  const decoder = await getEcmwfDecoder();
  const runs=ecmwfRunCandidates();
  const steps=[0,6];
  let chosen=null;
  for(const run of runs){
    for(const step of steps){
      const stepText=`${step}h`;
      const base=`${ECMWF_ROOT}/${run.datePath}/${run.hh}z/ifs/0p25/oper/${run.stamp}-${stepText}-oper-fc`;
      let indexRes;
      try{ indexRes=await fetchWithTimeout(base+'.index',{headers:{'User-Agent':'CLOUDGOD ECMWF OpenData temperature proxy/1.0','Accept':'text/plain'},cache:'no-store'},ECMWF_TEMP_TIMEOUT_MS); }
      catch(_){continue;}
      if(!indexRes.ok)continue;
      const indexText=await indexRes.text();
      const record=indexText.split(/\r?\n/).map(line=>{try{return JSON.parse(line);}catch(_){return null;}}).find(r=>r&&r.param==='2t'&&r.levtype==='sfc'&&Number(r.step)===step&&Number.isFinite(r._offset)&&Number.isFinite(r._length));
      if(!record)continue;
      const start=record._offset,end=start+record._length-1;
      let gribRes;
      try{gribRes=await fetchWithTimeout(base+'.grib2',{headers:{'User-Agent':'CLOUDGOD ECMWF OpenData temperature proxy/1.0','Range':`bytes=${start}-${end}`,'Accept':'application/octet-stream'},cache:'no-store'},ECMWF_TEMP_TIMEOUT_MS);}
      catch(_){continue;}
      if(gribRes.status!==206)continue; // never accept a full-file response when range is ignored
      const bytes=new Uint8Array(await gribRes.arrayBuffer());
      if(!bytes.length)continue;
      try {
        const messages = decoder.splitMessages(bytes);
        for (const message of messages) {
          const fields = decoder.parseFields(message);
          for (const field of fields) {
            if (!isEcmwfTwoMetreTemperature(field.section4)) continue;
            const grid = decoder.parseGrid(field.section3);
            const decoded = decoder.decodeFieldValues(field, { decodeJ2k: decoder.decodeJ2k });
            const vals = decoded?.values;
            if (!vals?.length) continue;
            const { lats, lons } = ecmwfGridCoordinates(grid, vals.length);
            const png = encodeTemperaturePng(vals, lats, lons);
            const valid = new Date(Date.UTC(Number(run.ymd.slice(0,4)), Number(run.ymd.slice(4,6))-1, Number(run.ymd.slice(6,8)), Number(run.hh)+step)).toISOString();
            chosen = { ...png, run: `${run.ymd} ${run.hh}Z`, step: `${step}h`, valid, bytes: bytes.length };
            return chosen;
          }
        }
      } catch (err) {
        console.warn('[CLOUDGOD ECMWF] GRIB2 decode failed:', err?.stack || err?.message || err);
      }
    }
  }
  throw new Error('ECMWF Open Data: não encontrei um campo 2t (2 m) disponível nos ciclos recentes.');
}
app.get('/api/ecmwf-temperature', async (_req,res)=>{
  res.set('Cache-Control','public, max-age=300, stale-while-revalidate=600');
  res.set('X-Content-Type-Options','nosniff');
  try{
    let data;
    if(ecmwfTemperatureCache&&Date.now()-ecmwfTemperatureCacheAt<ECMWF_TEMP_CACHE_MS)data=ecmwfTemperatureCache;
    else{
      if(!ecmwfTemperatureRequestPromise)ecmwfTemperatureRequestPromise=fetchEcmwfTemperatureGrib().finally(()=>{ecmwfTemperatureRequestPromise=null;});
      data=await ecmwfTemperatureRequestPromise;
      ecmwfTemperatureCache=data;ecmwfTemperatureCacheAt=Date.now();
    }
    res.set({'Content-Type':'image/png','Content-Length':String(data.png.length),'X-ECMWF-Model':'IFS HRES','X-ECMWF-Grid':'0.25 degree','X-ECMWF-Run':data.run,'X-ECMWF-Step':data.step,'X-ECMWF-Valid':data.valid,'X-ECMWF-Image-Size':`${data.width}x${data.height}`});
    return res.status(200).send(data.png);
  }catch(err){
    console.error('[CLOUDGOD ECMWF temperature]',err?.message||err);
    return res.status(502).type('text/plain').send(err?.message||'Falha ao buscar/decodificar ECMWF IFS HRES.');
  }
});


// Proxy de imagens de radar REDEMET: usado pelo index.html para raster/CORS
// Endpoint: /api/radar-image?url=<URL da imagem oficial>
app.route('/api/radar-image').get(async (req, res) => {
  applyRadarImageCors(res);

  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  let target;
  try {
    target = new URL(rawUrl, 'https://api-redemet.decea.mil.br');
  } catch (_) {
    return res.status(400).type('text/plain').send('URL de imagem inválida.');
  }

  // Restrição para impedir que o proxy seja usado para acessar outros serviços.
  if (
    target.protocol !== 'https:' ||
    target.hostname !== 'api-redemet.decea.mil.br' ||
    (target.port && target.port !== '443') ||
    target.username ||
    target.password
  ) {
    return res.status(400).type('text/plain').send('Host de imagem não permitido.');
  }

  try {
    const upstream = await fetchWithTimeout(target.href, {
      headers: {
        Accept: 'image/*, application/octet-stream;q=0.9, */*;q=0.5',
        'User-Agent': 'Mozilla/5.0 (compatible; CLOUDGOD-Radar-Proxy/1.0)',
        Referer: 'https://api-redemet.decea.mil.br/'
      },
      cache: 'no-store'
    }, 25000);

    if (!upstream.ok) {
      return res.status(502).type('text/plain').send(`REDEMET respondeu HTTP ${upstream.status}.`);
    }

    const upstreamType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!bytes.length) return res.status(502).type('text/plain').send('Imagem REDEMET vazia.');
    if (bytes.length > 12 * 1024 * 1024) {
      return res.status(413).type('text/plain').send('Imagem excede o limite de 12 MB.');
    }

    // Algumas respostas de imagem chegam como application/octet-stream.
    // Confirma o formato pelos bytes, em vez de rejeitar um raster válido.
    const detectedType = detectImageType(bytes);
    // Alguns gateways devolvem HTML de erro com Content-Type image/*.
    // A assinatura binária é a validação definitiva para o MapLibre.
    const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    const contentType = detectedType;
    if (!contentType || !supportedTypes.has(contentType)) {
      console.error('[CLOUDGOD] REDEMET não entregou imagem:', {
        contentType: upstreamType,
        bytes: bytes.length,
        url: target.pathname
      });
      return res.status(502).type('text/plain').send('A REDEMET não retornou um raster de imagem reconhecido.');
    }

    res.set({
      'Cache-Control': 'public, max-age=30, stale-while-revalidate=15',
      'Content-Type': contentType,
      'Content-Length': String(bytes.length),
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'X-Radar-Proxy': 'REDEMET',
      'X-Radar-Image-Format': contentType,
      'Access-Control-Expose-Headers': 'X-Radar-Proxy, X-Radar-Image-Format'
    });
    return res.status(200).send(bytes);
  } catch (error) {
    const timeout = error?.name === 'AbortError';
    console.error('[CLOUDGOD] Falha no proxy REDEMET:', error?.message || error);
    return res.status(502).type('text/plain').send(timeout
      ? 'Tempo limite ao buscar imagem REDEMET.'
      : 'Não foi possível conectar à REDEMET.');
  }
});

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'CLOUDGOD CPTEC + NOAA GLM + ECMWF HRES Temperature', apis: ['/api/cptec', '/api/lightning', '/api/radar-image', '/api/ecmwf-temperature'] });
});

app.options(['/api/cptec', '/api/lightning', '/api/radar-image', '/api/ecmwf-temperature'], (req, res) => {
  if (req.path === '/api/radar-image') {
    applyRadarImageCors(res);
    return res.status(204).end();
  }
  if (!applyCors(req, res)) return res.status(403).end();
  return res.status(204).end();
});

// Proxy CPTEC
app.get('/api/cptec', async (req, res) => {
  if (!applyCors(req, res)) return res.status(403).json({ error: 'Origem não autorizada.' });

  const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
  const isJsonEndpoint = /^\/paths\/radar\/layers\/[a-z0-9~_-]+\/(times|legend)$/i.test(requestedPath);
  const isFrameEndpoint = /^\/paths\/frames\/radar\/[a-z0-9~_-]+\/20\d{10}\/full$/i.test(requestedPath);

  if (!isJsonEndpoint && !isFrameEndpoint) {
    return res.status(400).json({ error: 'Caminho CPTEC inválido ou não permitido.' });
  }

  try {
    const upstream = await fetchWithTimeout(CPTEC_BASE + requestedPath, {
      headers: {
        Accept: isFrameEndpoint ? 'image/*, application/octet-stream;q=0.9, */*;q=0.8' : 'application/json, text/plain, */*',
        'User-Agent': 'CLOUDGOD-CPTEC-Proxy/1.1'
      },
      cache: 'no-store'
    }, isFrameEndpoint ? 30000 : REQUEST_TIMEOUT_MS);

    if (!upstream.ok) {
      const message = `O CPTEC respondeu HTTP ${upstream.status}.`;
      if (isFrameEndpoint) return res.status(502).type('text/plain').send(message);
      return res.status(502).json({ error: message, upstreamStatus: upstream.status });
    }

    if (isFrameEndpoint) {
      const contentType = upstream.headers.get('content-type') || 'image/png';
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (!bytes.length) return res.status(502).type('text/plain').send('O CPTEC retornou uma imagem vazia.');

      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'Content-Type': contentType
      });
      return res.status(200).send(bytes);
    }

    const body = await upstream.text();
    try {
      res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Content-Type': 'application/json; charset=utf-8' });
      return res.status(200).json(JSON.parse(body));
    } catch (_error) {
      return res.status(502).json({ error: 'O CPTEC retornou uma resposta que não é JSON válido.' });
    }
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    const message = timedOut ? 'Tempo limite ao consultar o CPTEC.' : 'Não foi possível conectar ao serviço do CPTEC.';
    if (isFrameEndpoint) return res.status(502).type('text/plain').send(message);
    return res.status(502).json({ error: message, detail: timedOut ? 'upstream_timeout' : 'upstream_connection_failed' });
  }
});

function xmlDecode(value) {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function glmPrefix(hour) {
  const year = hour.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const day = Math.floor((Date.UTC(year, hour.getUTCMonth(), hour.getUTCDate()) - start) / 86400000) + 1;
  return `${GLM_PRODUCT}/${year}/${String(day).padStart(3, '0')}/${String(hour.getUTCHours()).padStart(2, '0')}/`;
}
async function listGlmFiles(startTime, endTime) {
  const prefixes = [];
  const cursor = new Date(startTime);
  cursor.setUTCMinutes(0, 0, 0);

  const lastHour = new Date(endTime);
  lastHour.setUTCMinutes(0, 0, 0);

  while (cursor <= lastHour) {
    prefixes.push(glmPrefix(cursor));
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  const found = [];

  for (const prefix of prefixes) {
    let continuationToken;

    do {
      const url = new URL(`${NOAA_BUCKET}/`);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);

      if (continuationToken) {
        url.searchParams.set('continuation-token', continuationToken);
      }

      const response = await fetchWithTimeout(url, {
        headers: { Accept: 'application/xml' }
      });

      if (!response.ok) {
        throw new Error(`NOAA S3 list HTTP ${response.status}`);
      }

      const xml = await response.text();
      const contents = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];

      for (const item of contents) {
        const keyMatch = item.match(/<Key>([\s\S]*?)<\/Key>/);
        if (!keyMatch) continue;

        const key = xmlDecode(keyMatch[1]);
        if (!key.endsWith('.nc')) continue;

        const stamp = key.match(/_s(\d{14})/);
        if (!stamp) continue;

        // Formato NOAA: YYYYDDDHHMMSSs (o último dígito representa décimos).
        const startStamp = stamp[1];
        const year = Number(startStamp.slice(0, 4));
        const day = Number(startStamp.slice(4, 7));
        const hh = Number(startStamp.slice(7, 9));
        const mm = Number(startStamp.slice(9, 11));
        const ss = Number(startStamp.slice(11, 13));
        const tenth = Number(startStamp.slice(13, 14));

        // O campo DDD do nome NOAA é o dia do ano (001–366), não o dia do mês.
        // Converter a partir de 1º de janeiro evita descartar todos os arquivos recentes.
        const fileTime = new Date(
          Date.UTC(year, 0, 1, hh, mm, ss, tenth * 100) + (day - 1) * 86400000
        );

        if (fileTime >= startTime && fileTime <= endTime) {
          found.push({
            key,
            time: fileTime,
            url: `${NOAA_BUCKET}/${key}`
          });
        }
      }

      continuationToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];

      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      if (!truncated) continuationToken = undefined;

    } while (continuationToken);
  }

  found.sort((a, b) => a.time - b.time);
  return found;
}

async function getH5Module() {
  if (!h5wasmModulePromise) {
    h5wasmModulePromise = (async () => {
      const imported = await import('h5wasm/node');
      const h5wasm = imported.default || imported;
      await h5wasm.ready;
      if (typeof h5wasm.File !== 'function') {
        throw new Error('h5wasm não disponibilizou a classe File.');
      }
      return h5wasm;
    })().catch((error) => {
      h5wasmModulePromise = null;
      throw error;
    });
  }
  return h5wasmModulePromise;
}

async function getH5Dataset(filePath) {
  const h5wasm = await getH5Module();
  return new h5wasm.File(filePath, 'r');
}

function getH5Variable(dataset, name) {
  try {
    return dataset.get(name);
  } catch (_error) {
    return null;
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function getVariableAttribute(variable, name) {
  if (!variable) return null;
  const attribute = variable.attrs?.[name];
  if (attribute === undefined || attribute === null) return null;

  if (
    typeof attribute === 'object' &&
    !ArrayBuffer.isView(attribute) &&
    Object.prototype.hasOwnProperty.call(attribute, 'value')
  ) {
    return attribute.value;
  }
  return attribute;
}

function firstNumeric(value, fallback) {
  if (value === undefined || value === null) return fallback;

  if (ArrayBuffer.isView(value) || Array.isArray(value)) {
    return value.length ? finiteNumber(value[0]) ?? fallback : fallback;
  }

  return finiteNumber(value) ?? fallback;
}

async function unpackVariable(variable) {
  if (!variable) throw new Error('Variável NetCDF ausente.');

  const raw = variable.value;
  if (!raw || typeof raw.length !== 'number') {
    throw new Error(`A variável ${variable.path || ''} não contém dados legíveis.`);
  }

  const scale = firstNumeric(await getVariableAttribute(variable, 'scale_factor'), 1);
  const offset = firstNumeric(await getVariableAttribute(variable, 'add_offset'), 0);
  const fill = await getVariableAttribute(variable, '_FillValue');
  const missing = await getVariableAttribute(variable, 'missing_value');
  const unsignedAttribute = await getVariableAttribute(variable, '_Unsigned');

  const dtype = String(variable.dtype || '').toLowerCase();
  const metadataSize = Number(variable.metadata?.size || 0);
  const bitsMatch = dtype.match(/(?:u|i)(1|2|4|8)$/);
  const bits = bitsMatch ? Number(bitsMatch[1]) * 8 : metadataSize * 8;
  const unsigned = dtype.includes('u') ||
    String(unsignedAttribute ?? '').toLowerCase() === 'true' ||
    unsignedAttribute === 1;
  const unsignedModulus = bits > 0 && bits <= 32 ? 2 ** bits : 0;

  const fillValues = [fill, missing]
    .flatMap((value) =>
      ArrayBuffer.isView(value) || Array.isArray(value) ? Array.from(value) : [value]
    )
    .map((value) => finiteNumber(value))
    .filter((value) => value !== null);

  const values = new Array(raw.length);

  for (let i = 0; i < raw.length; i++) {
    const packed = finiteNumber(raw[i]);

    // Verificar _FillValue antes de interpretar inteiros como unsigned.
    if (packed === null || fillValues.includes(packed)) {
      values[i] = null;
      continue;
    }

    const unpacked = unsigned && unsignedModulus && packed < 0
      ? packed + unsignedModulus
      : packed;

    const value = unpacked * scale + offset;
    values[i] = Number.isFinite(value) ? value : null;
  }

  return values;
}

async function decodeGlmFile(fileInfo) {
  let tempPath;
  let dataset;

  try {
    const response = await fetchWithTimeout(fileInfo.url, {
      headers: { Accept: 'application/octet-stream' }
    }, 30000);

    if (!response.ok) {
      throw new Error(`Arquivo NOAA HTTP ${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());

    if (!bytes.length) {
      throw new Error('A NOAA retornou um arquivo vazio.');
    }

    tempPath = path.join(
      os.tmpdir(),
      `cloudgod-glm-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.nc`
    );

    await fs.writeFile(tempPath, bytes);
    dataset = await getH5Dataset(tempPath);

    const latVar = getH5Variable(dataset, 'flash_lat');
    const lonVar = getH5Variable(dataset, 'flash_lon');

    if (!latVar || !lonVar) {
      throw new Error('O NetCDF não contém flash_lat e/ou flash_lon.');
    }

    const energyVar = getH5Variable(dataset, 'flash_energy');
    const flashTimeVar = getH5Variable(dataset, 'flash_time_offset_of_first_event');

    const [latitudes, longitudes, energies, flashTimeOffsets] = await Promise.all([
      unpackVariable(latVar),
      unpackVariable(lonVar),
      energyVar
        ? unpackVariable(energyVar).catch(() => null)
        : Promise.resolve(null),
      flashTimeVar
        ? unpackVariable(flashTimeVar).catch(() => null)
        : Promise.resolve(null)
    ]);

    const count = Math.min(latitudes.length, longitudes.length);
    const features = [];
    let invalidCoordinates = 0;

    for (let i = 0; i < count; i++) {
      const lat = finiteNumber(latitudes[i]);
      const lon = finiteNumber(longitudes[i]);

      if (
        lat === null ||
        lon === null ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      ) {
        invalidCoordinates++;
        continue;
      }

      const energy = energies && i < energies.length
        ? finiteNumber(energies[i])
        : null;

      const timeOffset = flashTimeOffsets && i < flashTimeOffsets.length
        ? finiteNumber(flashTimeOffsets[i])
        : null;
      const flashDate = timeOffset === null
        ? fileInfo.time
        : new Date(fileInfo.time.getTime() + timeOffset * 1000);
      const time = flashDate.toISOString();

      features.push({
        type: 'Feature',
        id: `${fileInfo.key}:${i}`,
        geometry: {
          type: 'Point',
          coordinates: [lon, lat]
        },
        properties: {
          id: `${fileInfo.key}:${i}`,
          flash_id: `${fileInfo.key}:${i}`,
          type: 'flash',
          source: 'NOAA GOES-19 GLM',
          product: GLM_PRODUCT,
          time,
          timestamp: time,
          flash_time: time,
          time_utc: time,
          ...(energy === null ? {} : {
            energy_j: energy,
            energy
          })
        }
      });
    }

    return {
      features,
      records_read: count,
      invalid_coordinates: invalidCoordinates,
      error: null
    };

  } catch (error) {
    console.warn(
      `[CLOUDGOD] Falha ao decodificar ${fileInfo.key}:`,
      error?.stack || error
    );

    return {
      features: [],
      records_read: 0,
      invalid_coordinates: 0,
      error: error?.message || 'Erro desconhecido ao decodificar NetCDF4/HDF5.'
    };

  } finally {
    if (dataset?.close) {
      try {
        await dataset.close();
      } catch (_error) {}
    }

    if (tempPath) {
      try {
        await fs.unlink(tempPath);
      } catch (_error) {}
    }
  }
}
async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = next++;

        if (index >= items.length) return;

        output[index] = await mapper(items[index]);
      }
    }
  );

  await Promise.all(workers);
  return output;
}

// Endpoint: /api/lightning?satellite=19&minutes=10
app.get('/api/lightning', async (req, res) => {
  if (!applyCors(req, res)) {
    return res.status(403).json({
      error: 'Origem não autorizada.'
    });
  }

  setApiHeaders(res);

  const satellite = Number.parseInt(req.query.satellite ?? '19', 10);
  const minutes = Number.parseInt(req.query.minutes ?? '10', 10);

  if (satellite !== 19) {
    return res.status(400).json({
      error: 'Somente GOES-19 está configurado.'
    });
  }

  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_LIGHTNING_MINUTES
  ) {
    return res.status(400).json({
      error: `O intervalo deve ser de 1 a ${MAX_LIGHTNING_MINUTES} minutos.`
    });
  }

  const endTime = new Date(Date.now() - 30000);
  const startTime = new Date(
    endTime.getTime() - minutes * 60000
  );

  try {
    const files = await listGlmFiles(startTime, endTime);

    const decoded = await mapWithConcurrency(
      files,
      3,
      decodeGlmFile
    );

    const features = decoded.flatMap(
      (result) => result.features || []
    );

    const decodeErrors = decoded.filter(
      (result) => result.error
    );

    const recordsRead = decoded.reduce(
      (sum, result) => sum + (result.records_read || 0),
      0
    );

    const invalidCoordinates = decoded.reduce(
      (sum, result) => sum + (result.invalid_coordinates || 0),
      0
    );

    return res.status(200).json({
      type: 'FeatureCollection',
      features,

      metadata: {
        satellite: 19,
        instrument: 'GLM',
        product: GLM_PRODUCT,

        window_minutes: minutes,

        start_utc: startTime.toISOString(),
        end_utc: endTime.toISOString(),

        files_found: files.length,
        successful_files: decoded.length - decodeErrors.length,

        decode_errors: decodeErrors.length,
        decode_error_details: decodeErrors
          .slice(0, 5)
          .map((result) => result.error),

        records_read: recordsRead,
        invalid_coordinates: invalidCoordinates,

        flashes_found: features.length,

        source: 'NOAA Open Data on AWS',
        status: files.length === 0
          ? 'no_files_in_time_window'
          : features.length === 0
            ? (decodeErrors.length ? 'decode_failed' : 'no_flashes_detected')
            : 'ok'
      }
    });

  } catch (error) {
    console.error(
      '[CLOUDGOD] Erro na API de raios:',
      error
    );

    return res.status(502).json({
      error: 'Não foi possível consultar os dados GOES-19 GLM da NOAA.',
      detail: error?.name === 'AbortError'
        ? 'noaa_timeout'
        : 'noaa_glm_upstream_failed'
    });
  }
});

// Rota não encontrada
app.use((req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada.'
  });
});

// Inicialização
app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `CLOUDGOD CPTEC + NOAA GLM + ECMWF HRES Temperature ativo na porta ${PORT}`
  );
});