/* StickyPrinter — main client-side application
 * Single-page app with hash-based routing.
 */
'use strict';

// ── State ────────────────────────────────────────────────────
const state = {
  user: null,          // moderator session
  participant: JSON.parse(localStorage.getItem('participant') || 'null'),
  participantToken: localStorage.getItem('participantToken') || null,
  workshop: JSON.parse(localStorage.getItem('workshop') || 'null'),
};

function setParticipantSession(token, participant, workshop) {
  state.participantToken = token;
  state.participant = participant;
  state.workshop = workshop;
  localStorage.setItem('participantToken', token);
  localStorage.setItem('participant', JSON.stringify(participant));
  localStorage.setItem('workshop', JSON.stringify(workshop));
}

let sseConnection = null; // active moderator SSE stream, closed on every navigation

function clearParticipantSession() {
  state.participant = null;
  state.participantToken = null;
  state.workshop = null;
  localStorage.removeItem('participantToken');
  localStorage.removeItem('participant');
  localStorage.removeItem('workshop');
}

// ── Utilities ────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (state.participantToken) {
    opts.headers['Authorization'] = `Bearer ${state.participantToken}`;
  }
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  return data;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'className') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    e.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return e;
}

function navigate(hash) { location.hash = hash; }

async function joinWorkshop(code, name) {
  const result = await api('POST', `/workshops/${code}/join`, { name });
  setParticipantSession(result.token, result.participant, result.workshop);
  navigate(`#workshop/${code}`);
}

function showToast(title, body, type = '') {
  const container = document.getElementById('toast-container') ||
    (() => { const c = el('div', { id: 'toast-container', className: 'toast-container' }); document.body.appendChild(c); return c; })();
  const toast = el('div', { className: `toast ${type ? 'toast-' + type : ''}` },
    el('div', { className: 'toast-title' }, title),
    body ? el('div', { className: 'toast-body' }, body) : null,
  );
  container.prepend(toast);
  setTimeout(() => toast.remove(), 5000);
}

function shortPreview(text, len = 60) {
  if (!text) return '(no text)';
  return text.length > len ? text.substring(0, len) + '…' : text;
}

function formatDate(iso) {
  if (!iso) return '';
  // SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" (UTC, space-separated) —
  // normalize to strict ISO 8601 so Date parsing is reliable across browsers.
  const normalized = iso.replace(' ', 'T');
  const d = new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z');
  return d.toLocaleString();
}

// ── Navigation bar ───────────────────────────────────────────
function renderNav() {
  const items = [];
  if (state.user) {
    items.push(el('span', {}, `👤 ${state.user.username}`));
    items.push(el('button', { className: 'nav-link', onclick: doLogout }, 'Log out'));
  } else if (state.participant) {
    items.push(el('span', {}, `🙋 ${state.participant.name}`));
    items.push(el('button', { className: 'nav-link', onclick: () => navigate(`#workshop/${state.workshop?.code}`) }, 'My stickies'));
  } else {
    items.push(el('a', { href: '#moderator/login' }, 'Moderator login'));
  }
  return el('nav', {},
    el('a', { href: '#', className: 'brand' },
      el('span', { className: 'brand-icon' }, '📌'),
      'StickyPrinter',
    ),
    el('span', { className: 'nav-spacer' }),
    ...items,
  );
}

async function doLogout() {
  await api('POST', '/auth/logout').catch(() => {});
  state.user = null;
  clearParticipantSession();
  navigate('#');
}

