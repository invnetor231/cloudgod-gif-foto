'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CPTEC_BASE = 'https://nowcasting.cptec.inpe.br/api/v1';
const ALLOWED_ORIGIN = process.env.CLOUDGOD_ORIGIN || 'https://cloudgod-gif-foto.onrender.com';
const REQUEST_TIMEOUT_MS = 25000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Only the radar layers configured in CLOUDGOD may be requested.
const ALLOWED_LAYERS = new Set([
  'inea~macae~cappi~cappi3km',
  'sdcsc~ararangua~cappi~cappi3km',
  'decea~gama~cappi~cappi3km',
  'decea~morroigreja~cappi~cappi3km',
  'decea~picocouto~cappi~cappi3km'
]);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'), (error) => {
    if (error && !res.headersSent) {
      res.status(500).type('text/plain').send(
        'NÃ£o foi possÃ­vel carregar o index.html. Verifique se ele estÃ¡ na raiz do serviÃ§o.'
      );
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

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'CLOUDGOD CPTEC proxy' });
});

app.options('/api/cptec', (req, res) => {
  if (!applyCors(req, res)) return res.status(403).end();
  return res.status(204).end();
});

function imageTypeFromBytes(bytes, upstreamType) {
  const type = (upstreamType || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/png' || (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) return 'image/png';
  if (type === 'image/jpeg' || (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return 'image/jpeg';
  if (type === 'image/webp' || (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')) return 'image/webp';
  return null;
}

// Restricted proxy for radar metadata (times/legend) and complete CAPPI frames.
app.get('/api/cptec', async (req, res) => {
  if (!applyCors(req, res)) {
    return res.status(403).json({ error: 'Origem nÃ£o autorizada.' });
  }

  const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
  const metadataMatch = requestedPath.match(
    /^\/paths\/radar\/layers\/([a-z0-9~_-]+)\/(times|legend)$/i
  );
  const frameMatch = requestedPath.match(
    /^\/paths\/frames\/radar\/([a-z0-9~_-]+)\/(20\d{10})\/full$/i
  );
  const layerName = (metadataMatch?.[1] || frameMatch?.[1] || '').toLowerCase();
  const isMetadata = Boolean(metadataMatch && ALLOWED_LAYERS.has(layerName));
  const isFrame = Boolean(frameMatch && ALLOWED_LAYERS.has(layerName));

  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff'
  });

  if (!isMetadata && !isFrame) {
    return res.status(400).json({ error: 'Caminho CPTEC invÃ¡lido ou nÃ£o permitido.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(CPTEC_BASE + requestedPath, {
      method: 'GET',
      headers: {
        Accept: isFrame ? 'image/png,image/jpeg,image/webp,*/*' : 'application/json, text/plain, */*',
        'User-Agent': 'CLOUDGOD-CPTEC-Proxy/1.2'
      },
      signal: controller.signal,
      cache: 'no-store'
    });

    if (!upstream.ok) {
      return res.status(502).json({
        error: `O CPTEC respondeu HTTP ${upstream.status}.`,
        upstreamStatus: upstream.status
      });
    }

    if (isFrame) {
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
        return res.status(502).json({ error: 'Imagem vazia ou maior que o limite de 20 MB.' });
      }
      const contentType = imageTypeFromBytes(bytes, upstream.headers.get('content-type'));
      if (!contentType) {
        return res.status(502).json({ error: 'O CPTEC nÃ£o retornou uma imagem vÃ¡lida.' });
      }
      res.set('Content-Type', contentType);
      res.set('Content-Length', String(bytes.length));
      return res.status(200).send(bytes);
    }

    const body = await upstream.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch (_error) {
      return res.status(502).json({ error: 'O CPTEC retornou uma resposta que nÃ£o Ã© JSON vÃ¡lido.' });
    }
    return res.status(200).json(data);
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return res.status(502).json({
      error: timedOut
        ? 'Tempo limite ao consultar o CPTEC (25 segundos).'
        : 'NÃ£o foi possÃ­vel conectar ao serviÃ§o do CPTEC.',
      detail: timedOut ? 'upstream_timeout' : 'upstream_connection_failed'
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CLOUDGOD CPTEC proxy ativo na porta ${PORT}`);
});
