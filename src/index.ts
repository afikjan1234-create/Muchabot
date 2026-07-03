import axios from 'axios';
import express, { Request, Response } from 'express';
import path from 'path';
import { config } from './config';
import { startScheduler } from './scheduler';
import { handleOwnerImage, handleOwnerText, handleCustomerMessage } from './handler';
import { getActiveFeedbackByPhone, getOrgByOwnerPhone } from './db';
import { sendTextMessage, credentialsFor } from './whatsapp';
import { adminRouter } from './admin';

const app = express();
app.use(express.json());

// Admin dashboard (static page + API)
app.use(express.static(path.join(process.cwd(), 'public')));
app.use('/api', adminRouter);
app.get('/admin', (_req, res) => res.sendFile(path.join(process.cwd(), 'public', 'admin.html')));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Meta webhook verification ──────────────────────────────────────────────

app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.webhookVerifyToken) {
    console.log('[webhook] Verified by Meta');
    return res.status(200).send(challenge);
  }
  console.log('[webhook] Verification failed. Token mismatch.');
  return res.sendStatus(403);
});

// ─── Inbound messages ───────────────────────────────────────────────────────

async function processMessage(message: any): Promise<void> {
  const from: string = message.from;

  // Button/interactive replies are always answers to a feedback template —
  // route them through the customer flow even if the sender is an org phone
  // (lets owners demo/test the full flow on their own phone).
  const isTemplateReply = message.type === 'button' || message.type === 'interactive';

  // Restaurant owner/staff? (their phone is registered to an org)
  const org = isTemplateReply ? null : await getOrgByOwnerPhone(from);
  if (org) {
    const creds = credentialsFor(org);
    if (message.type === 'image') {
      const reply = await handleOwnerImage(org, from, message.image.id, message.image?.caption ?? null);
      await sendTextMessage(creds, from, reply);
    } else if (message.type === 'text') {
      // If the bot just asked THIS phone "what happened?" as a customer
      // (an owner testing the flow on their own number), the next text is
      // the complaint — not an owner command.
      const asCustomer = await getActiveFeedbackByPhone(from);
      if (asCustomer?.conversationState === 'waiting_reason') {
        await handleCustomerMessage(from, message.text.body, null);
        return;
      }
      const reply = await handleOwnerText(org, from, message.text.body);
      await sendTextMessage(creds, from, reply);
    } else {
      await sendTextMessage(creds, from, 'שלח תמונה של פרטי ההזמנה או מספר טלפון כטקסט 🙂');
    }
    return;
  }

  // Customer: extract the button payload / text + reply context (wamid)
  let payload = '';
  if (message.type === 'button') {
    payload = message.button?.payload ?? message.button?.text ?? '';
  } else if (message.type === 'interactive') {
    payload =
      message.interactive?.button_reply?.id ??
      message.interactive?.list_reply?.id ??
      '';
    // Button titles are more human-readable for complaint forwarding
    const title = message.interactive?.button_reply?.title;
    if (title) payload = `${payload} ${title}`;
  } else if (message.type === 'text') {
    payload = message.text?.body ?? '';
  }

  const contextWamid: string | null = message.context?.id ?? null;
  if (payload) {
    await handleCustomerMessage(from, payload, contextWamid);
  }
}

app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200); // ack immediately — Meta requires a fast response

  void (async () => {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          try {
            await processMessage(message);
          } catch (err) {
            console.error('[webhook] Error processing message:', err);
          }
        }
      }
    }
  })();
});

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
  console.log(`Admin dashboard: http://localhost:${config.port}/admin`);
  void startScheduler();

  // Render's free tier spins services down after 15 idle minutes, which
  // would freeze the scheduler. Pinging our own public URL through Render's
  // edge counts as traffic and keeps the instance awake.
  // RENDER_EXTERNAL_URL is injected automatically by Render.
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (externalUrl) {
    setInterval(() => {
      axios.get(`${externalUrl}/health`, { timeout: 30000 }).catch(() => {});
    }, 5 * 60_000);
    console.log(`[keepalive] Self-ping enabled for ${externalUrl}`);
  }
});