// ── Router ───────────────────────────────────────────────────
async function router() {
  if (sseConnection) { sseConnection.close(); sseConnection = null; }

  const hash = location.hash.replace(/^#\/?/, '') || '';
  const parts = hash.split('/');
  const view = parts[0];

  let content;
  try {
    if (!view || view === '') {
      content = await renderHome();
    } else if (view === 'moderator') {
      if (parts[1] === 'login') content = renderModeratorLogin();
      else if (parts[1] === 'register') content = renderModeratorRegister();
      else if (parts[1] === 'dashboard') content = await renderModeratorDashboard();
      else if (parts[1] === 'workshop' && parts[2]) content = await renderModeratorWorkshop(parts[2]);
      else if (parts[1] === 'sticky' && parts[2]) content = await renderModeratorSticky(parts[2]);
      else content = await renderModeratorDashboard();
    } else if (view === 'join') {
      content = renderJoinWorkshop(parts[1] || '');
    } else if (view === 'workshop' && parts[1]) {
      content = await renderParticipantWorkshop(parts[1]);
    } else if (view === 'sticky') {
      content = await renderStickyEditor(parts[1]);
    } else {
      content = renderNotFound();
    }
  } catch (err) {
    console.error('Router error:', err);
    content = renderError(err.message);
  }

  const app = document.getElementById('app');
  app.innerHTML = '';
  app.appendChild(renderNav());
  app.appendChild(content);
}

// ── Home page ────────────────────────────────────────────────
async function renderHome() {
  // Check auth state
  try {
    state.user = await api('GET', '/auth/me');
  } catch (_) { state.user = null; }

  if (state.user) {
    return renderModeratorDashboard();
  }

  const workshopCodeInput = el('input', { type: 'text', placeholder: 'WS-ABCD-1234', id: 'join-code', style: { textTransform: 'uppercase', letterSpacing: '0.08em' } });
  const nameInput = el('input', { type: 'text', placeholder: 'Your name', id: 'join-name' });

  async function handleJoin(e) {
    e.preventDefault();
    const code = workshopCodeInput.value.trim().toUpperCase();
    const name = nameInput.value.trim();
    if (!code || !name) { showToast('Please fill in all fields', '', 'warning'); return; }
    try {
      await joinWorkshop(code, name);
    } catch (err) {
      showToast('Could not join workshop', err.message, 'warning');
    }
  }

  return el('div', { className: 'page' },
    el('div', { className: 'hero' },
      el('h1', {}, '📌 StickyPrinter'),
      el('p', {}, 'Create digital sticky notes and submit them to your workshop moderator for instant printing.'),
    ),
    el('div', { className: 'card', style: { maxWidth: '420px', margin: '0 auto' } },
      el('h2', {}, 'Join a Workshop'),
      el('form', { onsubmit: handleJoin },
        el('div', { className: 'form-group', style: { marginTop: '16px' } },
          el('label', {}, 'Workshop Code'),
          workshopCodeInput,
        ),
        el('div', { className: 'form-group' },
          el('label', {}, 'Your Name'),
          nameInput,
        ),
        el('button', { type: 'submit', className: 'btn btn-primary' }, 'Join Workshop'),
      ),
      el('div', { style: { marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--gray-200)', textAlign: 'center', fontSize: '0.85rem', color: 'var(--gray-600)' } },
        'Are you the moderator? ',
        el('a', { href: '#moderator/login' }, 'Log in here'),
      ),
    ),
  );
}

// ── Join Workshop page ───────────────────────────────────────
function renderJoinWorkshop(prefillCode) {
  const workshopCodeInput = el('input', { type: 'text', placeholder: 'WS-ABCD-1234', value: prefillCode, style: { textTransform: 'uppercase', letterSpacing: '0.08em' } });
  const nameInput = el('input', { type: 'text', placeholder: 'Your name' });

  async function handleJoin(e) {
    e.preventDefault();
    const code = workshopCodeInput.value.trim().toUpperCase();
    const name = nameInput.value.trim();
    if (!code || !name) { showToast('Please fill in all fields', '', 'warning'); return; }
    try {
      await joinWorkshop(code, name);
    } catch (err) {
      showToast('Could not join workshop', err.message, 'warning');
    }
  }

  return el('div', { className: 'page' },
    el('div', { className: 'card', style: { maxWidth: '420px', margin: '0 auto' } },
      el('h2', {}, 'Join a Workshop'),
      el('form', { onsubmit: handleJoin },
        el('div', { className: 'form-group', style: { marginTop: '16px' } },
          el('label', {}, 'Workshop Code'),
          workshopCodeInput,
        ),
        el('div', { className: 'form-group' },
          el('label', {}, 'Your Name'),
          nameInput,
        ),
        el('button', { type: 'submit', className: 'btn btn-primary' }, 'Join Workshop'),
      ),
    ),
  );
}

// ── Participant Workshop page ─────────────────────────────────
async function renderParticipantWorkshop(code) {
  if (!state.participantToken) {
    navigate('#join/' + code);
    return el('div', {});
  }

  let stickies = [];
  try {
    stickies = await api('GET', '/stickies/mine');
    if (!state.workshop || state.workshop.code !== code) {
      state.workshop = await api('GET', `/workshops/${code}`);
    }
  } catch (err) {
    if (err.status === 401) {
      clearParticipantSession();
      navigate('#join/' + code);
      return el('div', {});
    }
    throw err;
  }

  async function createNewSticky() {
    try {
      const sticky = await api('POST', '/stickies');
      navigate(`#sticky/${sticky.id}`);
    } catch (err) {
      showToast('Could not create sticky', err.message, 'warning');
    }
  }

  const stickyCards = stickies.map((s) => {
    const statusClass = `status-${s.status}`;
    return el('div', { className: 'sticky-card', onclick: () => s.status === 'draft' && navigate(`#sticky/${s.id}`) },
      el('span', { className: `sticky-status ${statusClass}` }, s.status),
      s.image_data
        ? el('img', { src: s.image_data, style: { maxWidth: '100%', marginTop: '24px', borderRadius: '4px' } })
        : el('div', { className: 'sticky-body' }, shortPreview(s.content, 120)),
      el('div', { className: 'sticky-meta' }, formatDate(s.updated_at)),
    );
  });

  return el('div', { className: 'page' },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' } },
      el('div', {},
        el('h1', {}, state.workshop ? state.workshop.name : code),
        el('div', { className: 'workshop-code' }, code),
      ),
      el('span', { style: { flex: '1' } }),
      el('button', { className: 'btn btn-yellow btn-lg', onclick: createNewSticky }, '+ New Sticky'),
    ),
    stickies.length === 0
      ? el('div', { className: 'card', style: { textAlign: 'center', padding: '48px', color: 'var(--gray-600)' } },
          el('p', { style: { fontSize: '3rem', marginBottom: '12px' } }, '📝'),
          el('p', {}, 'No sticky notes yet. Create your first one!'),
        )
      : el('div', { className: 'sticky-grid' }, ...stickyCards),
  );
}

// ── Sticky Editor page ───────────────────────────────────────
async function renderStickyEditor(stickyId) {
  if (!state.participantToken) { navigate('#'); return el('div', {}); }

  let sticky;
  try {
    sticky = await api('GET', `/stickies/${stickyId}`);
  } catch (err) {
    return renderError('Could not load sticky: ' + err.message);
  }

  if (sticky.status !== 'draft') {
    return el('div', { className: 'page' },
      el('div', { className: 'card', style: { textAlign: 'center', padding: '32px' } },
        el('p', {}, `This sticky has been ${sticky.status} and cannot be edited.`),
        el('br'),
        el('button', { className: 'btn btn-ghost', onclick: () => history.back() }, '← Back'),
      ),
    );
  }

  // Canvas editor
  const canvas = el('canvas', { id: 'sticky-canvas', width: '600', height: '400' });
  const textArea = el('textarea', { placeholder: 'Write your sticky note text here…', style: { width: '100%', minHeight: '80px', marginTop: '12px', padding: '10px', border: '1.5px solid var(--gray-200)', borderRadius: 'var(--radius)', fontFamily: 'var(--font)', fontSize: '0.95rem' } });
  textArea.value = sticky.content || '';

  let activeTab = 'text';
  let editorInitialized = false;

  // Tab switching
  const tabText = el('button', { className: 'tool-btn active', onclick: () => switchTab('text') }, '📝 Text');
  const tabDraw = el('button', { className: 'tool-btn', onclick: () => switchTab('draw') }, '🎨 Draw');

  function switchTab(tab) {
    activeTab = tab;
    tabText.className = `tool-btn ${tab === 'text' ? 'active' : ''}`;
    tabDraw.className = `tool-btn ${tab === 'draw' ? 'active' : ''}`;
    textArea.style.display = tab === 'text' ? 'block' : 'none';
    canvasSection.style.display = tab === 'draw' ? 'block' : 'none';
    if (tab === 'draw' && !editorInitialized) {
      initCanvasEditor(canvas, sticky.image_data);
      editorInitialized = true;
    }
  }

  const canvasSection = el('div', { style: { display: 'none' } },
    el('div', { className: 'canvas-container' }, canvas),
  );

  async function saveSticky() {
    let imageData = null;
    if (editorInitialized) imageData = canvas.toDataURL('image/png');
    try {
      await api('PUT', `/stickies/${sticky.id}`, {
        content: textArea.value,
        image_data: imageData,
      });
      showToast('Saved!', '', 'success');
      history.back();
    } catch (err) {
      showToast('Save failed', err.message, 'warning');
    }
  }

  async function submitSticky() {
    let imageData = null;
    if (editorInitialized) imageData = canvas.toDataURL('image/png');
    if (!textArea.value.trim() && !imageData) {
      showToast('Cannot submit empty sticky', 'Add some text or draw something first.', 'warning');
      return;
    }
    try {
      await api('PUT', `/stickies/${sticky.id}`, {
        content: textArea.value,
        image_data: imageData,
      });
      await api('POST', `/stickies/${sticky.id}/submit`);
      showToast('Submitted!', 'Your sticky was sent to the moderator.', 'success');
      history.back();
    } catch (err) {
      showToast('Submit failed', err.message, 'warning');
    }
  }

  async function deleteSticky() {
    if (!confirm('Delete this sticky note?')) return;
    try {
      await api('DELETE', `/stickies/${sticky.id}`);
      showToast('Deleted', '', 'success');
      history.back();
    } catch (err) {
      showToast('Delete failed', err.message, 'warning');
    }
  }

  if (sticky.image_data) {
    switchTab('draw');
  }

  return el('div', { className: 'page' },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' } },
      el('button', { className: 'btn btn-ghost btn-sm', onclick: () => history.back() }, '← Back'),
      el('h2', {}, `Sticky #${sticky.participant_sticky_index}`),
    ),
    el('div', { className: 'card' },
      el('div', { style: { display: 'flex', gap: '8px', marginBottom: '16px' } }, tabText, tabDraw),
      textArea,
      canvasSection,
      el('div', { style: { display: 'flex', gap: '10px', marginTop: '20px', flexWrap: 'wrap' } },
        el('button', { className: 'btn btn-green', onclick: submitSticky }, '🚀 Submit to Moderator'),
        el('button', { className: 'btn btn-primary', onclick: saveSticky }, '💾 Save'),
        el('button', { className: 'btn btn-red', onclick: deleteSticky }, '🗑️ Delete'),
      ),
    ),
  );
}

