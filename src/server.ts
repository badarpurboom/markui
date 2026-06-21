import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3001;
const FILE_PATH = path.join(process.cwd(), 'markui.json');

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/annotations') {
    let body = '';
    req.on('data', (chunk: any) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        fs.writeFileSync(FILE_PATH, body, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, path: FILE_PATH }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`[markui] Local workspace sync server running on http://localhost:${PORT}`);
  console.log(`[markui] Annotations will be saved to: ${FILE_PATH}`);
});
