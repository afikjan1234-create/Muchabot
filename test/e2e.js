// End-to-end test: spawns the bot against a mock Graph API and drives the
// full owner→schedule→send→customer-reply flow through the real webhook.
// Usage: node test/e2e.js
const { spawn } = require('child_process');
const axios = require('axios');
const { start } = require('./mock-graph');

const MOCK_PORT = 4545;
const BOT_PORT = 3210;
const BOT = `http://127.0.0.1:${BOT_PORT}`;
const OWNER = '972500000001';
const CUSTOMER_A = '972500000091';
const CUSTOMER_B = '972500000092';
const ADMIN_KEY = process.env.ADMIN_KEY || 'rfb_admin_9x4Kq2mWv8Tz5Lp1';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 20000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await sleep(everyMs);
  }
  return null;
}

function webhookMessage(msg) {
  return axios.post(`${BOT}/webhook`, {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [msg] } }] }],
  });
}

const ownerImage = (caption) =>
  webhookMessage({ from: OWNER, type: 'image', image: { id: 'MEDIA1', caption } });
const ownerText = (body) => webhookMessage({ from: OWNER, type: 'text', text: { body } });
const customerText = (from, body, ctx) =>
  webhookMessage({ from, type: 'text', text: { body }, ...(ctx ? { context: { id: ctx } } : {}) });
const customerButton = (from, payload, ctx) =>
  webhookMessage({ from, type: 'button', button: { payload, text: payload }, context: { id: ctx } });
const customerInteractive = (from, id, title, ctx) =>
  webhookMessage({
    from,
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id, title } },
    context: { id: ctx },
  });

async function api(method, path, data) {
  const res = await axios({ method, url: `${BOT}/api${path}`, data, headers: { 'x-admin-key': ADMIN_KEY } });
  return res.data;
}