// ── Canvas Editor ────────────────────────────────────────────
function initCanvasEditor(canvas, existingImageData) {
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let tool = 'pen';
  let color = '#222222';
  let lineWidth = 4;

  // Fill background white
  ctx.fillStyle = '#FFFDE7';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (existingImageData) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0);
    img.src = existingImageData;
  }

  // Build toolbar
  const toolbar = el('div', { className: 'canvas-toolbar' });

  const colorPicker = el('input', { type: 'color', value: color, title: 'Color' });
  colorPicker.addEventListener('input', () => { color = colorPicker.value; });

  const sizePicker = el('input', { type: 'range', min: '1', max: '30', value: String(lineWidth), title: 'Brush size' });
  sizePicker.addEventListener('input', () => { lineWidth = parseInt(sizePicker.value); });

  function makeToolBtn(name, label) {
    const btn = el('button', { className: `tool-btn ${tool === name ? 'active' : ''}`, onclick: () => {
      tool = name;
      document.querySelectorAll('.canvas-toolbar .tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }}, label);
    return btn;
  }

  const penBtn = makeToolBtn('pen', '✏️ Pen');
  const eraserBtn = makeToolBtn('eraser', '🧹 Eraser');

  const clearBtn = el('button', { className: 'tool-btn', onclick: () => {
    ctx.fillStyle = '#FFFDE7';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }}, '🗑️ Clear');

  // Text tool
  const textBtn = makeToolBtn('text', '🔤 Text');
  const textInput = el('input', { type: 'text', placeholder: 'Type text…', style: { padding: '4px 8px', border: '1px solid var(--gray-200)', borderRadius: '4px', fontSize: '0.85rem', display: 'none' } });

  toolbar.append(colorPicker, sizePicker, penBtn, eraserBtn, textBtn, textInput, clearBtn);
  canvas.parentElement.insertBefore(toolbar, canvas);

  // Canvas events
  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  function startDraw(e) {
    e.preventDefault();
    if (tool === 'text') {
      const pos = getPos(e);
      textInput.style.display = 'inline-block';
      textInput.focus();
      textInput.dataset.x = pos.x;
      textInput.dataset.y = pos.y;
      return;
    }
    drawing = true;
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  }

  function draw(e) {
    e.preventDefault();
    if (!drawing || tool === 'text') return;
    const pos = getPos(e);
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = color;
    ctx.lineWidth = tool === 'eraser' ? lineWidth * 3 : lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  }

  function stopDraw(e) {
    if (!drawing) return;
    e.preventDefault();
    drawing = false;
    ctx.globalCompositeOperation = 'source-over';
  }

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = textInput.value;
      if (text) {
        ctx.font = `${lineWidth * 4 + 12}px sans-serif`;
        ctx.fillStyle = color;
        ctx.fillText(text, parseFloat(textInput.dataset.x), parseFloat(textInput.dataset.y));
      }
      textInput.value = '';
      textInput.style.display = 'none';
    }
  });

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDraw);
  canvas.addEventListener('mouseleave', stopDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', draw, { passive: false });
  canvas.addEventListener('touchend', stopDraw, { passive: false });
}

