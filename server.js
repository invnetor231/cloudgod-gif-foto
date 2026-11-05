const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = __dirname;

app.disable('x-powered-by');
app.use(express.static(ROOT, { index: false, etag: true, maxAge: '1h' }));

// Proxy restrito aos domínios oficiais da REDEMET/DECEA.
// O browser recebe a imagem no mesmo domínio do CLOUDGOD, permitindo PNG/GIF.
app.get('/api/radar-image', async (req, res) => {
  let target;
  try {
    target = new URL(String(req.query.url || ''));
  } catch {
    return res.status(400).json({ error: 'URL de imagem inválida.' });
  }

  const host = target.hostname.toLowerCase();
  const allowed = host === 'api-redemet.decea.mil.br' || host.endsWith('.decea.mil.br');
  if (target.protocol !== 'https:' || !allowed) {
    return res.status(403).json({ error: 'Domínio de imagem não autorizado.' });
  }

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
      headers: {
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': 'CLOUDGOD-Radar/1.0'
      }
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `REDEMET respondeu HTTP ${upstream.status}.` });
    }

    const finalUrl = new URL(upstream.url || target.href);
    if (finalUrl.protocol !== 'https:' || !(finalUrl.hostname === 'api-redemet.decea.mil.br' || finalUrl.hostname.endsWith('.decea.mil.br'))) {
      return res.status(403).json({ error: 'Redirecionamento externo bloqueado.' });
    }

    const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'application/octet-stream'].includes(contentType)) {
      return res.status(502).json({ error: `A origem não retornou um raster de imagem (${contentType || 'tipo desconhecido'}).` });
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) {
      return res.status(502).json({ error: 'Imagem vazia ou maior que o limite de 25 MB.' });
    }

    res.set({
      'Content-Type': contentType === 'application/octet-stream' ? 'image/png' : contentType,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'public, max-age=90',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.status(200).send(bytes);
  } catch (error) {
    const timeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return res.status(timeout ? 504 : 502).json({
      error: timeout ? 'Tempo esgotado ao buscar a imagem na REDEMET.' : `Falha no proxy REDEMET: ${error.message}`
    });
  }
});


// GOES-19 GLM: consulta arquivos oficiais NetCDF4 no bucket público da NOAA.
// Cada arquivo contém aproximadamente 20 segundos de detecções.
let h5wasmPromise = null;
let lightningCache = { key: '', expires: 0, body: null };

function utcYearDayHour(date) {
  const year = date.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const day = Math.floor((Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - jan1) / 86400000) + 1;
  return `${year}/${String(day).padStart(3, '0')}/${String(date.getUTCHours()).padStart(2, '0')}/`;
}

function glmStartTime(key) {
  const match = key.match(/_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  const [, y, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(Number(y), 0, 1));
  date.setUTCDate(Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  return date;
}

async function listGlmFiles(start, end) {
  const bucket = 'https://noaa-goes19.s3.amazonaws.com/';
  const prefixes = new Set();
  const cursor = new Date(start);
  cursor.setUTCMinutes(0, 0, 0);
  while (cursor <= end) {
    prefixes.add(utcYearDayHour(cursor));
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  const keys = [];
  for (const prefix of prefixes) {
    const url = new URL(bucket);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', `GLM-L2-LCFA/${prefix}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`NOAA S3 respondeu HTTP ${response.status} ao listar GLM.`);
    const xml = await response.text();
    for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const key = match[1].replaceAll('&amp;', '&');
      const stamp = glmStartTime(key);
      if (stamp && stamp >= start && stamp <= end && key.endsWith('.nc')) keys.push({ key, stamp });
    }
  }
  return keys.sort((a, b) => a.stamp - b.stamp).slice(-45);
}

async function readGlmFile(key) {
  if (!h5wasmPromise) h5wasmPromise = import('h5wasm/node').then(async mod => {
    await mod.ready;
    return mod;
  });
  const h5wasm = await h5wasmPromise;
  const response = await fetch(`https://noaa-goes19.s3.amazonaws.com/${key}`, {
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Falha ao baixar arquivo GLM: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) return [];

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-'));
  const filename = path.join(dir, 'glm.nc');
  let file;
  try {
    await fs.writeFile(filename, bytes);
    file = new h5wasm.File(filename, 'r');
    const read = name => {
      const dataset = file.get(name);
      return dataset && dataset.value != null ? Array.from(dataset.value) : [];
    };
    const latitudes = read('flash_lat');
    const longitudes = read('flash_lon');
    const energies = read('flash_energy');
    const offsets = read('flash_time_offset');
    const ids = read('flash_id');
    const base = glmStartTime(key)?.getTime() ?? Date.now();
    const output = [];
    const count = Math.min(latitudes.length, longitudes.length);
    for (let i = 0; i < count; i++) {
      const lat = Number(latitudes[i]);
      const lon = Number(longitudes[i]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const energy = Number(energies[i]);
      const offset = Number(offsets[i]);
      output.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          id: ids[i] == null ? `${key}:${i}` : String(ids[i]),
          flash_energy: Number.isFinite(energy) ? energy : null,
          time: new Date(base + (Number.isFinite(offset) ? offset * 1000 : 0)).toISOString(),
          satellite: 'GOES-19'
        }
      });
    }
    return output;
  } finally {
    try { file?.close(); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  }
}

app.get('/api/lightning', async (req, res) => {
  const minutes = Math.max(1, Math.min(30, Number.parseInt(req.query.minutes, 10) || 10));
  const satellite = String(req.query.satellite || '19');
  if (satellite !== '19') {
    return res.status(400).json({ error: 'Esta rota está configurada para o satélite GOES-19.' });
  }

  const end = new Date(Date.now() - 30 * 1000); // margem para o arquivo mais recente terminar de ser publicado
  const start = new Date(end.getTime() - minutes * 60 * 1000);
  const cacheKey = `${satellite}:${minutes}`;
  if (lightningCache.key === cacheKey && lightningCache.expires > Date.now()) {
    return res.json(lightningCache.body);
  }

  try {
    const files = await listGlmFiles(start, end);
    const features = [];
    // Limita concorrência para não sobrecarregar o serviço público nem o Render.
    for (let i = 0; i < files.length; i += 3) {
      const batch = files.slice(i, i + 3);
      const results = await Promise.all(batch.map(item => readGlmFile(item.key)));
      for (const result of results) features.push(...result);
    }
    const body = {
      type: 'FeatureCollection',
      features,
      metadata: {
        source: 'NOAA GOES-19 GLM-L2-LCFA',
        interval_minutes: minutes,
        files_read: files.length,
        generated_at: new Date().toISOString()
      }
    };
    lightningCache = { key: cacheKey, expires: Date.now() + 20000, body };
    res.set('Cache-Control', 'no-store');
    return res.json(body);
  } catch (error) {
    console.error('GLM lightning endpoint:', error);
    return res.status(502).json({
      error: 'Não foi possível obter os dados oficiais GOES-19 GLM agora.',
      detail: error.message
    });
  }
});


app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CLOUDGOD ativo na porta ${PORT}`);
});