async function main() {
  const mock = start(MOCK_PORT);
  const lastSent = () => mock.sent[mock.sent.length - 1];

  const bot = spawn('node', ['dist/index.js'], {
    env: {
      ...process.env,
      PORT: String(BOT_PORT),
      GRAPH_API_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v19.0`,
      POLL_INTERVAL_MS: '1500',
      ADMIN_KEY,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  try {
    // ── Boot ──
    const healthy = await waitFor(async () => {
      try { return (await axios.get(`${BOT}/health`)).data.status === 'ok'; } catch { return false; }
    }, 15000);
    check('Bot boots and /health responds', healthy);

    // ── Webhook verification ──
    const good = await axios.get(`${BOT}/webhook`, {
      params: { 'hub.mode': 'subscribe', 'hub.verify_token': process.env.WEBHOOK_VERIFY_TOKEN || 'restaurant_bot_2026', 'hub.challenge': 'CHALLENGE_42' },
    });
    check('Webhook verification (correct token)', good.data === 'CHALLENGE_42');
    const bad = await axios.get(`${BOT}/webhook`, {
      params: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong' },
      validateStatus: () => true,
    });
    check('Webhook verification rejects wrong token', bad.status === 403);

    // ── Admin API: create test org ──
    const org = await api('post', '/orgs', {
      name: 'מסעדת בדיקה',
      managerName: 'מנהל בדיקה',
      managerPhone: '0500000002',
      woltRatingUrl: 'https://wolt.com/he/test',
      feedbackDelayMinutes: 0,
      phones: [{ phone: '0500000001', label: 'בעלים' }],
    });
    check('Admin API creates org (phone normalized)', org.id && org.phones?.[0]?.phone === OWNER);

    const unauthorized = await axios.get(`${BOT}/api/orgs`, { validateStatus: () => true });
    check('Admin API rejects missing key', unauthorized.status === 401);

    // ── Scenario A: owner image WITH caption → auto-schedule ──
    mock.sent.length = 0;
    await ownerImage('דנה לוי');
    const confirmA = await waitFor(async () =>
      mock.sent.find((m) => m.to === OWNER && m.summary.includes('נקלט')), 60000);
    check('Owner image + caption → OCR phone + auto-schedule', !!confirmA, confirmA?.summary?.slice(0, 80));

    // Poller should send the template (delay 0)
    const template = await waitFor(async () =>
      mock.sent.find((m) => m.type === 'template'), 20000);
    check('Scheduler sends feedback template', !!template && template.summary.includes('restaurant_ranking'),
      template && `to=${template.to}`);
    check('Template sent to OCR-extracted customer phone', template?.to === '972521234567', `to=${template?.to}`);

    // ── Scenario B: positive button reply (routed by context wamid) ──
    await customerButton('972521234567', 'מעולה! 😊', template.wamid);
    const wolt = await waitFor(async () =>
      mock.sent.find((m) => m.to === '972521234567' && m.summary.includes('wolt.com/he/test')));
    check('Positive reply → Wolt rating link (org-specific URL)', !!wolt);

    // ── Scenario C: owner image WITHOUT caption → asks for name ──
    mock.sent.length = 0;
    await ownerImage(undefined);
    const askName = await waitFor(async () =>
      mock.sent.find((m) => m.to === OWNER && m.summary.includes('מה שם הלקוח')), 60000);
    check('Owner image without name → bot asks for name', !!askName);

    // owner replies with a name — but this schedules for OCR phone again;
    // to target CUSTOMER_A instead, we use the manual text-entry flow later.
    await ownerText('יוסי כהן');
    const confirmC = await waitFor(async () =>
      mock.sent.find((m) => m.to === OWNER && m.summary.includes('נקלט') && m.summary.includes('יוסי כהן')));
    check('Owner provides name → feedback scheduled', !!confirmC);

    const templateC = await waitFor(async () =>
      mock.sent.filter((m) => m.type === 'template').length >= 1 &&
      mock.sent.filter((m) => m.type === 'template').pop(), 20000);
    check('Second template sent', !!templateC);

    // ── Scenario D: manager complaint flow (via interactive re-prompt ids) ──
    await customerInteractive('972521234567', 'FEEDBACK_MANAGER', 'אשמח לדבר עם מנהל', templateC.wamid);
    const askReason = await waitFor(async () =>
      mock.sent.find((m) => m.to === '972521234567' && m.summary.includes('מה קרה')));
    check('Manager button → bot asks what happened', !!askReason);

    await customerText('972521234567', 'האוכל הגיע קר מאוד');
    const managerAlert = await waitFor(async () =>
      mock.sent.find((m) => m.to === '972500000002' && m.summary.includes('האוכל הגיע קר מאוד')));
    check('Complaint forwarded to org manager phone', !!managerAlert,
      managerAlert && `includes org name: ${managerAlert.summary.includes('מסעדת בדיקה')}`);
    const thanks = await waitFor(async () =>
      mock.sent.find((m) => m.to === '972521234567' && m.summary.includes('יצור איתך קשר')));
    check('Customer gets acknowledgment', !!thanks);

    // ── Scenario E: manual feedback via dashboard API + free-text re-prompt ──
    mock.sent.length = 0;
    const manual = await api('post', '/feedbacks', {
      orgId: org.id, customerPhone: '0500000091', customerName: 'רון', delayMinutes: 0,
    });
    check('Manual feedback via admin API', manual.id > 0 && manual.customerPhone === CUSTOMER_A);

    const templateE = await waitFor(async () => mock.sent.find((m) => m.type === 'template' && m.to === CUSTOMER_A), 20000);
    check('Manual feedback template sent', !!templateE);

    await customerText(CUSTOMER_A, 'אממ לא בטוח');
    const reprompt = await waitFor(async () =>
      mock.sent.find((m) => m.to === CUSTOMER_A && m.type === 'interactive'));
    check('Unclear free text → interactive buttons re-prompt', !!reprompt);

    await customerInteractive(CUSTOMER_A, 'FEEDBACK_POSITIVE', 'הייתה מעולה! 😊', reprompt.wamid);
    const woltE = await waitFor(async () =>
      mock.sent.find((m) => m.to === CUSTOMER_A && m.summary.includes('wolt.com/he/test')));
    check('Re-prompt positive → Wolt link (fallback routing by phone)', !!woltE);

    // ── Scenario F: cancel pending feedback ──
    const toCancel = await api('post', '/feedbacks', {
      orgId: org.id, customerPhone: '0500000092', customerName: 'ביטול', delayMinutes: 60,
    });
    await api('post', `/feedbacks/${toCancel.id}/cancel`);
    const fbs = await api('get', `/feedbacks?orgId=${org.id}&status=cancelled`);
    check('Cancel pending feedback', fbs.some((f) => f.id === toCancel.id));

    // ── Scenario G: owner misc ──
    mock.sent.length = 0;
    await ownerText('מה קורה');
    const help = await waitFor(async () =>
      mock.sent.find((m) => m.to === OWNER && m.summary.includes('בוט הפידבק')));
    check('Owner random text → help message with org name', !!help && help.summary.includes('מסעדת בדיקה'));

    // ── Scenario H: owner tests the flow on their OWN phone ──
    // Button replies + complaint text must reach the customer flow even
    // though the sender is registered as an org phone.
    mock.sent.length = 0;
    await api('post', '/feedbacks', {
      orgId: org.id, customerPhone: '0500000001', customerName: 'בעלים כלקוח', delayMinutes: 0,
    });
    const templateH = await waitFor(async () =>
      mock.sent.find((m) => m.type === 'template' && m.to === OWNER), 20000);
    check('Template sent to owner-as-customer', !!templateH);

    await customerInteractive(OWNER, 'FEEDBACK_MANAGER', 'אשמח לדבר עם מנהל', templateH.wamid);
    const askReasonH = await waitFor(async () =>
      mock.sent.find((m) => m.to === OWNER && m.summary.includes('מה קרה')));
    check('Owner button press routed to customer flow', !!askReasonH);

    await ownerText('בדיקת תלונה מטלפון הבעלים');
    const managerAlertH = await waitFor(async () =>
      mock.sent.find((m) => m.to === '972500000002' && m.summary.includes('בדיקת תלונה מטלפון הבעלים')));
    check('Owner complaint text routed to customer flow (not owner flow)', !!managerAlertH);

    // ── Stats ──
    const stats = await api('get', '/stats');
    const testOrg = stats.find((s) => s.orgId === org.id);
    check('Stats view aggregates per org', !!testOrg && Number(testOrg.total) >= 4,
      testOrg && JSON.stringify(testOrg));

    // ── Cleanup test org ──
    await api('delete', `/orgs/${org.id}`);
    const orgsAfter = await api('get', '/orgs');
    check('Test org deleted (cascade)', !orgsAfter.some((o) => o.id === org.id));
  } catch (err) {
    check('E2E run completed without exception', false, err?.response?.data ? JSON.stringify(err.response.data) : String(err));
  } finally {
    bot.kill();
    mock.server.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n─── ${results.length - failed.length}/${results.length} checks passed ───`);
  process.exit(failed.length ? 1 : 0);
}

main();