// ── Moderator Login ──────────────────────────────────────────
function renderModeratorLogin() {
  const usernameInput = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username' });
  const passwordInput = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });

  async function handleLogin(e) {
    e.preventDefault();
    try {
      const data = await api('POST', '/auth/login', {
        username: usernameInput.value,
        password: passwordInput.value,
      });
      state.user = { username: data.username };
      navigate('#moderator/dashboard');
    } catch (err) {
      showToast('Login failed', err.message, 'warning');
    }
  }

  return el('div', { className: 'page' },
    el('div', { className: 'card', style: { maxWidth: '380px', margin: '0 auto' } },
      el('h2', {}, '🔐 Moderator Login'),
      el('form', { onsubmit: handleLogin, style: { marginTop: '16px' } },
        el('div', { className: 'form-group' }, el('label', {}, 'Username'), usernameInput),
        el('div', { className: 'form-group' }, el('label', {}, 'Password'), passwordInput),
        el('button', { type: 'submit', className: 'btn btn-primary' }, 'Log in'),
      ),
      el('div', { style: { marginTop: '16px', fontSize: '0.85rem', color: 'var(--gray-600)', textAlign: 'center' } },
        "Don't have an account? ",
        el('a', { href: '#moderator/register' }, 'Register here'),
      ),
    ),
  );
}

