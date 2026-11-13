const $ = (id) => document.getElementById(id);

let selectedHours = new Set([9, 12, 15, 18, 21]);

function setConsole(text) {
  $('actionOutput').textContent = text;
}

function renderHoursGrid() {
  const grid = $('hoursGrid');
  grid.innerHTML = '';
  for (let h = 0; h < 24; h += 3) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hour-chip' + (selectedHours.has(h) ? ' is-on' : '');
    const label = h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
    btn.textContent = label;
    btn.dataset.hour = String(h);
    btn.addEventListener('click', () => {
      if (selectedHours.has(h)) selectedHours.delete(h);
      else selectedHours.add(h);
      renderHoursGrid();
    });
    grid.appendChild(btn);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

async function refreshStatus() {
  try {
    const data = await api('/api/status');
    const pill = $('timerPill');
    const isActive = data.timer?.active;
    pill.dataset.state = isActive ? 'active' : 'inactive';
    pill.textContent = isActive ? '● Timer Active (systemd)' : '● Timer Paused';

    $('mTimerState').textContent = isActive ? 'ACTIVE' : (data.timer?.state || 'INACTIVE').toUpperCase();
    $('mNextTrigger').textContent = data.timer?.nextTrigger ? data.timer.nextTrigger.replace(/\s+\w+$/, '') : 'Not scheduled';
    $('mVaultState').textContent = data.vault?.exists && data.vault?.hasConsumerKey ? `Locked (${data.vault.consumerKeyPreview})` : 'Missing Consumer Key';

    const connected = (data.accounts || []).filter(a => a.connected);
    $('mConnectedCount').textContent = `${connected.length} / ${(data.accounts || []).length}`;

    if (Array.isArray(data.timer?.scheduleHours) && data.timer.scheduleHours.length) {
      selectedHours = new Set(data.timer.scheduleHours);
      renderHoursGrid();
    }

    const list = $('accountsList');
    list.innerHTML = '';
    const select = $('postHandle');
    const prevHandle = select.value;
    select.innerHTML = '';

    for (const acc of data.accounts || []) {
      const row = document.createElement('div');
      row.className = 'account-row';

      const lastHtml = acc.lastPost?.url
        ? `<a href="${acc.lastPost.url}" target="_blank" rel="noopener">Last post ↗</a> · ${new Date(acc.lastPost.at).toLocaleString()}`
        : 'No posts dispatched yet';

      row.innerHTML = `
        <div class="account-meta">
          <span class="account-handle">@${acc.handle}</span>
          <span class="account-sub">Day ${acc.day}/90 · Slot ${acc.nextSlot}/5 · ${acc.totalPosts} posts</span>
          <span class="account-sub">${lastHtml}</span>
        </div>
        <span class="status-pill" data-state="${acc.connected ? 'active' : 'inactive'}">
          ${acc.connected ? `Connected (${acc.tokenPreview})` : 'Standby'}
        </span>
      `;
      list.appendChild(row);

      if (acc.connected) {
        const opt = document.createElement('option');
        opt.value = acc.handle;
        opt.textContent = `@${acc.handle}`;
        select.appendChild(opt);
      }
    }
    if (prevHandle) select.value = prevHandle;

    $('logsBox').textContent = (data.logs && data.logs.length)
      ? data.logs.join('\n')
      : 'No journal entries yet for x-multi-hub.service.';
  } catch (err) {
    setConsole(`❌ Status error: ${err.message}`);
  }
}

async function runSlot(dryRun) {
  setConsole(dryRun ? 'Running dry-run preview…' : 'Dispatching live slot via x_multi_hub.mjs…');
  try {
    const res = await api('/api/run-slot', {
      method: 'POST',
      body: JSON.stringify({ dryRun })
    });
    setConsole(res.output || 'Done.');
    await refreshStatus();
  } catch (err) {
    setConsole(`❌ ${err.message}`);
  }
}

async function controlTimer(action, extra = {}) {
  setConsole(`Updating x-multi-hub.timer (${action})…`);
  try {
    const res = await api('/api/timer', {
      method: 'POST',
      body: JSON.stringify({ action, ...extra })
    });
    setConsole(`✅ ${res.message}`);
    await refreshStatus();
  } catch (err) {
    setConsole(`❌ ${err.message}`);
  }
}

$('refreshBtn').addEventListener('click', refreshStatus);
$('btnDryRun').addEventListener('click', () => runSlot(true));
$('btnRunSlot').addEventListener('click', () => runSlot(false));
$('btnStartTimer').addEventListener('click', () => controlTimer('start'));
$('btnStopTimer').addEventListener('click', () => controlTimer('stop'));
$('btnSaveSchedule').addEventListener('click', () => controlTimer('schedule', { hours: Array.from(selectedHours) }));

$('postText').addEventListener('input', (e) => {
  $('charCount').textContent = `${e.target.value.length} / 280`;
});

async function submitPost(dryRun) {
  const handle = $('postHandle').value;
  const text = $('postText').value.trim();
  if (!handle || !text) return;
  setConsole(dryRun ? 'Generating post preview…' : `Posting to @${handle}…`);
  try {
    const res = await api('/api/post-now', {
      method: 'POST',
      body: JSON.stringify({ handle, text, dryRun })
    });
    if (dryRun) {
      setConsole(`✅ Dry-Run Preview for @${res.handle} (${res.length}/280 chars):\n\n${res.preview}`);
    } else {
      setConsole(`✅ Live on X: ${res.url}`);
      $('postText').value = '';
      $('charCount').textContent = '0 / 280';
      await refreshStatus();
    }
  } catch (err) {
    setConsole(`❌ ${err.message}`);
  }
}

$('btnPostDry').addEventListener('click', () => submitPost(true));
$('postForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitPost(false);
});

$('vaultForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setConsole('Saving credentials to Zoth Vault (~/.config/zoth-vault/x.env)…');
  try {
    const res = await api('/api/config/account', {
      method: 'POST',
      body: JSON.stringify({
        handle: $('cfgHandle').value.trim(),
        accessToken: $('cfgAccessToken').value.trim(),
        accessSecret: $('cfgAccessSecret').value.trim(),
        apiKey: $('cfgApiKey').value.trim() || undefined,
        apiSecret: $('cfgApiSecret').value.trim() || undefined
      })
    });
    $('vaultForm').reset();
    setConsole(`✅ ${res.message}`);
    await refreshStatus();
  } catch (err) {
    setConsole(`❌ ${err.message}`);
  }
});

renderHoursGrid();
refreshStatus();
