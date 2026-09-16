const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const webpush = require('web-push');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // Render sits behind one reverse proxy — trust its X-Forwarded-For so rate limits key on the real client IP, not Render's shared proxy IP.
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// General ceiling on API traffic per IP — generous enough for normal multi-device
// household use, tight enough to blunt scripted abuse.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});
app.use('/api/', generalLimiter);

// Tighter limit specifically on the circle-code guessing surface (join + the
// live availability check), since those are the closest thing to a brute-force
// target in this app.
const codeGuessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { circles: {} };
  }
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

const db = loadData(); // { circles: { [circleId]: { name, ownerId, members: {...}, pendingRequests: {...} } } }

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:noreply@familyverify.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications disabled (in-app + WebSocket alerts still work).');
}

async function sendPush(circleId, deviceId, payload) {
  if (!PUSH_ENABLED) return;
  const circle = db.circles[circleId];
  const sub = circle?.members[deviceId]?.pushSubscription;
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      delete circle.members[deviceId].pushSubscription;
      saveData();
    } else {
      console.error('push send failed', err.statusCode, err.message);
    }
  }
}

// Runtime-only state (not persisted to disk)
const sockets = new Map(); // deviceId -> Set<ws>
const sessions = new Map(); // sessionId -> verification session
const moneyRequests = new Map(); // requestId -> money-check request

const CONFIRM_WINDOW_MS = 10000; // both taps must land within this window of each other
const SESSION_TTL_MS = 45000; // a verification session dies if not completed in time
const MONEY_TIMEOUT_MS = 25000; // how long we wait for a money-check answer

function genId(len = 8) {
  return crypto.randomBytes(len).toString('hex');
}
function genCircleCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  for (let attempt = 0; attempt < 10; attempt++) {
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[crypto.randomInt(chars.length)];
    if (!db.circles[s]) return s;
  }
  throw new Error('could not generate a unique circle code');
}
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}
const WORDS_A = ['BLUE', 'RED', 'GOLD', 'SILVER', 'GREEN', 'SCARLET', 'VIOLET', 'AMBER', 'CORAL', 'JADE'];
const WORDS_B = ['TIGER', 'FALCON', 'OTTER', 'RAVEN', 'COMET', 'MAPLE', 'HARBOR', 'CANYON', 'WILLOW', 'GRANITE'];
function genChallenge() {
  const a = WORDS_A[crypto.randomInt(WORDS_A.length)];
  const b = WORDS_B[crypto.randomInt(WORDS_B.length)];
  const n = crypto.randomInt(10, 100);
  return `${a} ${b} ${n}`;
}

function circleMembers(circleId) {
  const c = db.circles[circleId];
  if (!c) return [];
  return Object.entries(c.members)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([deviceId, m]) => ({ deviceId, name: m.name, isOwner: deviceId === c.ownerId }));
}

function sendToDevice(deviceId, msg) {
  const set = sockets.get(deviceId);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
function broadcastToCircle(circleId, msg) {
  for (const m of circleMembers(circleId)) sendToDevice(m.deviceId, msg);
}
function sendToDevices(deviceIds, msg) {
  for (const id of deviceIds) sendToDevice(id, msg);
}

wss.on('connection', (ws) => {
  let registeredDeviceId = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello' && msg.deviceId) {
      registeredDeviceId = msg.deviceId;
      if (!sockets.has(registeredDeviceId)) sockets.set(registeredDeviceId, new Set());
      sockets.get(registeredDeviceId).add(ws);
    }
  });
  ws.on('close', () => {
    if (registeredDeviceId && sockets.has(registeredDeviceId)) {
      sockets.get(registeredDeviceId).delete(ws);
      if (sockets.get(registeredDeviceId).size === 0) sockets.delete(registeredDeviceId);
    }
  });
});

function requireMember(circleId, deviceId) {
  const circle = db.circles[circleId];
  if (!circle || !circle.members[deviceId]) return null;
  return circle;
}
function requireOwner(circleId, deviceId) {
  const circle = requireMember(circleId, deviceId);
  if (!circle || circle.ownerId !== deviceId) return null;
  return circle;
}

// ---------- Push notifications ----------

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: PUSH_ENABLED ? VAPID_PUBLIC_KEY : null });
});

app.post('/api/circles/:circleId/push-subscribe', (req, res) => {
  const { circleId } = req.params;
  const { deviceId, subscription } = req.body || {};
  const circle = requireMember(circleId, deviceId);
  if (!circle) return res.status(404).json({ error: 'not found' });
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  circle.members[deviceId].pushSubscription = subscription;
  saveData();
  res.json({ ok: true });
});