// ── Moderator Register ───────────────────────────────────────
function renderModeratorRegister() {
  const usernameInput = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username' });
  const passwordInput = el('input', { type: 'password', placeholder: 'Password (min. 6 chars)', autocomplete: 'new-password' });

  async function handleRegister(e) {
    e.preventDefault();
    try {
      const data = await api('POST', '/auth/register', {
        username: usernameInput.value,
        password: passwordInput.value,
      });
      state.user = { username: data.username };
      showToast('Account created!', `Welcome, ${data.username}`, 'success');
      navigate('#moderator/dashboard');
    } catch (err) {
      showToast('Registration failed', err.message, 'warning');
    }
  }

  return el('div', { className: 'page' },
    el('div', { className: 'card', style: { maxWidth: '380px', margin: '0 auto' } },
      el('h2', {}, '📋 Create Moderator Account'),
      el('form', { onsubmit: handleRegister, style: { marginTop: '16px' } },
        el('div', { className: 'form-group' }, el('label', {}, 'Username'), usernameInput),
        el('div', { className: 'form-group' }, el('label', {}, 'Password'), passwordInput),
        el('button', { type: 'submit', className: 'btn btn-primary' }, 'Create account'),
      ),
      el('div', { style: { marginTop: '16px', fontSize: '0.85rem', color: 'var(--gray-600)', textAlign: 'center' } },
        'Already have an account? ',
        el('a', { href: '#moderator/login' }, 'Log in'),
      ),
    ),
  );
}

