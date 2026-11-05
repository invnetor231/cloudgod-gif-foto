const express = require('express');
const path = require('path');

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

app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CLOUDGOD ativo na porta ${PORT}`);
});