// ---------- Circle management ----------

app.get('/api/circles/:circleId/available', codeGuessLimiter, (req, res) => {
  const code = normalizeCode(req.params.circleId);
  if (!CODE_PATTERN.test(code)) return res.json({ available: false, reason: 'invalid' });
  res.json({ available: !db.circles[code] });
});

app.post('/api/circles', (req, res) => {
  const { circleName, memberName, circleCode } = req.body || {};
  if (!circleName || !memberName) return res.status(400).json({ error: 'circleName and memberName required' });

  let circleId;
  if (circleCode) {
    circleId = normalizeCode(circleCode);
    if (!CODE_PATTERN.test(circleId)) {
      return res.status(400).json({ error: 'Circle code must be 3-24 letters, numbers, - or _' });
    }
    if (db.circles[circleId]) return res.status(409).json({ error: 'That circle code is already taken' });
  } else {
    circleId = genCircleCode();
  }

  const deviceId = genId();
  db.circles[circleId] = {
    name: String(circleName).slice(0, 60),
    ownerId: deviceId,
    members: { [deviceId]: { name: String(memberName).slice(0, 40), joinedAt: Date.now() } },
    pendingRequests: {},
  };
  saveData();
  res.json({ circleId, deviceId, circleName: db.circles[circleId].name, ownerId: deviceId, members: circleMembers(circleId) });
});

// Joining requires owner approval — this creates a pending request, not membership.
app.post('/api/circles/:circleId/join', codeGuessLimiter, (req, res) => {
  const { circleId } = req.params;
  const { memberName } = req.body || {};
  const circle = db.circles[circleId];
  if (!circle) return res.status(404).json({ error: 'Circle not found. Check the code.' });
  if (!memberName) return res.status(400).json({ error: 'memberName required' });
  if (!circle.pendingRequests) circle.pendingRequests = {};

  const deviceId = genId();
  const name = String(memberName).slice(0, 40);
  circle.pendingRequests[deviceId] = { name, requestedAt: Date.now() };
  saveData();

  sendToDevice(circle.ownerId, { type: 'join_requested', circleId, deviceId, name });
  sendPush(circleId, circle.ownerId, {
    title: 'New join request',
    body: `${name} wants to join ${circle.name}`,
    tag: `join-${deviceId}`,
  });
  res.json({ circleId, deviceId, circleName: circle.name, status: 'pending' });
});

app.get('/api/circles/:circleId/join-status/:deviceId', (req, res) => {
  const { circleId, deviceId } = req.params;
  const circle = db.circles[circleId];
  if (!circle) return res.json({ status: 'not_found' });
  if (circle.members[deviceId]) {
    return res.json({ status: 'approved', circleName: circle.name, ownerId: circle.ownerId, members: circleMembers(circleId) });
  }
  if (circle.pendingRequests && circle.pendingRequests[deviceId]) return res.json({ status: 'pending' });
  res.json({ status: 'denied' });
});

app.get('/api/circles/:circleId/pending', (req, res) => {
  const { circleId } = req.params;
  const circle = requireOwner(circleId, req.query.deviceId);
  if (!circle) return res.status(403).json({ error: 'Only the circle owner can view join requests' });
  const pending = Object.entries(circle.pendingRequests || {})
    .sort((a, b) => a[1].requestedAt - b[1].requestedAt)
    .map(([id, r]) => ({ deviceId: id, name: r.name, requestedAt: r.requestedAt }));
  res.json({ pending });
});

app.post('/api/circles/:circleId/approve', (req, res) => {
  const { circleId } = req.params;
  const { deviceId, requestDeviceId } = req.body || {};
  const circle = requireOwner(circleId, deviceId);
  if (!circle) return res.status(403).json({ error: 'Only the circle owner can approve requests' });
  const reqEntry = circle.pendingRequests && circle.pendingRequests[requestDeviceId];
  if (!reqEntry) return res.status(404).json({ error: 'Request not found — it may have been withdrawn' });

  delete circle.pendingRequests[requestDeviceId];
  circle.members[requestDeviceId] = { name: reqEntry.name, joinedAt: Date.now() };
  saveData();

  broadcastToCircle(circleId, { type: 'roster_update', members: circleMembers(circleId), ownerId: circle.ownerId });
  sendToDevice(requestDeviceId, {
    type: 'join_approved',
    circleId,
    circleName: circle.name,
    ownerId: circle.ownerId,
    members: circleMembers(circleId),
  });
  res.json({ ok: true });
});