// ── Moderator Dashboard ──────────────────────────────────────
async function renderModeratorDashboard() {
  if (!state.user) {
    try { state.user = await api('GET', '/auth/me'); }
    catch (_) { navigate('#moderator/login'); return el('div', {}); }
  }

  let workshops = [];
  try { workshops = await api('GET', '/workshops'); } catch (_) {}

  const nameInput = el('input', { type: 'text', placeholder: 'Workshop name' });

  async function createWorkshop(e) {
    e.preventDefault();
    if (!nameInput.value.trim()) { showToast('Enter a workshop name', '', 'warning'); return; }
    try {
      const ws = await api('POST', '/workshops', { name: nameInput.value.trim() });
      showToast('Workshop created!', `Code: ${ws.code}`, 'success');
      navigate(`#moderator/workshop/${ws.code}`);
    } catch (err) {
      showToast('Failed to create workshop', err.message, 'warning');
    }
  }

  const workshopCards = workshops.map(ws =>
    el('div', { className: 'card', style: { display: 'flex', alignItems: 'center', gap: '16px', padding: '16px', cursor: 'pointer' }, onclick: () => navigate(`#moderator/workshop/${ws.code}`) },
      el('div', { style: { flex: '1' } },
        el('strong', {}, ws.name),
        el('div', { className: 'workshop-code', style: { marginTop: '4px', fontSize: '1rem' } }, ws.code),
      ),
      el('span', { style: { fontSize: '1.4rem' } }, ws.autoprint ? '🖨️' : '👁️'),
    )
  );

  return el('div', { className: 'page' },
    el('h1', {}, `Welcome, ${state.user.username}!`),
    el('div', { className: 'card', style: { marginTop: '24px' } },
      el('h2', {}, 'Create New Workshop'),
      el('form', { onsubmit: createWorkshop, style: { display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap' } },
        el('div', { style: { flex: '1' } }, nameInput),
        el('button', { type: 'submit', className: 'btn btn-primary' }, '+ Create'),
      ),
    ),
    workshops.length > 0
      ? el('div', { style: { marginTop: '24px' } },
          el('h2', {}, 'Your Workshops'),
          el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px' } }, ...workshopCards),
        )
      : el('div', { className: 'card', style: { marginTop: '24px', textAlign: 'center', padding: '40px', color: 'var(--gray-600)' } },
          el('p', {}, 'No workshops yet. Create your first one above!'),
        ),
  );
}

// ── Moderator Workshop view ──────────────────────────────────
async function renderModeratorWorkshop(code) {
  if (!state.user) {
    try { state.user = await api('GET', '/auth/me'); }
    catch (_) { navigate('#moderator/login'); return el('div', {}); }
  }

  let workshop, stickies = [];
  try {
    workshop = await api('GET', `/workshops/${code}`);
    stickies = await api('GET', `/stickies/workshop/${code}?status=submitted`);
  } catch (err) {
    return renderError('Could not load workshop: ' + err.message);
  }

  // SSE connection for live moderator notifications
  const submittedList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px' } });
  renderSubmittedList(stickies, submittedList);

  function refreshSubmittedList() {
    api('GET', `/stickies/workshop/${code}?status=submitted`)
      .then((s) => renderSubmittedList(s, submittedList))
      .catch(() => {});
  }

  sseConnection = new EventSource(`/api/stream/${code}`);
  sseConnection.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === 'sticky_submitted') {
        showToast(
          `📌 New sticky from ${event.participant_name}`,
          `Sticky #${event.participant_sticky_index}: ${event.preview}`,
        );
        refreshSubmittedList();
      } else if (event.type === 'sticky_printed') {
        if (event.method === 'autoprint') {
          showToast('🖨️ Auto-printed', 'A submitted sticky was printed automatically.', 'success');
        }
        refreshSubmittedList();
      }
    } catch (_) {}
  };

  // Autoprint toggle
  let autoprint = workshop.autoprint;
  const toggleBtn = el('button', { className: `toggle ${autoprint ? 'on' : ''}`, onclick: async () => {
    autoprint = !autoprint;
    toggleBtn.className = `toggle ${autoprint ? 'on' : ''}`;
    await api('PUT', `/workshops/${code}/autoprint`, { autoprint }).catch(() => {
      showToast('Failed to update autoprint', '', 'warning');
      autoprint = !autoprint;
      toggleBtn.className = `toggle ${autoprint ? 'on' : ''}`;
    });
  }});

  return el('div', { className: 'page-wide' },
    el('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap', marginBottom: '24px' } },
      el('div', {},
        el('button', { className: 'btn btn-ghost btn-sm', onclick: () => navigate('#moderator/dashboard') }, '← Dashboard'),
        el('h1', { style: { marginTop: '8px' } }, workshop.name),
        el('div', { className: 'workshop-code' }, workshop.code),
        el('p', { style: { marginTop: '8px', color: 'var(--gray-600)', fontSize: '0.85rem' } },
          'Share this code with participants at: ',
          el('strong', {}, location.origin + '/#join/' + workshop.code),
        ),
      ),
    ),
    el('div', { className: 'toggle-row' },
      el('span', { style: { fontWeight: '600' } }, '🖨️ Auto-print submitted stickies'),
      toggleBtn,
      el('span', { id: 'autoprint-label', style: { color: 'var(--gray-600)', fontSize: '0.85rem' } }, autoprint ? 'On' : 'Off'),
    ),
    el('div', { className: 'card', style: { marginTop: '16px' } },
      el('h2', {}, '📥 Submitted Stickies'),
      submittedList,
    ),
  );
}

