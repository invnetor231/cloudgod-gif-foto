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

function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'CLOUDGOD CPTEC + NOAA GLM', apis: ['/api/cptec', '/api/lightning'] });
});

app.options(['/api/cptec', '/api/lightning'], (req, res) => {
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

        const stamp = key.match(/_s(\d{13})/);
        if (!stamp) continue;

        const year = Number(stamp[1].slice(0, 4));
        const day = Number(stamp[1].slice(4, 7));
        const hh = Number(stamp[1].slice(7, 9));
        const mm = Number(stamp[1].slice(9, 11));
        const ss = Number(stamp[1].slice(11, 13));

        // O campo DDD do nome NOAA é o dia do ano (001–366), não o dia do mês.
        // Converter a partir de 1º de janeiro evita descartar todos os arquivos recentes.
        const fileTime = new Date(
          Date.UTC(year, 0, 1, hh, mm, ss) + (day - 1) * 86400000
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

async function getNetcdfDataset(filePath) {
  // NOAA GLM-L2-LCFA é NetCDF-4/HDF5. netcdf4-wasm usado anteriormente
  // não abria corretamente esses arquivos no ambiente Node do serviço.
  if (!h5wasmModulePromise) {
    h5wasmModulePromise = import('h5wasm/node')
      .then(async (module) => {
        await module.ready;
        return module;
      })
      .catch((error) => {
        h5wasmModulePromise = null;
        throw new Error(
          `Não foi possível carregar h5wasm. Instale a dependência "h5wasm". Detalhe: ${error.message}`
        );
      });
  }

  const module = await h5wasmModulePromise;
  const H5File = module.File || module.default?.File;
  if (typeof H5File !== 'function') {
    throw new Error('h5wasm não disponibilizou a classe File.');
  }

  const file = new H5File(filePath, 'r');
  if (typeof file.get !== 'function') {
    try { file.close?.(); } catch (_error) {}
    throw new Error('O arquivo HDF5 foi aberto, mas a API de leitura não está disponível.');
  }

  return file;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstNumeric(value, fallback) {
  const values = normalizeH5Value(value)
    .map(finiteNumber)
    .filter((number) => number !== null);
  return values.length ? values[0] : fallback;
}

async function getVariableAttribute(variable, name) {
  if (!variable) return null;

  // h5wasm expõe atributos HDF5 no objeto attrs. Mantemos alternativas
  // para compatibilidade com diferentes versões da biblioteca.
  try {
    const attrs = variable.attrs;
    if (attrs && Object.prototype.hasOwnProperty.call(attrs, name)) {
      const value = attrs[name];
      if (value !== undefined && value !== null) return value;
    }
  } catch (_error) {}

  try {
    const metadata = variable.metadata;
    if (metadata?.attributes &&
        Object.prototype.hasOwnProperty.call(metadata.attributes, name)) {
      return metadata.attributes[name];
    }
  } catch (_error) {}

  try {
    if (typeof variable.getAttr === 'function') {
      const value = await variable.getAttr(name);
      if (value !== undefined && value !== null) return value;
    }
  } catch (_error) {}

  return null;
}

function normalizeH5Value(value) {
  if (value === undefined || value === null) return [];
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.flat(Infinity);
  return [value];
}

async function unpackVariable(variable) {
  if (!variable) return [];

  // Em h5wasm, Dataset.value contém os valores lidos do dataset.
  // Algumas versões/formatos também disponibilizam to_array().
  let raw;
  try {
    raw = variable.value;
    if (raw === undefined && typeof variable.to_array === 'function') {
      raw = variable.to_array();
    }
    if (raw === undefined && typeof variable.getValue === 'function') {
      raw = await variable.getValue();
    }
  } catch (error) {
    throw new Error(`Falha ao ler dataset ${variable.path || ''}: ${error.message}`);
  }

  const rawValues = normalizeH5Value(raw);
  const scale = firstNumeric(await getVariableAttribute(variable, 'scale_factor'), 1);
  const offset = firstNumeric(await getVariableAttribute(variable, 'add_offset'), 0);
  const fill = await getVariableAttribute(variable, '_FillValue');
  const missing = await getVariableAttribute(variable, 'missing_value');

  const fillValues = [fill, missing]
    .flatMap(normalizeH5Value)
    .map(finiteNumber)
    .filter((value) => value !== null);

  return rawValues.map((item) => {
    const packed = finiteNumber(item);
    if (packed === null || fillValues.includes(packed)) return null;
    return packed * scale + offset;
  });
}

function getGlmVariable(dataset, name) {
  // GLM-L2-LCFA normalmente armazena os datasets na raiz.
  // O segundo caminho cobre arquivos que os agrupem em /.
  return dataset.get(name) || dataset.get(`/${name}`) || null;
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
    dataset = await getNetcdfDataset(tempPath);

    const latVar = getGlmVariable(dataset, 'flash_lat');
    const lonVar = getGlmVariable(dataset, 'flash_lon');

    if (!latVar || !lonVar) {
      throw new Error('O NetCDF não contém flash_lat e/ou flash_lon.');
    }

    const energyVar = getGlmVariable(dataset, 'flash_energy');
    const flashTimeVar = getGlmVariable(dataset, 'flash_time_offset_of_first_event');

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
      error: error?.message || 'Erro desconhecido ao decodificar NetCDF.'
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

        source: 'NOAA Open Data on AWS'
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
    `CLOUDGOD CPTEC + NOAA GLM ativo na porta ${PORT}`
  );
});