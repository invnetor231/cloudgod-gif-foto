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
  res.json({ ok: true, service: 'CLOUDGOD CPTEC + NOAA GLM (h5wasm)', apis: ['/api/cptec', '/api/lightning', '/api/radar-image'] });
});

app.options(['/api/cptec', '/api/lightning', '/api/radar-image'], (req, res) => {
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
    `CLOUDGOD CPTEC + NOAA GLM (h5wasm) ativo na porta ${PORT}`
  );
});