function renderSubmittedList(stickies, container) {
  container.innerHTML = '';
  if (stickies.length === 0) {
    container.appendChild(el('p', { style: { color: 'var(--gray-600)', marginTop: '12px' } }, 'No submitted stickies yet. Waiting for participants…'));
    return;
  }
  for (const s of stickies) {
    const code = s.workshop_code;
    const row = el('div', { className: 'card', style: { display: 'flex', gap: '12px', alignItems: 'center', padding: '14px', cursor: 'pointer' }, onclick: () => navigate(`#moderator/sticky/${s.id}`) },
      el('div', { className: 'sticky-card', style: { width: '80px', height: '80px', minHeight: 'unset', cursor: 'pointer', overflow: 'hidden' } },
        s.image_data
          ? el('img', { src: s.image_data, style: { width: '100%', height: '100%', objectFit: 'cover' } })
          : el('div', { style: { fontSize: '0.72rem', marginTop: '0' } }, shortPreview(s.content, 60)),
      ),
      el('div', { style: { flex: '1' } },
        el('strong', {}, `${s.participant_name} — Sticky #${s.participant_sticky_index}`),
        el('div', { style: { fontSize: '0.85rem', color: 'var(--gray-600)', marginTop: '4px' } }, shortPreview(s.content, 80)),
        el('div', { style: { fontSize: '0.78rem', color: 'var(--gray-400)', marginTop: '4px' } }, 'Submitted: ' + formatDate(s.submitted_at)),
      ),
      el('button', { className: 'btn btn-sm btn-ghost', onclick: (e) => { e.stopPropagation(); navigate(`#moderator/sticky/${s.id}`); } }, 'View →'),
    );
    container.appendChild(row);
  }
}

