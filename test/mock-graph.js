// Mock WhatsApp Graph API server for local E2E testing.
// Records every outbound message so tests can assert on them.
const express = require('express');
const fs = require('fs');
const path = require('path');

function start(port) {
  const app = express();
  app.use(express.json());

  const sent = []; // { to, type, summary, raw }
  let wamidCounter = 0;

  app.post('/v19.0/:phoneId/messages', (req, res) => {
    const b = req.body;
    let summary = '';
    if (b.type === 'text') summary = b.text?.body ?? '';
    else if (b.type === 'template') summary = `template:${b.template?.name} params:${JSON.stringify(b.template?.components)}`;
    else if (b.type === 'interactive') summary = `buttons:${JSON.stringify(b.interactive?.action?.buttons?.map((x) => x.reply))} body:${b.interactive?.body?.text}`;
    const wamid = `wamid.MOCK${++wamidCounter}`;
    sent.push({ to: b.to, type: b.type, summary, wamid, raw: b, phoneId: req.params.phoneId });
    console.log(`[mock] (phone ${req.params.phoneId}) → ${b.to} [${b.type}] ${summary.slice(0, 90)}`);
    res.json({ messaging_product: 'whatsapp', messages: [{ id: wamid }] });
  });

  // Media metadata + binary (owner order screenshot)
  app.get('/media/test.png', (_req, res) => {
    res.type('image/png').send(fs.readFileSync(path.join(__dirname, 'fixtures', 'test.png')));
  });
  app.get('/v19.0/:mediaId', (req, res) => {
    res.json({ url: `http://127.0.0.1:${port}/media/test.png`, mime_type: 'image/png', id: req.params.mediaId });
  });

  const server = app.listen(port);
  return { sent, server };
}

module.exports = { start };
