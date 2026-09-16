const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

const db = loadData(); // { circles: { [circleId]: { name, members: { [deviceId]: {name} } } } }

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
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
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
  return Object.entries(c.members).map(([deviceId, m]) => ({ deviceId, name: m.name }));
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

// ---------- Circle management ----------

app.post('/api/circles', (req, res) => {
  const { circleName, memberName } = req.body || {};
  if (!circleName || !memberName) return res.status(400).json({ error: 'circleName and memberName required' });
  const circleId = genCircleCode();
  const deviceId = genId();
  db.circles[circleId] = { name: String(circleName).slice(0, 60), members: { [deviceId]: { name: String(memberName).slice(0, 40) } } };
  saveData();
  res.json({ circleId, deviceId, circleName: db.circles[circleId].name, members: circleMembers(circleId) });
});

app.post('/api/circles/:circleId/join', (req, res) => {
  const { circleId } = req.params;
  const { memberName } = req.body || {};
  const circle = db.circles[circleId];
  if (!circle) return res.status(404).json({ error: 'Circle not found. Check the code.' });
  if (!memberName) return res.status(400).json({ error: 'memberName required' });
  const deviceId = genId();
  circle.members[deviceId] = { name: String(memberName).slice(0, 40) };
  saveData();
  broadcastToCircle(circleId, { type: 'roster_update', members: circleMembers(circleId) });
  res.json({ circleId, deviceId, circleName: circle.name, members: circleMembers(circleId) });
});

app.get('/api/circles/:circleId', (req, res) => {
  const circle = db.circles[req.params.circleId];
  if (!circle) return res.status(404).json({ error: 'not found' });
  res.json({ circleId: req.params.circleId, circleName: circle.name, members: circleMembers(req.params.circleId) });
});

// ---------- "Verify this call" flow ----------

app.post('/api/circles/:circleId/verify', (req, res) => {
  const { circleId } = req.params;
  const { deviceId } = req.body || {};
  const circle = requireMember(circleId, deviceId);
  if (!circle) return res.status(404).json({ error: 'not found' });

  const sessionId = genId(6);
  const challenge = genChallenge();
  const session = {
    sessionId, circleId, challenge,
    initiatorDeviceId: deviceId,
    createdAt: Date.now(),
    confirmations: [],
    verified: false,
    expired: false,
  };
  sessions.set(sessionId, session);
  setTimeout(() => expireSession(sessionId), SESSION_TTL_MS);

  broadcastToCircle(circleId, {
    type: 'verify_start',
    sessionId,
    challenge,
    initiatorName: circle.members[deviceId].name,
    initiatorDeviceId: deviceId,
    ttlMs: SESSION_TTL_MS,
    confirmWindowMs: CONFIRM_WINDOW_MS,
  });
  res.json({ sessionId, challenge, ttlMs: SESSION_TTL_MS, confirmWindowMs: CONFIRM_WINDOW_MS });
});

function expireSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.verified || s.expired) return;
  s.expired = true;
  broadcastToCircle(s.circleId, { type: 'verify_update', sessionId: s.sessionId, verified: false, expired: true, confirmations: s.confirmations });
}

app.post('/api/circles/:circleId/verify/:sessionId/confirm', (req, res) => {
  const { circleId, sessionId } = req.params;
  const { deviceId } = req.body || {};
  const circle = requireMember(circleId, deviceId);
  const session = sessions.get(sessionId);
  if (!circle || !session || session.circleId !== circleId) return res.status(404).json({ error: 'not found' });

  if (!session.verified && !session.expired) {
    if (!session.confirmations.find((c) => c.deviceId === deviceId)) {
      session.confirmations.push({ deviceId, name: circle.members[deviceId].name, ts: Date.now() });
    }
    if (session.confirmations.length >= 2) {
      const times = session.confirmations.map((c) => c.ts);
      const spread = Math.max(...times) - Math.min(...times);
      if (spread <= CONFIRM_WINDOW_MS) session.verified = true;
    }
    broadcastToCircle(circleId, {
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
  moneyRequests.set(requestId, { circleId, fromDeviceId: deviceId, targetDeviceId, createdAt: Date.now(), status: 'pending' });
  setTimeout(() => timeoutMoneyRequest(requestId), MONEY_TIMEOUT_MS);

  sendToDevice(targetDeviceId, {
    type: 'money_check',
    requestId,
    fromName: circle.members[deviceId].name,
    timeoutMs: MONEY_TIMEOUT_MS,
  });
  res.json({ requestId, timeoutMs: MONEY_TIMEOUT_MS });
});

function timeoutMoneyRequest(requestId) {
  const r = moneyRequests.get(requestId);
  if (!r || r.status !== 'pending') return;
  r.status = 'timeout';
  const circle = db.circles[r.circleId];
  sendToDevice(r.fromDeviceId, {
    type: 'money_result',
    requestId,
    answer: 'timeout',
    byName: circle?.members[r.targetDeviceId]?.name || 'them',
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
    sendToDevice(r.fromDeviceId, {
      type: 'money_result',
      requestId,
      answer: r.status,
      byName: circle.members[deviceId].name,
    });
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Family verification server listening on port ${PORT}`));