// ── Moderator Sticky view ────────────────────────────────────
async function renderModeratorSticky(stickyId) {
  if (!state.user) {
    try { state.user = await api('GET', '/auth/me'); }
    catch (_) { navigate('#moderator/login'); return el('div', {}); }
  }

  let sticky;
  try { sticky = await api('GET', `/stickies/${stickyId}`); }
  catch (err) { return renderError('Could not load sticky: ' + err.message); }

  async function markPrinted() {
    await api('POST', `/stickies/${stickyId}/print`);
    const code = getWorkshopCode(sticky);
    if (code) navigate('#moderator/workshop/' + code);
    else history.back();
  }

  async function printSticky() {
    try {
      await api('POST', `/stickies/${stickyId}/print`);
      showToast('Printing…', 'Sticky sent to printer.', 'success');
      const code = getWorkshopCode(sticky);
      if (code) navigate('#moderator/workshop/' + code);
      else history.back();
    } catch (err) {
      showToast('Print failed', err.message, 'warning');
    }
  }

  // Prints directly from this browser tab over Bluetooth (no local agent
  // needed) — requires Chrome/Edge and a user gesture to pick the printer.
  async function printViaBluetooth() {
    if (!isWebBluetoothSupported()) {
      showToast('Not supported', 'Bluetooth printing needs Chrome or Edge.', 'warning');
      return;
    }
    let printer;
    try {
      showToast('Select the printer…', 'Choose it from the browser dialog.', '');
      printer = await connectBlePrinter();
      const png = await (await fetch(`/api/stickies/${stickyId}/print-render`)).blob();
      showToast('Printing…', 'Sending to the printer over Bluetooth.', '');
      await printer.printPng(png);
      await markPrinted();
      showToast('Printed!', '', 'success');
    } catch (err) {
      showToast('Bluetooth print failed', err.message, 'warning');
    } finally {
      if (printer) printer.disconnect();
    }
  }

  async function rejectSticky() {
    if (!confirm('Return this sticky to the participant for rework?')) return;
    try {
      await api('POST', `/stickies/${stickyId}/reject`);
      showToast('Returned', 'Sticky sent back to participant.', 'success');
      history.back();
    } catch (err) {
      showToast('Failed', err.message, 'warning');
    }
  }

  function postpone() { history.back(); }

  const workshopCode = getWorkshopCode(sticky);

  return el('div', { className: 'page' },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' } },
      el('button', { className: 'btn btn-ghost btn-sm', onclick: () => history.back() }, '← Back'),
      el('h2', {}, `Sticky from ${sticky.participant_name || 'Participant'}`),
    ),
    el('div', { className: 'card' },
      el('div', { style: { display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap', fontSize: '0.85rem', color: 'var(--gray-600)' } },
        el('span', {}, `Sticky #${sticky.participant_sticky_index}`),
        el('span', {}, '·'),
        el('span', {}, `Status: ${sticky.status}`),
        el('span', {}, '·'),
        el('span', {}, `Submitted: ${formatDate(sticky.submitted_at)}`),
      ),
      el('div', { style: { fontSize: '0.85rem', color: 'var(--gray-600)', marginBottom: '6px' } }, '🖨️ Print preview (as sent to the C17 printer)'),
      el('div', { style: { textAlign: 'center', background: '#f4f4f4', padding: '16px', borderRadius: 'var(--radius)' } },
        el('img', {
          src: `/api/stickies/${stickyId}/print-render`,
          alt: 'Print preview',
          style: { maxWidth: '260px', width: '100%', border: '1px solid var(--gray-200)', borderRadius: '2px', boxShadow: '0 1px 4px rgba(0,0,0,0.15)', background: '#fff' },
        }),
      ),
      el('div', { style: { display: 'flex', gap: '12px', marginTop: '24px', flexWrap: 'wrap' } },
        sticky.status === 'submitted' && isWebBluetoothSupported()
          ? el('button', { className: 'btn btn-green btn-lg', onclick: printViaBluetooth }, '🔵 Print via Bluetooth')
          : null,
        sticky.status === 'submitted'
          ? el('button', { className: isWebBluetoothSupported() ? 'btn btn-ghost btn-lg' : 'btn btn-green btn-lg', onclick: printSticky }, '🖨️ Print (agent/local)')
          : null,
        el('button', { className: 'btn btn-ghost btn-lg', onclick: postpone }, '⏭️ Postpone'),
        sticky.status === 'submitted'
          ? el('button', { className: 'btn btn-red btn-lg', onclick: rejectSticky }, '↩️ Reject / Return for Rework')
          : null,
      ),
    ),
  );
}

function getWorkshopCode(sticky) {
  return sticky.workshop_code || (state.workshop ? state.workshop.code : '');
}

// ── Error / Not Found ────────────────────────────────────────
function renderNotFound() {
  return el('div', { className: 'page' },
    el('div', { className: 'card', style: { textAlign: 'center', padding: '48px' } },
      el('h1', { style: { fontSize: '4rem' } }, '404'),
      el('p', {}, 'Page not found'),
      el('a', { href: '#', className: 'btn btn-primary', style: { marginTop: '16px', display: 'inline-flex' } }, 'Go Home'),
    ),
  );
}

function renderError(msg) {
  return el('div', { className: 'page' },
    el('div', { className: 'card', style: { textAlign: 'center', padding: '48px' } },
      el('h2', {}, '⚠️ Something went wrong'),
      el('p', { style: { color: 'var(--gray-600)', marginTop: '8px' } }, msg),
      el('button', { className: 'btn btn-ghost', style: { marginTop: '16px' }, onclick: () => history.back() }, '← Back'),
    ),
  );
}

// ── Boot ─────────────────────────────────────────────────────
window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', router);
