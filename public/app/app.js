(() => {
  const $ = (id) => document.getElementById(id);

  const views = ['onboarding', 'join-waiting', 'home', 'verify-picker', 'verify-active', 'verify-result', 'money-picker', 'money-waiting', 'money-incoming', 'money-result'];
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

  async function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission === 'granted') setupPush();
  }

  function notifyOS(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    // Skip if the person is already looking at this tab — the in-app UI is enough then.
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    try {
      const n = new Notification(title, { body, icon: '/app/icon.png', requireInteraction: true, tag: 'family-verify' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some platforms restrict direct Notification() construction; ignore */ }
  }

  // ---------- Real push (works even if the app/tab is fully closed) ----------
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function setupPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!state.circleId || !state.deviceId) return; // only meaningful once we're a real member
    try {
      const reg = await navigator.serviceWorker.register('/app/sw.js');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const keyRes = await fetch('/api/push/vapid-public-key');
        const { publicKey } = await keyRes.json();
        if (!publicKey) return; // server has no VAPID keys configured
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      }
      await api(`/api/circles/${state.circleId}/push-subscribe`, {
        method: 'POST',
        body: { deviceId: state.deviceId, subscription: sub.toJSON() },
      });
    } catch (e) {
      console.warn('push setup failed', e);
    }
  }

  function initials(name) {
    return (name || '?').trim().slice(0, 1).toUpperCase();
  }

  function setIcon(elId, iconName) {
    $(elId).innerHTML = `<svg><use href="#icon-${iconName}"/></svg>`;
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

  // A join request that's awaiting owner approval — not a real member yet.
  let pending = {
    circleId: localStorage.getItem('fv_pendingCircleId') || null,
    deviceId: localStorage.getItem('fv_pendingDeviceId') || null,
    circleName: localStorage.getItem('fv_pendingCircleName') || '',
  };
  function persistPending() {
    localStorage.setItem('fv_pendingCircleId', pending.circleId);
    localStorage.setItem('fv_pendingDeviceId', pending.deviceId);
    localStorage.setItem('fv_pendingCircleName', pending.circleName);
  }
  function clearPending() {
    localStorage.removeItem('fv_pendingCircleId');
    localStorage.removeItem('fv_pendingDeviceId');
    localStorage.removeItem('fv_pendingCircleName');
    pending = { circleId: null, deviceId: null, circleName: '' };
  }

  let roster = []; // [{deviceId, name, isOwner}]
  let pendingRequests = []; // [{deviceId, name, requestedAt}] — owner-only
  let currentVerifySession = null; // {sessionId, challenge, deadline, confirmWindowMs}
  let currentMoneyRequestId = null;
  let countdownTimer = null;
  let joinPollTimer = null;

  function isOwner() {
    return roster.find((m) => m.deviceId === state.deviceId)?.isOwner === true;
  }

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
  let wsDeviceId = null;
  function connectWs(deviceId) {
    wsDeviceId = deviceId || state.deviceId || wsDeviceId;
    if (!wsDeviceId) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', deviceId: wsDeviceId }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleWsMessage(msg);
    });
    ws.addEventListener('close', () => {
      setTimeout(() => connectWs(), 2000);
    });
    ws.addEventListener('error', () => ws.close());
  }

  function handleWsMessage(msg) {
    if (msg.type === 'roster_update') {
      roster = msg.members;
      renderRoster();
      refreshPending();
    } else if (msg.type === 'join_requested') {
      if (msg.circleId !== state.circleId || !isOwner()) return;
      refreshPending();
      toast(`${msg.name} wants to join.`);
      vibrate([150, 80, 150]);
    } else if (msg.type === 'join_approved') {
      if (!pending.deviceId || msg.circleId !== pending.circleId) return;
      handleJoinApproved(msg);
    } else if (msg.type === 'join_denied') {
      if (!pending.deviceId || msg.circleId !== pending.circleId) return;
      handleJoinDenied();
    } else if (msg.type === 'kicked') {
      if (msg.circleId !== state.circleId) return;
      if (ws) ws.close();
      clearIdentity();
      showView('onboarding');
      toast('You were removed from this circle.');
    } else if (msg.type === 'verify_start') {
      vibrate([200, 100, 200]);
      const otherName = msg.initiatorDeviceId === state.deviceId ? msg.targetName : msg.initiatorName;
      currentVerifySession = {
        sessionId: msg.sessionId,
        challenge: msg.challenge,
        startedAt: Date.now(),
        ttlMs: msg.ttlMs,
        confirmWindowMs: msg.confirmWindowMs,
        otherName,
      };
      renderVerifyActive();
      showView('verify-active');
      if (msg.initiatorDeviceId !== state.deviceId) {
        notifyOS('Verify this call?', `${msg.initiatorName} wants to verify a call with you. Open Family Verify to confirm.`);
      }
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
      notifyOS('Money request check', `${msg.fromName} wants to confirm: are you asking them for money?`);
    } else if (msg.type === 'money_result') {
      if (msg.requestId !== currentMoneyRequestId) return;
      showMoneyResult(msg.answer, msg.byName);
      if (msg.answer === 'no') notifyOS('Do not send money', `${msg.byName} says they are NOT asking you for money.`);
    }
  }

  // ---------- Onboarding: tabs ----------
  $('tab-create').addEventListener('click', () => switchTab('create'));
  $('tab-join').addEventListener('click', () => switchTab('join'));
  function switchTab(name) {
    $('tab-create').classList.toggle('active', name === 'create');
    $('tab-join').classList.toggle('active', name === 'join');
    $('panel-create').classList.toggle('hidden', name !== 'create');
    $('panel-join').classList.toggle('hidden', name !== 'join');
    $('onboarding-error').classList.add('hidden');
  }

  // ---------- Onboarding: custom code availability ----------
  let codeCheckTimer = null;
  $('create-circle-code').addEventListener('input', (e) => {
    const raw = e.target.value.toUpperCase();
    e.target.value = raw;
    const status = $('code-status');
    clearTimeout(codeCheckTimer);
    if (!raw) {
      status.textContent = '';
      status.className = 'field-status';
      return;
    }
    status.textContent = 'Checking…';
    status.className = 'field-status';
    codeCheckTimer = setTimeout(async () => {
      try {
        const data = await api(`/api/circles/${encodeURIComponent(raw)}/available`);
        if (data.available) {
          status.textContent = `"${raw}" is available`;
          status.className = 'field-status ok';
        } else {
          status.textContent = data.reason === 'invalid'
            ? 'Use 3-24 letters, numbers, - or _'
            : `"${raw}" is already taken`;
          status.className = 'field-status bad';
        }
      } catch {
        status.textContent = '';
      }
    }, 400);
  });

  // ---------- Onboarding: create / join ----------
  $('btn-create-circle').addEventListener('click', async () => {
    const circleName = $('create-circle-name').value.trim();
    const memberName = $('create-your-name').value.trim();
    const circleCode = $('create-circle-code').value.trim();
    $('onboarding-error').classList.add('hidden');
    if (!circleName || !memberName) return showOnboardingError('Please fill in both fields.');
    try {
      const data = await api('/api/circles', { method: 'POST', body: { circleName, memberName, circleCode: circleCode || undefined } });
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
      pending = { circleId: data.circleId, deviceId: data.deviceId, circleName: data.circleName };
      persistPending();
      connectWs(data.deviceId);
      $('join-waiting-circle-name').textContent = data.circleName;
      showView('join-waiting');
      startJoinPolling();
    } catch (e) {
      showOnboardingError(e.message);
    }
  });

  $('btn-join-waiting-cancel').addEventListener('click', () => {
    stopJoinPolling();
    clearPending();
    showView('onboarding');
  });

  function startJoinPolling() {
    stopJoinPolling();
    joinPollTimer = setInterval(async () => {
      try {
        const data = await api(`/api/circles/${pending.circleId}/join-status/${pending.deviceId}`);
        if (data.status === 'approved') handleJoinApproved(data);
        else if (data.status === 'denied' || data.status === 'not_found') handleJoinDenied();
      } catch { /* transient, keep polling */ }
    }, 4000);
  }
  function stopJoinPolling() {
    if (joinPollTimer) clearInterval(joinPollTimer);
    joinPollTimer = null;
  }

  function handleJoinApproved(data) {
    stopJoinPolling();
    state.circleId = pending.circleId;
    state.deviceId = pending.deviceId;
    state.circleName = data.circleName;
    state.memberName = data.members?.find((m) => m.deviceId === state.deviceId)?.name || state.memberName;
    persist();
    clearPending();
    roster = data.members || [];
    goHome();
    toast("You're in — welcome!");
  }

  function handleJoinDenied() {
    stopJoinPolling();
    clearPending();
    showView('onboarding');
    showOnboardingError('Your join request was declined by the circle owner.');
  }

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
    refreshRoster().then(refreshPending);
    requestNotificationPermission();
  }

  async function refreshPending() {
    if (!isOwner()) {
      pendingRequests = [];
      renderPending();
      return;
    }
    try {
      const data = await api(`/api/circles/${state.circleId}/pending?deviceId=${encodeURIComponent(state.deviceId)}`);
      pendingRequests = data.pending;
      renderPending();
    } catch { /* offline, ignore */ }
  }

  function renderPending() {
    const section = $('home-pending-section');
    const el = $('home-pending-list');
    if (!pendingRequests.length) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    el.innerHTML = '';
    for (const r of pendingRequests) {
      const row = document.createElement('div');
      row.className = 'member-row';
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = initials(r.name);
      row.appendChild(avatar);
      const info = document.createElement('div');
      info.className = 'member-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'member-name';
      nameEl.textContent = r.name;
      info.appendChild(nameEl);
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'member-actions';
      const approveBtn = document.createElement('button');
      approveBtn.className = 'icon-btn';
      approveBtn.title = `Approve ${r.name}`;
      approveBtn.innerHTML = '<svg><use href="#icon-check-circle"/></svg>';
      approveBtn.addEventListener('click', () => approveRequest(r));
      actions.appendChild(approveBtn);
      const denyBtn = document.createElement('button');
      denyBtn.className = 'icon-btn danger';
      denyBtn.title = `Deny ${r.name}`;
      denyBtn.innerHTML = '<svg><use href="#icon-x-circle"/></svg>';
      denyBtn.addEventListener('click', () => denyRequest(r));
      actions.appendChild(denyBtn);
      row.appendChild(actions);

      el.appendChild(row);
    }
  }

  async function approveRequest(r) {
    try {
      await api(`/api/circles/${state.circleId}/approve`, { method: 'POST', body: { deviceId: state.deviceId, requestDeviceId: r.deviceId } });
      refreshPending();
    } catch (e) {
      toast(e.message);
    }
  }

  async function denyRequest(r) {
    if (!confirm(`Deny ${r.name}'s request to join?`)) return;
    try {
      await api(`/api/circles/${state.circleId}/deny`, { method: 'POST', body: { deviceId: state.deviceId, requestDeviceId: r.deviceId } });
      refreshPending();
    } catch (e) {
      toast(e.message);
    }
  }

  async function refreshRoster() {
    try {
      const data = await api(`/api/circles/${state.circleId}`);
      roster = data.members;
      state.circleName = data.circleName;
      $('home-circle-name').textContent = state.circleName;
      renderRoster();
    } catch { /* offline, ignore */ }
  }

  function renderPickerList(elId, members, onPick) {
    const el = $(elId);
    el.innerHTML = '';
    for (const m of members) {
      const row = document.createElement('div');
      row.className = 'member-row';
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = initials(m.name);
      row.appendChild(avatar);
      const info = document.createElement('div');
      info.className = 'member-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'member-name';
      nameEl.textContent = m.name;
      info.appendChild(nameEl);
      row.appendChild(info);
      row.addEventListener('click', () => onPick(m));
      el.appendChild(row);
    }
  }

  function renderRoster() {
    const el = $('home-roster');
    el.innerHTML = '';
    const iAmOwner = isOwner();
    for (const m of roster) {
      const row = document.createElement('div');
      row.className = 'member-row';

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = initials(m.name);
      row.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'member-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'member-name';
      nameEl.textContent = m.name;
      if (m.deviceId === state.deviceId) {
        const tag = document.createElement('span');
        tag.className = 'you-tag';
        tag.textContent = '(you)';
        nameEl.appendChild(tag);
      }
      if (m.isOwner) {
        const crown = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        crown.setAttribute('class', 'crown-icon');
        crown.innerHTML = '<use href="#icon-crown"/>';
        crown.setAttribute('title', 'Circle owner');
        nameEl.appendChild(crown);
      }
      info.appendChild(nameEl);
      row.appendChild(info);

      if (iAmOwner && m.deviceId !== state.deviceId) {
        const actions = document.createElement('div');
        actions.className = 'member-actions';

        const transferBtn = document.createElement('button');
        transferBtn.className = 'icon-btn';
        transferBtn.title = `Make ${m.name} the owner`;
        transferBtn.innerHTML = '<svg><use href="#icon-crown"/></svg>';
        transferBtn.addEventListener('click', () => transferOwner(m));
        actions.appendChild(transferBtn);

        const kickBtn = document.createElement('button');
        kickBtn.className = 'icon-btn danger';
        kickBtn.title = `Remove ${m.name}`;
        kickBtn.innerHTML = '<svg><use href="#icon-user-x"/></svg>';
        kickBtn.addEventListener('click', () => kickMember(m));
        actions.appendChild(kickBtn);

        row.appendChild(actions);
      }

      el.appendChild(row);
    }
  }

  async function transferOwner(member) {
    if (!confirm(`Make ${member.name} the owner of this circle? They'll be able to remove members and transfer leadership.`)) return;
    try {
      await api(`/api/circles/${state.circleId}/transfer-owner`, {
        method: 'POST',
        body: { deviceId: state.deviceId, newOwnerDeviceId: member.deviceId },
      });
    } catch (e) {
      toast(e.message);
    }
  }

  async function kickMember(member) {
    if (!confirm(`Remove ${member.name} from this circle?`)) return;
    try {
      await api(`/api/circles/${state.circleId}/kick`, {
        method: 'POST',
        body: { deviceId: state.deviceId, targetDeviceId: member.deviceId },
      });
    } catch (e) {
      toast(e.message);
    }
  }

  $('btn-leave').addEventListener('click', async () => {
    if (!confirm('Leave this circle on this device?')) return;
    try {
      await api(`/api/circles/${state.circleId}/leave`, { method: 'POST', body: { deviceId: state.deviceId } });
    } catch { /* circle or membership already gone, proceed anyway */ }
    if (ws) ws.close();
    clearIdentity();
    showView('onboarding');
  });

  // ---------- Verify flow ----------
  $('btn-start-verify').addEventListener('click', async () => {
    await refreshRoster();
    const others = roster.filter((m) => m.deviceId !== state.deviceId);
    if (others.length === 0) {
      toast('No other members in this circle yet.');
      return;
    }
    if (others.length === 1) {
      startVerify(others[0]);
      return;
    }
    renderPickerList('verify-picker-list', others, startVerify);
    showView('verify-picker');
  });

  $('btn-verify-picker-cancel').addEventListener('click', () => showView('home'));

  async function startVerify(member) {
    try {
      const data = await api(`/api/circles/${state.circleId}/verify`, {
        method: 'POST',
        body: { deviceId: state.deviceId, targetDeviceId: member.deviceId },
      });
      currentVerifySession = {
        sessionId: data.sessionId,
        challenge: data.challenge,
        startedAt: Date.now(),
        ttlMs: data.ttlMs,
        confirmWindowMs: data.confirmWindowMs,
        otherName: data.targetName,
      };
      renderVerifyActive();
      showView('verify-active');
    } catch (e) {
      toast(e.message);
    }
  }

  function renderVerifyActive() {
    $('verify-with-label').textContent = `Verifying with ${currentVerifySession.otherName} — say this code, both tap Confirm:`;
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
      setIcon('verify-result-icon', 'check-circle');
      $('verify-result-status').textContent = 'Verified';
      $('verify-result-title').textContent = `${names} actively confirmed this call`;
      $('verify-result-sub').textContent = 'Both enrolled devices confirmed the same code within the time window.';
    } else {
      setIcon('verify-result-icon', 'x-circle');
      $('verify-result-status').textContent = 'Not Verified';
      $('verify-result-title').textContent = "The code expired before both people confirmed";
      $('verify-result-sub').textContent = "Try again, or don't trust this call.";
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
    if (others.length === 0) {
      toast('No other members in this circle yet.');
      return;
    }
    renderPickerList('money-picker-list', others, startMoneyCheck);
    showView('money-picker');
  });

  $('btn-money-picker-cancel').addEventListener('click', () => showView('home'));

  async function startMoneyCheck(member) {
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
      setIcon('money-result-icon', 'check-circle');
      $('money-result-status').textContent = 'Verified';
      $('money-result-title').textContent = `${byName} confirms this money request is real`;
      $('money-result-sub').textContent = 'You can proceed, using your own judgment.';
    } else if (answer === 'no') {
      box.className = 'result-box red';
      setIcon('money-result-icon', 'x-circle');
      $('money-result-status').textContent = 'Not Verified';
      $('money-result-title').textContent = 'DO NOT SEND MONEY';
      $('money-result-sub').textContent = `${byName} says they are NOT asking you for money. This call may be a scam.`;
    } else {
      box.className = 'result-box amber';
      setIcon('money-result-icon', 'alert-triangle');
      $('money-result-status').textContent = 'No Response';
      $('money-result-title').textContent = 'Could not verify';
      $('money-result-sub').textContent = `${byName} did not respond in time. Do not send money without confirming another way.`;
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
  } else if (pending.circleId && pending.deviceId) {
    connectWs(pending.deviceId);
    $('join-waiting-circle-name').textContent = pending.circleName;
    showView('join-waiting');
    startJoinPolling();
  } else {
    showView('onboarding');
  }
})();
