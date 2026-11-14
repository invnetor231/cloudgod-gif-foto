'use strict';

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const CPTEC_BASE = 'https://nowcasting.cptec.inpe.br/api/v1';
const ALLOWED_ORIGIN = process.env.CLOUDGOD_ORIGIN || 'https://cloudgod-gif-foto.onrender.com';

app.disable('x-powered-by');
app.set('trust proxy', 1);

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

// Proxy fechado: permite apenas instantes e legendas dos caminhos de radar CPTEC.
app.get('/api/cptec', async (req, res) => {
  if (!applyCors(req, res)) {
    return res.status(403).json({ error: 'Origem não autorizada.' });
  }

  const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
  const match = requestedPath.match(/^\/paths\/radar\/layers\/([a-z0-9~_-]+)\/(times|legend)(?:\?[^#]*)?$/i);

  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });

  if (!match) {
    return res.status(400).json({ error: 'Caminho CPTEC inválido ou não permitido.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const upstream = await fetch(CPTEC_BASE + requestedPath, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'CLOUDGOD-CPTEC-Proxy/1.0'
      },
      signal: controller.signal,
      cache: 'no-store'
    });

    const body = await upstream.text();
    if (!upstream.ok) {
      return res.status(502).json({
        error: `O CPTEC respondeu HTTP ${upstream.status}.`,
        upstreamStatus: upstream.status
      });
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch (_error) {
      return res.status(502).json({ error: 'O CPTEC retornou uma resposta que não é JSON válido.' });
    }

    return res.status(200).json(data);
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return res.status(502).json({
      error: timedOut
        ? 'Tempo limite ao consultar o CPTEC (20 segundos).'
        : 'Não foi possível conectar ao serviço do CPTEC.',
      detail: timedOut ? 'upstream_timeout' : 'upstream_connection_failed'
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CLOUDGOD CPTEC proxy ativo na porta ${PORT}`);
});
