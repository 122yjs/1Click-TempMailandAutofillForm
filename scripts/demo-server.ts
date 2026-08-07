import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

const PORT = Number.parseInt(process.env.DEMO_PORT || '5173', 10);
const DEMO_DIR = join(process.cwd(), 'demo');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  // CORS headers for extension testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const rawPath = req.url?.split('?')[0] || '/';
  let relativePath = rawPath.replace(/^\/demo\//, '/').replace(/^\//, '');

  if (!relativePath || relativePath === 'index.html') {
    relativePath = 'signup-social.html';
  }

  const filePath = join(DEMO_DIR, relativePath);

  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath);
      const ext = extname(filePath);
      const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mimeType });
      res.end(content);
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Internal Server Error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

server.listen(PORT, () => {
  console.log(`[DemoServer] Serving demo showcase pages on http://localhost:${PORT}/demo/`);
});
