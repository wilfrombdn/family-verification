(() => {
  const $ = (id) => document.getElementById(id);

  const views = ['onboarding', 'home', 'verify-active', 'verify-result', 'money-picker', 'money-waiting', 'money-incoming', 'money-result'];
  function showView(name) {
    for (const v of views) $(`view-${v}`).classList.toggle('hidden', v !== name);
  }

  function toast(msg, ms = 3000) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  // ---------- Persisted identity ----------
  let state = {
    circleId: localStorage.getItem('fv_circleId') || null,
    deviceId: localStorage.getItem('fv_deviceId') || null,
    circleName: localStorage.getItem('fv_circleName') || '',
    memberName: localStorage.getItem('fv_memberName') || '',
  };
  function persist() {
    if (state.circleId) localStorage.setItem('fv_circleId', state.circleId);
    if (state.deviceId) localStorage.setItem('fv_deviceId', state.deviceId);
    if (state.circleName) localStorage.setItem('fv_circleName', state.circleName);
    if (state.memberName) localStorage.setItem('fv_memberName', state.memberName);
  }
  function clearIdentity() {
    localStorage.removeItem('fv_circleId');
    localStorage.removeItem('fv_deviceId');
    localStorage.removeItem('fv_circleName');
    localStorage.removeItem('fv_memberName');
    state = { circleId: null, deviceId: null, circleName: '', memberName: '' };
  }

  let roster = []; // [{deviceId, name}]
  let pendingMoneyTarget = null;
  let currentVerifySession = null; // {sessionId, challenge, deadline, confirmWindowMs}
  let currentMoneyRequestId = null;
  let countdownTimer = null;

  // ---------- API ----------
  async function api(path, opts) {
    const res = await fetch(path, {
      method: opts?.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ---------- WebSocket ----------
  let ws = null;
  function connectWs() {
    if (!state.deviceId) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', deviceId: state.deviceId }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleWsMessage(msg);
    });
    ws.addEventListener('close', () => {
      setTimeout(connectWs, 2000);
    });
    ws.addEventListener('error', () => ws.close());
  }

  function handleWsMessage(msg) {
    if (msg.type === 'roster_update') {
      roster = msg.members;
      renderRoster();
    } else if (msg.type === 'verify_start') {
      vibrate([200, 100, 200]);
      currentVerifySession = {
        sessionId: msg.sessionId,
        challenge: msg.challenge,
        startedAt: Date.now(),
        ttlMs: msg.ttlMs,
        confirmWindowMs: msg.confirmWindowMs,
        initiatorName: msg.initiatorName,
      };
      renderVerifyActive();
      showView('verify-active');
    } else if (msg.type === 'verify_update') {
      if (!currentVerifySession || currentVerifySession.sessionId !== msg.sessionId) return;
      renderConfirmList(msg.confirmations);
      if (msg.verified) {
        stopCountdown();
        showVerifyResult(true, msg.confirmations);
      } else if (msg.expired) {
        stopCountdown();
        showVerifyResult(false, msg.confirmations);
      }
    } else if (msg.type === 'money_check') {
      vibrate([300, 100, 300, 100, 300]);
      currentMoneyRequestId = msg.requestId;
      $('money-incoming-name').textContent = msg.fromName;
      showView('money-incoming');
    } else if (msg.type === 'money_result') {
      if (msg.requestId !== currentMoneyRequestId) return;
      showMoneyResult(msg.answer, msg.byName);
    }
  }

  // ---------- Onboarding ----------
  $('btn-create-circle').addEventListener('click', async () => {
    const circleName = $('create-circle-name').value.trim();
    const memberName = $('create-your-name').value.trim();
    $('onboarding-error').classList.add('hidden');
    if (!circleName || !memberName) return showOnboardingError('Please fill in both fields.');
    try {
      const data = await api('/api/circles', { method: 'POST', body: { circleName, memberName } });
      applyIdentity(data);
    } catch (e) {
      showOnboardingError(e.message);
    }
  });

  $('btn-join-circle').addEventListener('click', async () => {
    const code = $('join-code').value.trim().toUpperCase();
    const memberName = $('join-your-name').value.trim();
    $('onboarding-error').classList.add('hidden');
    if (!code || !memberName) return showOnboardingError('Please fill in both fields.');
    try {
      const data = await api(`/api/circles/${code}/join`, { method: 'POST', body: { memberName } });
      applyIdentity(data);
    } catch (e) {
      showOnboardingError(e.message);
    }
  });

  function showOnboardingError(msg) {
    const el = $('onboarding-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function applyIdentity(data) {
    state.circleId = data.circleId;
    state.deviceId = data.deviceId;
    state.circleName = data.circleName;
    state.memberName = data.members.find((m) => m.deviceId === data.deviceId)?.name || state.memberName;
    persist();
    roster = data.members;
    connectWs();
    goHome();
  }

  // ---------- Home ----------
  function goHome() {
    $('home-circle-name').textContent = state.circleName;
    $('home-circle-code').textContent = state.circleId;
    renderRoster();
    showView('home');
    refreshRoster();
  }

  async function refreshRoster() {
    try {
      const data = await api(`/api/circles/${state.circleId}`);
      roster = data.members;
      renderRoster();
    } catch { /* offline, ignore */ }
  }

  function renderRoster() {
    const el = $('home-roster');
    el.innerHTML = '';
    for (const m of roster) {
      const chip = document.createElement('div');
      chip.className = 'roster-chip';
      chip.textContent = m.deviceId === state.deviceId ? `${m.name} (you)` : m.name;
      el.appendChild(chip);
    }
  }

  $('btn-leave').addEventListener('click', () => {
    if (!confirm('Leave this circle on this device?')) return;
    if (ws) ws.close();
    clearIdentity();
    showView('onboarding');
  });

  // ---------- Verify flow ----------
  $('btn-start-verify').addEventListener('click', async () => {
    try {
      const data = await api(`/api/circles/${state.circleId}/verify`, { method: 'POST', body: { deviceId: state.deviceId } });
      currentVerifySession = {
        sessionId: data.sessionId,
        challenge: data.challenge,
        startedAt: Date.now(),
        ttlMs: data.ttlMs,
        confirmWindowMs: data.confirmWindowMs,
        initiatorName: state.memberName,
      };
      renderVerifyActive();
      showView('verify-active');
    } catch (e) {
      toast(e.message);
    }
  });

  function renderVerifyActive() {
    $('verify-challenge').textContent = currentVerifySession.challenge;
    $('verify-confirm-list').textContent = '';
    $('btn-confirm-verify').disabled = false;
    startCountdown();
  }

  function startCountdown() {
    stopCountdown();
    const el = $('verify-countdown');
    countdownTimer = setInterval(() => {
      const remaining = Math.max(0, currentVerifySession.startedAt + currentVerifySession.ttlMs - Date.now());
      el.textContent = `Expires in ${Math.ceil(remaining / 1000)}s`;
      if (remaining <= 0) stopCountdown();
    }, 250);
  }
  function stopCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
  }

  $('btn-confirm-verify').addEventListener('click', async () => {
    if (!currentVerifySession) return;
    $('btn-confirm-verify').disabled = true;
    try {
      await api(`/api/circles/${state.circleId}/verify/${currentVerifySession.sessionId}/confirm`, {
        method: 'POST',
        body: { deviceId: state.deviceId },
      });
    } catch (e) {
      toast(e.message);
      $('btn-confirm-verify').disabled = false;
    }
  });

  $('btn-cancel-verify').addEventListener('click', () => {
    stopCountdown();
    currentVerifySession = null;
    showView('home');
  });

  function renderConfirmList(confirmations) {
    const names = confirmations.map((c) => c.name);
    $('verify-confirm-list').textContent = names.length ? `Confirmed: ${names.join(', ')}` : '';
  }

  function showVerifyResult(verified, confirmations) {
    const box = $('verify-result-box');
    box.className = 'result-box ' + (verified ? 'green' : 'red');
    if (verified) {
      const names = confirmations.map((c) => c.name).join(' & ');
      $('verify-result-icon').textContent = '✅';
      $('verify-result-title').textContent = `Verified: ${names} actively confirmed this call`;
      $('verify-result-sub').textContent = 'Both devices confirmed the same code within the time window.';
    } else {
      $('verify-result-icon').textContent = '❌';
      $('verify-result-title').textContent = 'Not verified';
      $('verify-result-sub').textContent = "The code expired before both people confirmed. Try again, or don't trust this call.";
    }
    showView('verify-result');
  }

  $('btn-verify-done').addEventListener('click', () => {
    currentVerifySession = null;
    goHome();
  });

  // ---------- Money request flow ----------
  $('btn-request-money').addEventListener('click', async () => {
    await refreshRoster();
    const others = roster.filter((m) => m.deviceId !== state.deviceId);
    const el = $('money-picker-list');
    el.innerHTML = '';
    if (others.length === 0) {
      toast('No other members in this circle yet.');
      return;
    }
    for (const m of others) {
      const chip = document.createElement('div');
      chip.className = 'roster-chip';
      chip.textContent = m.name;
      chip.addEventListener('click', () => startMoneyCheck(m));
      el.appendChild(chip);
    }
    showView('money-picker');
  });

  $('btn-money-picker-cancel').addEventListener('click', () => showView('home'));

  async function startMoneyCheck(member) {
    pendingMoneyTarget = member;
    $('money-waiting-name').textContent = member.name;
    showView('money-waiting');
    try {
      const data = await api(`/api/circles/${state.circleId}/money-request`, {
        method: 'POST',
        body: { deviceId: state.deviceId, targetDeviceId: member.deviceId },
      });
      currentMoneyRequestId = data.requestId;
    } catch (e) {
      toast(e.message);
      showView('home');
    }
  }

  $('btn-money-waiting-cancel').addEventListener('click', () => {
    currentMoneyRequestId = null;
    showView('home');
  });

  function showMoneyResult(answer, byName) {
    const box = $('money-result-box');
    if (answer === 'yes') {
      box.className = 'result-box green';
      $('money-result-icon').textContent = '✅';
      $('money-result-title').textContent = `Verified: ${byName} confirms this money request is real`;
      $('money-result-sub').textContent = 'You can proceed, using your own judgment.';
    } else if (answer === 'no') {
      box.className = 'result-box red';
      $('money-result-icon').textContent = '🛑';
      $('money-result-title').textContent = 'IDENTITY NOT VERIFIED';
      $('money-result-sub').textContent = `${byName} says they are NOT asking you for money. DO NOT SEND MONEY. This call may be a scam.`;
    } else {
      box.className = 'result-box amber';
      $('money-result-icon').textContent = '⚠️';
      $('money-result-title').textContent = 'No response';
      $('money-result-sub').textContent = `${byName} did not respond in time. Could not verify — do not send money without confirming another way.`;
    }
    showView('money-result');
  }

  $('btn-money-done').addEventListener('click', () => {
    currentMoneyRequestId = null;
    goHome();
  });

  $('btn-money-yes').addEventListener('click', () => respondMoneyCheck('yes'));
  $('btn-money-no').addEventListener('click', () => respondMoneyCheck('no'));

  async function respondMoneyCheck(answer) {
    const requestId = currentMoneyRequestId;
    try {
      await api(`/api/circles/${state.circleId}/money-request/${requestId}/respond`, {
        method: 'POST',
        body: { deviceId: state.deviceId, answer },
      });
      toast('Response sent.');
    } catch (e) {
      toast(e.message);
    }
    currentMoneyRequestId = null;
    goHome();
  }

  // ---------- Boot ----------
  if (state.circleId && state.deviceId) {
    connectWs();
    goHome();
  } else {
    showView('onboarding');
  }
})();
