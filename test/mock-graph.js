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
  // Template names Meta should refuse as "does not exist" — how a template
  // that is still in review (or paused) behaves when the bot tries to use it.
  const failTemplates = new Set();

  app.post('/v19.0/:phoneId/messages', (req, res) => {
    const b = req.body;
    if (b.type === 'template' && failTemplates.has(b.template?.name)) {
      console.log(`[mock] ✗ template ${b.template.name} → ${b.to} refused (132001)`);
      return res.status(400).json({
        error: {
          message: '(#132001) Template name does not exist in the translation',
          type: 'OAuthException',
          code: 132001,
        },
      });
    }
    let summary = '';
    if (b.type === 'text') summary = b.text?.body ?? '';
    else if (b.type === 'template') summary = `template:${b.template?.name} params:${JSON.stringify(b.template?.components)}`;
    else if (b.type === 'document') summary = `document:${b.document?.filename} caption:${b.document?.caption}`;
    else if (b.type === 'interactive') {
      const act = b.interactive?.action;
      const rows = act?.sections?.flatMap((sec) => sec.rows ?? []);
      const choices = rows
        ? rows.map((r) => ({ id: r.id, title: r.title }))
        : act?.buttons?.map((x) => x.reply);
      summary = `${b.interactive?.type}:${JSON.stringify(choices)} body:${b.interactive?.body?.text}`;
    }
    const wamid = `wamid.MOCK${++wamidCounter}`;
    sent.push({ to: b.to, type: b.type, summary, wamid, raw: b, phoneId: req.params.phoneId });
    console.log(`[mock] (phone ${req.params.phoneId}) → ${b.to} [${b.type}] ${summary.slice(0, 90)}`);
    res.json({ messaging_product: 'whatsapp', messages: [{ id: wamid }] });
  });

  // Media upload (report PDFs). Multipart body is irrelevant to the assertions,
  // so it is accepted wholesale and answered with a fixed id.
  const uploads = [];
  app.post('/v19.0/:phoneId/media', (req, res) => {
    let bytes = 0;
    req.on('data', (c) => (bytes += c.length));
    req.on('end', () => {
      uploads.push({ phoneId: req.params.phoneId, bytes });
      console.log(`[mock] media upload (${bytes} bytes)`);
      res.json({ id: `MEDIA_UPLOAD_${uploads.length}` });
    });
  });

  // Media metadata + binary (owner order screenshot)
  app.get('/media/test.png', (_req, res) => {
    res.type('image/png').send(fs.readFileSync(path.join(__dirname, 'fixtures', 'test.png')));
  });
  app.get('/v19.0/:mediaId', (req, res) => {
    res.json({ url: `http://127.0.0.1:${port}/media/test.png`, mime_type: 'image/png', id: req.params.mediaId });
  });

  const server = app.listen(port);
  return { sent, uploads, server, failTemplates };
}

module.exports = { start };