app.post('/api/circles/:circleId/deny', (req, res) => {
  const { circleId } = req.params;
  const { deviceId, requestDeviceId } = req.body || {};
  const circle = requireOwner(circleId, deviceId);
  if (!circle) return res.status(403).json({ error: 'Only the circle owner can deny requests' });
  if (!circle.pendingRequests || !circle.pendingRequests[requestDeviceId]) return res.status(404).json({ error: 'not found' });

  delete circle.pendingRequests[requestDeviceId];
  saveData();
  sendToDevice(requestDeviceId, { type: 'join_denied', circleId });
  res.json({ ok: true });
});

app.get('/api/circles/:circleId', (req, res) => {
  const circle = db.circles[req.params.circleId];
  if (!circle) return res.status(404).json({ error: 'not found' });
  res.json({ circleId: req.params.circleId, circleName: circle.name, ownerId: circle.ownerId, members: circleMembers(req.params.circleId) });
});

app.post('/api/circles/:circleId/leave', (req, res) => {
  const { circleId } = req.params;
  const { deviceId } = req.body || {};
  const circle = requireMember(circleId, deviceId);
  if (!circle) return res.status(404).json({ error: 'not found' });

  delete circle.members[deviceId];
  const remaining = Object.keys(circle.members);
  if (remaining.length === 0) {
    delete db.circles[circleId];
    saveData();
    return res.json({ ok: true });
  }
  if (circle.ownerId === deviceId) {
    // Hand leadership to whoever joined earliest among those remaining.
    circle.ownerId = circleMembers(circleId)[0]?.deviceId || remaining[0];
  }
  saveData();
  broadcastToCircle(circleId, { type: 'roster_update', members: circleMembers(circleId), ownerId: circle.ownerId });
  res.json({ ok: true });
});

app.post('/api/circles/:circleId/kick', (req, res) => {
  const { circleId } = req.params;
  const { deviceId, targetDeviceId } = req.body || {};
  const circle = requireOwner(circleId, deviceId);
  if (!circle) return res.status(403).json({ error: 'Only the circle owner can remove members' });
  if (!circle.members[targetDeviceId]) return res.status(404).json({ error: 'not found' });
  if (targetDeviceId === deviceId) return res.status(400).json({ error: "Use Leave to remove yourself" });

  delete circle.members[targetDeviceId];
  saveData();
  broadcastToCircle(circleId, { type: 'roster_update', members: circleMembers(circleId), ownerId: circle.ownerId });
  sendToDevice(targetDeviceId, { type: 'kicked', circleId });
  res.json({ ok: true });
});

app.post('/api/circles/:circleId/transfer-owner', (req, res) => {
  const { circleId } = req.params;
  const { deviceId, newOwnerDeviceId } = req.body || {};
  const circle = requireOwner(circleId, deviceId);
  if (!circle) return res.status(403).json({ error: 'Only the circle owner can transfer leadership' });
  if (!circle.members[newOwnerDeviceId]) return res.status(404).json({ error: 'not found' });

  circle.ownerId = newOwnerDeviceId;
  saveData();
  broadcastToCircle(circleId, { type: 'roster_update', members: circleMembers(circleId), ownerId: circle.ownerId });
  res.json({ ok: true });
});

// ---------- "Verify this call" flow ----------

app.post('/api/circles/:circleId/verify', (req, res) => {
  const { circleId } = req.params;
  const { deviceId, targetDeviceId } = req.body || {};
  const circle = requireMember(circleId, deviceId);
  if (!circle) return res.status(404).json({ error: 'not found' });
  if (!targetDeviceId || !circle.members[targetDeviceId]) return res.status(404).json({ error: 'Pick who you are on the call with' });
  if (targetDeviceId === deviceId) return res.status(400).json({ error: 'Pick someone else in the circle' });

  const sessionId = genId(6);
  const challenge = genChallenge();
  const participants = [deviceId, targetDeviceId];
  const session = {
    sessionId, circleId, challenge,
    initiatorDeviceId: deviceId,
    participants,
    createdAt: Date.now(),
    confirmations: [],
    verified: false,
    expired: false,
  };
  sessions.set(sessionId, session);
  setTimeout(() => expireSession(sessionId), SESSION_TTL_MS);

  const initiatorName = circle.members[deviceId].name;
  const targetName = circle.members[targetDeviceId].name;
  sendToDevices(participants, {
    type: 'verify_start',
    sessionId,
    challenge,
    initiatorName,
    initiatorDeviceId: deviceId,
    targetName,
    ttlMs: SESSION_TTL_MS,
    confirmWindowMs: CONFIRM_WINDOW_MS,
  });
  sendPush(circleId, targetDeviceId, {
    title: 'Verify this call?',
    body: `${initiatorName} wants to verify a call with you.`,
    tag: `verify-${sessionId}`,
  });
  res.json({ sessionId, challenge, targetName, ttlMs: SESSION_TTL_MS, confirmWindowMs: CONFIRM_WINDOW_MS });
});

function expireSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.verified || s.expired) return;
  s.expired = true;
  sendToDevices(s.participants, { type: 'verify_update', sessionId: s.sessionId, verified: false, expired: true, confirmations: s.confirmations });
}

app.post('/api/circles/:circleId/verify/:sessionId/confirm', (req, res) => {
  const { circleId, sessionId } = req.params;
  const { deviceId } = req.body || {};
  const circle = requireMember(circleId, deviceId);
  const session = sessions.get(sessionId);
  if (!circle || !session || session.circleId !== circleId) return res.status(404).json({ error: 'not found' });
  if (!session.participants.includes(deviceId)) return res.status(403).json({ error: 'not part of this verification' });

  if (!session.verified && !session.expired) {
    if (!session.confirmations.find((c) => c.deviceId === deviceId)) {
      session.confirmations.push({ deviceId, name: circle.members[deviceId].name, ts: Date.now() });
    }
    if (session.confirmations.length >= 2) {
      const times = session.confirmations.map((c) => c.ts);
      const spread = Math.max(...times) - Math.min(...times);
      if (spread <= CONFIRM_WINDOW_MS) session.verified = true;
    }
    sendToDevices(session.participants, {
      type: 'verify_update',
      sessionId,
      verified: session.verified,
      expired: session.expired,
      confirmations: session.confirmations,
    });
  }
  res.json({ ok: true, verified: session.verified, expired: session.expired });
});

// ---------- "Requesting money?" flow ----------

app.post('/api/circles/:circleId/money-request', (req, res) => {
  const { circleId } = req.params;
  const { deviceId, targetDeviceId } = req.body || {};
  const circle = requireMember(circleId, deviceId);
  if (!circle || !circle.members[targetDeviceId]) return res.status(404).json({ error: 'not found' });

  const requestId = genId(6);
  const fromName = circle.members[deviceId].name;
  moneyRequests.set(requestId, { circleId, fromDeviceId: deviceId, targetDeviceId, createdAt: Date.now(), status: 'pending' });
  setTimeout(() => timeoutMoneyRequest(requestId), MONEY_TIMEOUT_MS);

  sendToDevice(targetDeviceId, {
    type: 'money_check',
    requestId,
    fromName,
    timeoutMs: MONEY_TIMEOUT_MS,
  });
  sendPush(circleId, targetDeviceId, {
    title: 'Money request check',
    body: `${fromName} wants to confirm: are you asking them for money?`,
    tag: `money-${requestId}`,
  });
  res.json({ requestId, timeoutMs: MONEY_TIMEOUT_MS });
});

function timeoutMoneyRequest(requestId) {
  const r = moneyRequests.get(requestId);
  if (!r || r.status !== 'pending') return;
  r.status = 'timeout';
  const circle = db.circles[r.circleId];
  const byName = circle?.members[r.targetDeviceId]?.name || 'them';
  sendToDevice(r.fromDeviceId, { type: 'money_result', requestId, answer: 'timeout', byName });
  sendPush(r.circleId, r.fromDeviceId, {
    title: 'No response',
    body: `${byName} did not respond in time. Do not send money without confirming another way.`,
    tag: `money-result-${requestId}`,
  });
}

app.post('/api/circles/:circleId/money-request/:requestId/respond', (req, res) => {
  const { circleId, requestId } = req.params;
  const { deviceId, answer } = req.body || {};
  const r = moneyRequests.get(requestId);
  const circle = requireMember(circleId, deviceId);
  if (!r || !circle || r.circleId !== circleId || r.targetDeviceId !== deviceId) return res.status(404).json({ error: 'not found' });

  if (r.status === 'pending') {
    r.status = answer === 'yes' ? 'yes' : 'no';
    const byName = circle.members[deviceId].name;
    sendToDevice(r.fromDeviceId, { type: 'money_result', requestId, answer: r.status, byName });
    sendPush(circleId, r.fromDeviceId, {
      title: r.status === 'no' ? 'Do not send money' : 'Money request confirmed',
      body: r.status === 'no'
        ? `${byName} says they are NOT asking you for money. This call may be a scam.`
        : `${byName} confirms this money request is real.`,
      tag: `money-result-${requestId}`,
    });
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Family verification server listening on port ${PORT}`));
