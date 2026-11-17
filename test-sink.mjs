// Local sink: pretends to be the Feishu webhook so poll.mjs can be tested
// end to end without posting to the real group.
import http from 'node:http';

const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (b) => (body += b));
  req.on('end', () => {
    try {
      received.push(JSON.parse(body));
    } catch {
      received.push({ raw: body });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, msg: 'success' }));
  });
});

server.listen(4600, '127.0.0.1', () => console.log('sink ready on 4600'));

process.on('SIGINT', () => {
  console.log(JSON.stringify(received, null, 2));
  server.close(() => process.exit(0));
});

setTimeout(() => {
  console.log(JSON.stringify(received, null, 2));
  server.close(() => process.exit(0));
}, 30_000).unref();
