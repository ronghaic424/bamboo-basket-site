import http from 'node:http';
import worker from './worker/index.js';
const server = http.createServer(async (req, res) => {
  try {
    const origin = `http://${req.headers.host}`;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(origin + req.url, { method: req.method, headers: req.headers, body: ['GET','HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const response = await worker.fetch(request, {}, {});
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
server.listen(4173, '127.0.0.1', () => console.log('Preview running at http://127.0.0.1:4173'));
