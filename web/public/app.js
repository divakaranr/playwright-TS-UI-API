// Playwright Test Console – hosted client. No external dependencies.
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const store = {
  get: (area, key) => {
    try {
      return window[area].getItem(key);
    } catch {
      return null;
    }
  },
  set: (area, key, value) => {
    try {
      if (value) window[area].setItem(key, value);
      else window[area].removeItem(key);
    } catch {
      /* storage unavailable – fine */
    }
  },
};
const KEY_PATTERN = /^[\x21-\x7E]{8,512}$/;
const PLAYWRIGHT_VERSION = '1.65.1';

let runController;
let counters;
let files = new Map();
let lastRun;
const modelsCache = {};

// ---------------------------------------------------------------- helpers
async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    credentials: 'same-origin',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, data };
}
const errorsOf = (data) => data.errors || [data.error || 'Request failed'];
const showErrors = (el, errors) => (el.innerHTML = (errors || []).map((e) => '• ' + esc(e)).join('<br>'));

function markdown(md) {
  const lines = esc(md).split('\n');
  let html = '';
  let i = 0;
  let list = false;
  const inline = (t) =>
    t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l)) {
      if (list) {
        html += '</ul>';
        list = false;
      }
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      html +=
        '<table>' +
        rows
          .filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r))
          .map(
            (r, n) =>
              '<tr>' +
              r
                .trim()
                .slice(1, -1)
                .split('|')
                .map((c) => (n ? '<td>' : '<th>') + inline(c.trim()) + (n ? '</td>' : '</th>'))
                .join('') +
              '</tr>',
          )
          .join('') +
        '</table>';
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    const li = /^\s*[-*]\s+(.*)$/.exec(l);
    if (li) {
      if (!list) {
        html += '<ul>';
        list = true;
      }
      html += '<li>' + inline(li[1]) + '</li>';
    } else {
      if (list) {
        html += '</ul>';
        list = false;
      }
      if (h) html += `<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`;
      else if (l.trim()) html += '<p>' + inline(l) + '</p>';
    }
    i++;
  }
  return html + (list ? '</ul>' : '');
}

// ---------------------------------------------------------------- zip (store, no compression)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(entries) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

function projectEntries() {
  const origin = new URL(lastRun.targetUrl).origin;
  const entries = [
    [
      'package.json',
      JSON.stringify(
        {
          name: 'generated-playwright-tests',
          private: true,
          scripts: { test: 'playwright test', report: 'playwright show-report' },
          devDependencies: { '@playwright/test': PLAYWRIGHT_VERSION },
        },
        null,
        2,
      ) + '\n',
    ],
    [
      'playwright.config.ts',
      `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? '${origin}',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`,
    ],
    ['.gitignore', 'node_modules/\ntest-results/\nplaywright-report/\n'],
    [
      'README.md',
      `# Generated Playwright tests

Target: ${origin}
Generated: ${new Date().toISOString()}

> Generated by an AI agent – **review the tests before relying on them**.

\`\`\`bash
npm install
npx playwright install chromium
npx playwright test            # BASE_URL=https://other-env.example.com npx playwright test
npx playwright show-report
\`\`\`

## Request

${lastRun.prompt}
`,
    ],
    ...[...files].map(([name, code]) => [`tests/${name}`, code]),
  ];
  if (lastRun.report) entries.push(['report.md', lastRun.report]);
  return entries;
}

// ---------------------------------------------------------------- model settings
function keyFor(provider) {
  return store.get('sessionStorage', 'pwc.key.' + provider) || '';
}
function renderModels() {
  const provider = $('provider').value;
  const models = modelsCache[provider];
  const select = $('model');
  const previous = select.value || store.get('localStorage', 'pwc.model.' + provider) || '';
  if (!models) {
    select.innerHTML = '<option value="">Load the models first</option>';
    $('modelHint').textContent = '';
    return;
  }
  const filter = $('modelFilter').value.trim().toLowerCase();
  const shown = models.filter(
    (m) => !filter || m.id.toLowerCase().includes(filter) || (m.name || '').toLowerCase().includes(filter),
  );
  select.innerHTML =
    '<option value="">Choose a model…</option>' +
    shown
      .map(
        (m) =>
          `<option value="${esc(m.id)}">${esc(m.id)}${m.name ? ' — ' + esc(m.name) : ''}${
            m.contextLength ? ' · ' + Math.round(m.contextLength / 1000) + 'k ctx' : ''
          }</option>`,
      )
      .join('');
  if (shown.some((m) => m.id === previous)) select.value = previous;
  $('modelHint').textContent = `${shown.length} of ${models.length} models with tool calling`;
}
async function loadModels() {
  const provider = $('provider').value;
  const apiKey = $('apiKey').value.trim();
  if (apiKey && !KEY_PATTERN.test(apiKey)) {
    $('modelHint').textContent = 'API key: 8–512 printable characters without spaces';
    return;
  }
  $('loadModels').disabled = true;
  $('modelHint').textContent = 'Loading models…';
  try {
    const { ok, data } = await api('/api/models', 'POST', { provider, ...(apiKey ? { apiKey } : {}) });
    if ($('provider').value !== provider) return;
    if (!ok) {
      $('modelHint').textContent = errorsOf(data).join(' · ');
      return;
    }
    modelsCache[provider] = data.models;
    renderModels();
  } finally {
    $('loadModels').disabled = false;
  }
}
function onProviderChange() {
  const provider = $('provider').value;
  store.set('localStorage', 'pwc.provider', provider);
  $('apiKey').value = keyFor(provider);
  $('apiKey').placeholder =
    provider === 'openrouter' ? 'sk-or-…' : provider === 'openai' ? 'sk-…' : 'sk-ant-…';
  $('modelFilter').value = '';
  renderModels();
  if (!modelsCache[provider] && (provider === 'openrouter' || $('apiKey').value)) loadModels();
}

