const API = '/admin/api';
let bootstrap = { settings: {}, actions: [], servers: [], prompts: [] };

function token() {
  return localStorage.getItem('va_token') ?? '';
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token()}`,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function loadBootstrap() {
  try {
    bootstrap = await api('/bootstrap');
    renderSettings();
    renderPromptKeys();
    renderActions();
    renderServers();
  } catch (e) {
    alert(`Bootstrap fehlgeschlagen: ${e.message}`);
  }
}

function showTab(name) {
  document.querySelectorAll('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  const titles = { settings: 'Grundeinstellungen', monitor: 'Monitor / Test', actions: 'Vorgänge', mcp: 'MCP-Registry', logs: 'Logs' };
  $('tab-title').textContent = titles[name] ?? '';
  if (name === 'logs') loadLogs();
}

function renderSettings() {
  const form = $('settings-form');
  form.innerHTML = '';
  for (const [key, value] of Object.entries(bootstrap.settings)) {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = key;
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.key = key;
    input.value = value;
    wrap.append(label, input);
    form.append(wrap);
  }
}

function renderPromptKeys() {
  const select = $('prompt-key');
  select.innerHTML = '';
  for (const p of bootstrap.prompts) {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = p.key;
    select.append(opt);
  }
  select.onchange = () => {
    const p = bootstrap.prompts.find((x) => x.key === select.value);
    $('prompt-content').value = p ? p.content : '';
  };
  select.onchange();
}

function renderActions() {
  const tbody = $('actions-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const a of bootstrap.actions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(a.name)}</td>
      <td><span class="badge">${esc(a.mode)}</span></td>
      <td>${esc((a.triggers ?? []).join(', '))}</td>
      <td>${a.enabled ? '✔' : '✖'}</td>
      <td class="actions"><button class="btn small">Bearbeiten</button></td>`;
    tr.querySelector('button').onclick = () => openActionEditor(a.id);
    tbody.append(tr);
  }
}

function openActionEditor(id) {
  const a = id ? bootstrap.actions.find((x) => x.id === id) : null;
  $('action-editor').classList.remove('hidden');
  $('action-editor-title').textContent = a ? `Vorgang: ${a.name}` : 'Neuer Vorgang';
  $('action-id').value = a?.id ?? '';
  $('action-name').value = a?.name ?? '';
  $('action-mode').value = a?.mode ?? 'llm';
  $('action-triggers').value = (a?.triggers ?? []).join('\n');
  $('action-threshold').value = a?.fuzzy_threshold ?? '';
  $('action-system').value = a?.system_prompt ?? '';
  $('action-template').value = a?.template ?? '';
  $('action-tools').value = (a?.toolList ?? []).join('\n');
  $('action-enabled').checked = a ? !!a.enabled : true;
}

function actionPayload() {
  const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
  const threshold = $('action-threshold').value.trim();
  return {
    name: $('action-name').value.trim(),
    mode: $('action-mode').value,
    trigger_phrases: lines($('action-triggers').value),
    fuzzy_threshold: threshold === '' ? null : Number(threshold),
    system_prompt: $('action-system').value.trim() || null,
    template: $('action-template').value.trim() || null,
    tools: lines($('action-tools').value),
    enabled: $('action-enabled').checked,
  };
}

async function saveAction() {
  const payload = actionPayload();
  const id = $('action-id').value;
  if (id) await api(`/actions/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  else await api('/actions', { method: 'POST', body: JSON.stringify(payload) });
  await loadBootstrap();
  $('action-editor').classList.add('hidden');
}

async function deleteActionUi() {
  const id = $('action-id').value;
  if (!id || !confirm('Vorgang wirklich löschen?')) return;
  await api(`/actions/${id}`, { method: 'DELETE' });
  await loadBootstrap();
  $('action-editor').classList.add('hidden');
}

function renderServers() {
  const tbody = $('mcp-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const s of bootstrap.servers) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(s.name)}</td>
      <td>${esc(s.url)}</td>
      <td>${s.enabled ? '✔' : '✖'}</td>
      <td class="actions"><button class="btn small">Bearbeiten</button></td>`;
    tr.querySelector('button').onclick = () => openServerEditor(s.id);
    tbody.append(tr);
  }
}

function openServerEditor(id) {
  const s = id ? bootstrap.servers.find((x) => x.id === id) : null;
  $('mcp-editor').classList.remove('hidden');
  $('mcp-editor-title').textContent = s ? `MCP-Server: ${s.name}` : 'Neuer MCP-Server';
  $('mcp-id').value = s?.id ?? '';
  $('mcp-name').value = s?.name ?? '';
  $('mcp-url').value = s?.url ?? '';
  $('mcp-token').value = '';
  $('mcp-enabled').checked = s ? !!s.enabled : true;
  $('mcp-tools').innerHTML = '';
}

