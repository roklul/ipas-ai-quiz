// 輕量本機伺服器：提供靜態檔案伺服 + Notion API 跨域轉發 (Proxy)
// 執行方式：node server.mjs [port] （預設 port 8000）
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = parseInt(process.env.PORT || process.argv[2] || '8000', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  // CORS 處理：嚴格限制僅允許本機 localhost / 127.0.0.1 來源
  const origin = req.headers.origin;
  const isAllowedOrigin = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

  if (origin && isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Notion-Version');

  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  // 0. 本機進度檔案持久化 (/local-progress) — 防止瀏覽器清除快取、無痕視窗或不同瀏覽器導致進度消失
  const progressFilePath = path.join(__dirname, 'local-progress.json');
  if (req.url === '/local-progress' || req.url.startsWith('/local-progress?')) {
    if (!isAllowedOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden_origin' }));
      return;
    }
    if (req.method === 'GET') {
      try {
        if (fs.existsSync(progressFilePath)) {
          const data = fs.readFileSync(progressFilePath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(data);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        try {
          const bodyStr = Buffer.concat(chunks).toString('utf8');
          const parsed = JSON.parse(bodyStr);
          if (parsed && parsed.q) {
            fs.writeFileSync(progressFilePath, JSON.stringify(parsed, null, 2), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'invalid_store' }));
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // 1. Notion API 代理 (/notion/* -> https://api.notion.com/v1/*)
  if (req.url.startsWith('/notion/')) {
    const targetPath = req.url.replace(/^\/notion\//, '');
    const notionUrl = `https://api.notion.com/v1/${targetPath}`;
    
    // 收集請求 Body
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = {
        'Notion-Version': req.headers['notion-version'] || '2022-06-28',
        'Content-Type': 'application/json',
      };
      if (req.headers['authorization']) {
        headers['Authorization'] = req.headers['authorization'];
      }

      try {
        const notionRes = await fetch(notionUrl, {
          method: req.method,
          headers,
          body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
        });

        const notionHeaders = {
          'Content-Type': notionRes.headers.get('content-type') || 'application/json',
        };
        if (origin && isAllowedOrigin) {
          notionHeaders['Access-Control-Allow-Origin'] = origin;
        }
        res.writeHead(notionRes.status, notionHeaders);
        const resBuf = Buffer.from(await notionRes.arrayBuffer());
        res.end(resBuf);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'notion_proxy_error', message: err.message }));
      }
    });
    return;
  }

  // 2. 靜態檔案伺服
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
  const filePath = path.join(__dirname, reqPath);

  // 安全性防目錄穿越
  const relToRoot = path.relative(__dirname, filePath);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot) || path.basename(filePath) === 'local-progress.json') {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`iPAS AI 題庫伺服器啟動於: http://127.0.0.1:${PORT}`);
  console.log(`內建 Notion 轉發代理: http://127.0.0.1:${PORT}/notion`);
});
