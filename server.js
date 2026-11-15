'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CPTEC_BASE = 'https://nowcasting.cptec.inpe.br/api/v1';
const ALLOWED_ORIGIN = process.env.CLOUDGOD_ORIGIN || 'https://cloudgod-gif-foto.onrender.com';

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Servir a interface principal no mesmo serviço que fornece a API CPTEC.
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

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'CLOUDGOD CPTEC proxy' });
});

app.options('/api/cptec', (req, res) => {
  if (!applyCors(req, res)) return res.status(403).end();
  return res.status(204).end();
});

// Proxy de imagens REDEMET: serve o raster no mesmo domínio do site.
// Isso permite que Leaflet, html2canvas e o exportador GIF leiam os pixels.
app.options('/api/radar-image', (req, res) => {
  if (!applyCors(req, res)) return res.status(403).end();
  return res.status(204).end();
});

app.get('/api/radar-image', async (req, res) => {
  if (!applyCors(req, res)) {
    return res.status(403).json({ error: 'Origem não autorizada.' });
  }

  let target;
  try {
    target = new URL(typeof req.query.url === 'string' ? req.query.url : '');
  } catch (_error) {
    return res.status(400).json({ error: 'URL da imagem REDEMET inválida.' });
  }

  // Evita transformar o proxy em um serviço aberto de acesso a URLs arbitrárias.
  if (
    target.protocol !== 'https:' ||
    target.hostname.toLowerCase() !== 'api-redemet.decea.mil.br' ||
    target.username ||
    target.password
  ) {
    return res.status(403).json({ error: 'Somente imagens oficiais da API REDEMET são permitidas.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const upstream = await fetch(target.href, {
      method: 'GET',
      headers: {
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': 'CLOUDGOD-REDEMET-Image-Proxy/1.0'
      },
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'follow'
    });

    if (!upstream.ok) {
      return res.status(502).json({
        error: `A REDEMET respondeu HTTP ${upstream.status}.`,
        upstreamStatus: upstream.status
      });
    }

    const finalUrl = new URL(upstream.url || target.href);
    if (
      finalUrl.protocol !== 'https:' ||
      finalUrl.hostname.toLowerCase() !== 'api-redemet.decea.mil.br'
    ) {
      return res.status(502).json({ error: 'A REDEMET redirecionou para um domínio não autorizado.' });
    }

    const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
      return res.status(502).json({
        error: 'A REDEMET não retornou um arquivo de imagem.',
        upstreamContentType: contentType || 'desconhecido'
      });
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
      return res.status(502).json({ error: 'Imagem vazia ou maior que o limite de 20 MB.' });
    }

    res.set({
      'Content-Type': contentType,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.status(200).send(bytes);
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return res.status(502).json({
      error: timedOut
        ? 'Tempo limite ao baixar a imagem REDEMET (25 segundos).'
        : 'Não foi possível baixar a imagem oficial da REDEMET.',
      detail: timedOut ? 'upstream_timeout' : 'upstream_connection_failed'
    });
  } finally {
    clearTimeout(timeout);
  }
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
