import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'release');
const PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const safeRel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let candidate = join(ROOT_DIR, safeRel === '/' ? 'index.html' : safeRel);

  if (!existsSync(candidate) || statSync(candidate).isDirectory()) {
    candidate = join(ROOT_DIR, 'index.html');
  }

  const ext = extname(candidate).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(candidate).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Conversor de Extratos publicado e ativo em http://0.0.0.0:${PORT}`);
});