// ---------------------------------------------------------------- run
function add(cls, html) {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = html;
  $('timeline').appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
}
function setSummary(status) {
  const c = counters;
  const cls =
    status === 'completed' ? 'ok' : status === 'running' ? '' : status === 'refused' ? 'warn' : 'bad';
  $('summary').innerHTML =
    `<span class="pill ${cls}">${esc(status)}</span><span class="pill">steps ${c.steps}</span>` +
    `<span class="pill">tool calls ${c.tools}</span><span class="pill">files ${files.size}</span>` +
    `<span class="pill">tokens ${c.tokens}</span>`;
}
function renderFiles() {
  $('downloadZip').disabled = files.size === 0;
  if (files.size === 0) {
    $('files').innerHTML = '<li class="empty">No test files yet.</li>';
    return;
  }
  $('files').innerHTML = [...files.keys()]
    .map(
      (name) =>
        `<li><div class="file-row"><strong>${esc(name)}</strong>` +
        `<button type="button" data-download="${esc(name)}">Download</button></div>` +
        `<details><summary>view code</summary><pre>${esc(files.get(name))}</pre></details></li>`,
    )
    .join('');
  $('files')
    .querySelectorAll('[data-download]')
    .forEach((b) =>
      b.addEventListener('click', () =>
        download(b.dataset.download, new Blob([files.get(b.dataset.download)], { type: 'text/plain' })),
      ),
    );
}
function handle(e) {
  switch (e.type) {
    case 'status':
      add('note', esc(e.message));
      break;
    case 'thinking':
      add('note', '💭 ' + esc(e.text));
      break;
    case 'tool_call':
      counters.tools++;
      counters.steps = Math.max(counters.steps, e.step);
      add(
        'tool',
        `<span class="meta">step ${e.step}</span> <strong>${esc(e.name)}</strong><details><summary>arguments</summary><pre>${esc(
          JSON.stringify(e.args, null, 2),
        )}</pre></details>`,
      );
      break;
    case 'tool_result':
      add(
        e.ok ? 'ok' : 'fail',
        `<span class="meta">${e.ok ? '✓' : '✗'} ${esc(e.name)}</span><details><summary>output</summary><pre>${esc(e.text)}</pre></details>`,
      );
      break;
    case 'screenshot':
      if (/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(e.dataUrl))
        add(
          'shot',
          `<span class="meta">📷 ${esc(e.caption)}</span><img src="${e.dataUrl}" alt="screenshot ${esc(e.caption)}" />`,
        );
      break;
    case 'file':
      files.set(e.name, e.code);
      renderFiles();
      add('ok', `📄 saved <strong>${esc(e.name)}</strong>`);
      break;
    case 'usage':
      counters.tokens = e.inputTokens + e.outputTokens;
      break;
    case 'report':
      lastRun.report = e.markdown;
      $('report').classList.remove('empty');
      $('report').innerHTML = markdown(e.markdown);
      $('downloadReport').disabled = false;
      break;
    case 'error':
      add('fail', '⚠ ' + esc(e.message));
      break;
    case 'done':
      setSummary(e.status);
      return;
    default:
      return; // ping and unknown events
  }
  setSummary('running');
}
function resetRunView() {
  counters = { steps: 0, tools: 0, tokens: 0 };
  files = new Map();
  $('timeline').innerHTML = '';
  renderFiles();
  $('report').className = 'empty';
  $('report').textContent = 'The report appears here when the run finishes.';
  $('downloadReport').disabled = true;
  setSummary('running');
}
function clientCheck(body) {
  const errors = [];
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?([/?#]\S*)?$/.test(body.targetUrl))
    errors.push('Website URL: use an http(s) URL such as https://example.com/');
  if (body.prompt.length < 10 || body.prompt.length > 2000) errors.push('Prompt: 10–2000 characters');
  if (/<\s*\/?\s*[a-z]+[\s>]|javascript\s*:|\bon[a-z]{3,20}\s*=/i.test(body.prompt))
    errors.push('Prompt: HTML/script content is not allowed');
  if (!KEY_PATTERN.test(body.apiKey)) errors.push('API key: required (8–512 printable characters)');
  if (!body.model) errors.push('Model: load the models and choose one');
  return errors;
}
async function startRun(ev) {
  ev.preventDefault();
  $('formError').textContent = '';
  const body = {
    targetUrl: $('targetUrl').value.trim(),
    prompt: $('prompt').value.trim(),
    mode: document.querySelector('input[name=mode]:checked').value,
    maxSteps: Number($('maxSteps').value) || 20,
    provider: $('provider').value,
    model: $('model').value,
    apiKey: $('apiKey').value.trim(),
  };
  const quick = clientCheck(body);
  if (quick.length) return showErrors($('formError'), quick);
  store.set('localStorage', 'pwc.url', body.targetUrl);
  store.set('localStorage', 'pwc.model.' + body.provider, body.model);
  store.set('sessionStorage', 'pwc.key.' + body.provider, body.apiKey);

  lastRun = { targetUrl: body.targetUrl, prompt: body.prompt, report: '' };
  resetRunView();
  $('start').disabled = true;
  $('cancel').disabled = false;
  runController = new AbortController();
  let finished = false;
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: runController.signal,
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return showSignIn();
      showErrors($('formError'), errorsOf(data));
      setSummary('failed');
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'done') finished = true;
        handle(event);
      }
    }
    if (!finished) {
      add('fail', '⚠ The connection ended before the run finished.');
      setSummary('failed');
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      add('note', 'Cancelled.');
      setSummary('cancelled');
    } else {
      add('fail', '⚠ ' + esc(error.message));
      setSummary('failed');
    }
  } finally {
    $('start').disabled = false;
    $('cancel').disabled = true;
    runController = undefined;
  }
}