async function saveServer() {
  const payload = {
    name: $('mcp-name').value.trim(),
    url: $('mcp-url').value.trim(),
    enabled: $('mcp-enabled').checked,
  };
  if ($('mcp-token').value) payload.auth_token = $('mcp-token').value;
  const id = $('mcp-id').value;
  if (id) await api(`/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  else await api('/mcp-servers', { method: 'POST', body: JSON.stringify(payload) });
  await loadBootstrap();
  $('mcp-editor').classList.add('hidden');
}

async function healthServer() {
  const id = $('mcp-id').value;
  if (!id) {
    alert('Bitte zuerst speichern.');
    return;
  }
  $('mcp-tools').textContent = 'Abfrage läuft…';
  try {
    const res = await api(`/mcp-servers/${id}/health`, { method: 'POST' });
    $('mcp-tools').innerHTML = res.ok
      ? res.tools.map((t) => `<div>${esc(t)}</div>`).join('')
      : `<div class="error-text">${esc(res.error)}</div>`;
  } catch (e) {
    $('mcp-tools').innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
  }
}

async function deleteServer() {
  const id = $('mcp-id').value;
  if (!id || !confirm('MCP-Server wirklich löschen?')) return;
  await api(`/mcp-servers/${id}`, { method: 'DELETE' });
  await loadBootstrap();
  $('mcp-editor').classList.add('hidden');
}

async function sendTest() {
  const text = $('test-text').value.trim();
  if (!text) return;
  $('test-send').disabled = true;
  $('test-result').innerHTML = '<div class="test-meta">Verarbeite…</div>';
  $('test-trace').innerHTML = '';
  try {
    const res = await api('/query', { method: 'POST', body: JSON.stringify({ sessionId: 'monitor', text }) });
    const r = res.response;
    const badge = res.route === 'action' ? 'badge action' : 'badge agent';
    $('test-result').innerHTML = `
      <div class="test-answer">${esc(r.speech)}</div>
      <div class="test-meta">
        Route: <span class="${badge}">${esc(res.route)}</span>
        ${res.score ? `Score: ${Number(res.score).toFixed(2)}` : ''}
        Dauer: ${res.durationMs} ms
        ${r.followUp ? '· Rückfrage (Session offen)' : ''}
      </div>`;
    $('test-trace').innerHTML = (res.trace ?? [])
      .map((t) => `<li><span class="ts">${new Date(t.ts).toLocaleTimeString()}</span>${esc(t.step)} <pre>${esc(t.detail ? JSON.stringify(t.detail) : '')}</pre></li>`)
      .join('');
  } catch (e) {
    $('test-result').innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
  } finally {
    $('test-send').disabled = false;
  }
}

async function loadLogs() {
  try {
    const res = await api('/logs?limit=50');
    const tbody = $('logs-table').querySelector('tbody');
    tbody.innerHTML = '';
    for (const l of res.logs) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(l.ts)}</td>
        <td><span class="badge ${l.route === 'action' ? 'action' : 'agent'}">${esc(l.route)}</span></td>
        <td>${esc(l.query)}</td>
        <td>${esc(String(l.response ?? '').slice(0, 120))}</td>
        <td>${l.duration_ms} ms</td>`;
      tbody.append(tr);
    }
  } catch (e) {
    alert(`Logs fehlgeschlagen: ${e.message}`);
  }
}

function init() {
  document.querySelectorAll('.sidebar nav a').forEach((a) => (a.onclick = () => showTab(a.dataset.tab)));
  $('token').value = token();
  $('token-save').onclick = () => {
    localStorage.setItem('va_token', $('token').value);
    loadBootstrap();
  };
  $('settings-save').onclick = async () => {
    const settings = {};
    $('settings-form').querySelectorAll('input[data-key]').forEach((i) => (settings[i.dataset.key] = i.value));
    await api('/settings', { method: 'PUT', body: JSON.stringify({ settings }) });
    await loadBootstrap();
  };
  $('prompt-save').onclick = async () => {
    await api(`/prompts/${$('prompt-key').value}`, {
      method: 'PUT',
      body: JSON.stringify({ content: $('prompt-content').value }),
    });
    await loadBootstrap();
  };
  $('test-send').onclick = sendTest;
  $('test-text').onkeydown = (e) => { if (e.key === 'Enter') sendTest(); };
  $('action-new').onclick = () => openActionEditor(null);
  $('action-save').onclick = saveAction;
  $('action-delete').onclick = deleteActionUi;
  $('mcp-new').onclick = () => openServerEditor(null);
  $('mcp-save').onclick = saveServer;
  $('mcp-health').onclick = healthServer;
  $('mcp-delete').onclick = deleteServer;
  $('logs-refresh').onclick = loadLogs;
  loadBootstrap();
}

init();