// ---------------------------------------------------------------- auth & boot
function showSignIn(message) {
  $('signin').hidden = false;
  $('app').hidden = true;
  $('userBox').hidden = true;
  if (message) $('authError').textContent = message;
}
async function boot() {
  const params = new URLSearchParams(location.search);
  const authError = params.get('auth_error');
  if (authError) history.replaceState(null, '', '/');
  const me = await api('/api/me');
  if (!me.ok) {
    if (me.status === 503) return showSignIn(errorsOf(me.data).join(' · '));
    return showSignIn(authError ? authError.slice(0, 200) : '');
  }
  $('signin').hidden = true;
  $('app').hidden = false;
  $('userBox').hidden = false;
  $('userEmail').textContent = me.data.email;

  $('provider').value = store.get('localStorage', 'pwc.provider') || 'openrouter';
  $('targetUrl').value = store.get('localStorage', 'pwc.url') || '';
  onProviderChange();
}

$('provider').addEventListener('change', onProviderChange);
$('loadModels').addEventListener('click', loadModels);
$('modelFilter').addEventListener('input', renderModels);
$('model').addEventListener('change', () =>
  store.set('localStorage', 'pwc.model.' + $('provider').value, $('model').value),
);
$('apiKey').addEventListener('change', () => {
  const key = $('apiKey').value.trim();
  if (KEY_PATTERN.test(key)) {
    store.set('sessionStorage', 'pwc.key.' + $('provider').value, key);
    if (!modelsCache[$('provider').value]) loadModels();
  }
});
$('forgetKey').addEventListener('click', () => {
  store.set('sessionStorage', 'pwc.key.' + $('provider').value, '');
  $('apiKey').value = '';
});
$('prompt').addEventListener('input', () => ($('promptCount').textContent = $('prompt').value.length));
document.querySelectorAll('[data-example]').forEach((b) =>
  b.addEventListener('click', () => {
    $('prompt').value = b.dataset.example;
    $('promptCount').textContent = $('prompt').value.length;
  }),
);
$('form').addEventListener('submit', startRun);
$('cancel').addEventListener('click', () => runController && runController.abort());
$('downloadZip').addEventListener('click', () => {
  const host = new URL(lastRun.targetUrl).hostname.replace(/[^a-z0-9.-]/gi, '');
  download(`playwright-tests-${host}.zip`, makeZip(projectEntries()));
});
$('downloadReport').addEventListener('click', () =>
  download('report.md', new Blob([lastRun.report], { type: 'text/markdown' })),
);
$('logout').addEventListener('click', async () => {
  await api('/api/auth/logout', 'POST');
  ['openrouter', 'openai', 'anthropic'].forEach((p) => store.set('sessionStorage', 'pwc.key.' + p, ''));
  showSignIn('Signed out.');
});
boot();
