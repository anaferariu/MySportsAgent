const form = document.getElementById('player-form');
const formStatus = document.getElementById('form-status');
const playersTable = document.getElementById('players-table');
const playersFilter = document.getElementById('players-filter');
const playersCount = document.getElementById('players-count');
const refreshBtn = document.getElementById('refresh-btn');
const boxscoreForm = document.getElementById('boxscore-form');
const boxscoreStatus = document.getElementById('boxscore-status');

const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');
const logoutButtons = document.querySelectorAll('[data-logout]');

const pageViews = document.querySelectorAll('.page-view');
const navLinks = document.querySelectorAll('[data-target]');

const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatLog = document.getElementById('chat-log');
const chatResults = document.getElementById('chat-results');
const chatDoneBtn = document.getElementById('chat-done-btn');
const engineStatus = document.getElementById('engine-status');

let isAuthenticated = false;
let agentEnabled = false;
let pendingChatRequest = null;
let allPlayers = [];

function fmt(value, fallback = '-') {
  return value === '' || value === null || value === undefined ? fallback : String(value);
}

function ageFromDob(dob) {
  if (!dob) return null;
  const date = new Date(dob);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  if (now.getMonth() < date.getMonth() || (now.getMonth() === date.getMonth() && now.getDate() < date.getDate())) age -= 1;
  return age;
}

function videoLink(player) {
  const href = player.highlightVideoPath;
  if (!href || !href.startsWith('/uploads/')) return '-';
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = 'Open';
  return a;
}

const STAT_COLUMNS = [
  ['Name', (p) => `${p.firstName} ${p.lastName}`],
  ['Team', (p) => p.team],
  ['League', (p) => p.league],
  ['Pos', (p) => p.position],
  ['GP', (p) => p.gamesPlayed],
  ['MIN', (p) => p.minutesPerGame],
  ['PPG', (p) => p.pointsPerGame],
  ['RPG', (p) => p.reboundsPerGame],
  ['APG', (p) => p.assistsPerGame],
  ['SPG', (p) => p.stealsPerGame],
  ['BPG', (p) => p.blocksPerGame],
  ['TOV', (p) => p.turnoversPerGame],
  ['FG%', (p) => p.fgPercentage],
  ['3PT%', (p) => p.threePtPercentage],
  ['3PA', (p) => p.threeAttemptsPerGame],
  ['FT%', (p) => p.ftPercentage]
];

const DATABASE_COLUMNS = [
  ...STAT_COLUMNS,
  ['Gender', (p) => p.gender],
  ['Ht', (p) => p.heightDisplay],
  ['Nationality', (p) => p.nationality],
  ['Age', (p) => ageFromDob(p.dob)],
  ['Traits', (p) => p.keywords],
  ['Notes', (p) => p.notes],
  ['Video', videoLink]
];

const RESULT_COLUMNS = [
  ...STAT_COLUMNS,
  ['Why', (p) => (Array.isArray(p.matchReasons) && p.matchReasons.length ? p.matchReasons.join(', ') : '')]
];

// Builds a table with DOM nodes only; player data is never parsed as HTML.
function renderTable(table, columns, rows) {
  table.replaceChildren();
  const headRow = table.createTHead().insertRow();
  for (const [label] of columns) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const [, get] of columns) {
      const value = get(row);
      const td = tr.insertCell();
      if (value instanceof Node) td.appendChild(value);
      else td.textContent = fmt(value);
    }
  }
}

function showView(viewId) {
  const nextView = !isAuthenticated && viewId !== 'view-login' ? 'view-login' : viewId;
  pageViews.forEach((view) => view.classList.toggle('active', view.id === nextView));
  if (nextView === 'view-player-database' && isAuthenticated) fetchPlayers();
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    isAuthenticated = false;
    showView('view-login');
    throw new Error('Please log in to continue.');
  }
  return response;
}

function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderPlayers() {
  const query = playersFilter.value.trim().toLowerCase();
  const rows = query
    ? allPlayers.filter((p) =>
        [p.firstName, p.lastName, p.team, p.league, p.position, p.nationality].some((v) => String(v || '').toLowerCase().includes(query))
      )
    : allPlayers;
  renderTable(playersTable, DATABASE_COLUMNS, rows);
  playersCount.textContent = `${rows.length} of ${allPlayers.length} players`;
}

async function fetchPlayers() {
  try {
    const res = await apiFetch('/api/players');
    allPlayers = await res.json();
    renderPlayers();
  } catch (error) {
    playersCount.textContent = error.message;
  }
}

async function loadConfig() {
  try {
    const res = await apiFetch('/api/config');
    const config = await res.json();
    agentEnabled = Boolean(config.agentEnabled);
    const teams = (config.teams || []).map((t) => t.team).join(', ');
    engineStatus.textContent = agentEnabled
      ? `Search engine: Claude agent (${config.model}). Database: ${teams}.`
      : `Search engine: rule-based. Database: ${teams}.`;
    chatDoneBtn.textContent = agentEnabled ? 'New chat' : 'Done';
  } catch (_error) {
    engineStatus.textContent = '';
  }
}

function greet() {
  chatLog.replaceChildren();
  chatResults.replaceChildren();
  addMessage(
    'bot',
    agentEnabled
      ? 'Ask me about the players in the database, for example: "guard with at least 20 points per game" or "best rebounder in the WNBA".'
      : 'Describe your target profile, for example: "guard with at least 20 points per game" or "WNBA forward, 8+ rebounds". Reply NA to skip a follow-up question, or click Done to search right away.'
  );
}

async function onAuthenticated() {
  await loadConfig();
  greet();
}

navLinks.forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    if (link.dataset.target) showView(link.dataset.target);
  });
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginStatus.textContent = 'Logging in...';

  try {
    const data = new FormData(loginForm);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: String(data.get('username') || '').trim(), password: String(data.get('password') || '') })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Login failed');

    isAuthenticated = true;
    loginForm.reset();
    loginStatus.textContent = '';
    await onAuthenticated();
    showView('view-home');
    if (pendingChatRequest) {
      const { message, forceSearch } = pendingChatRequest;
      pendingChatRequest = null;
      addMessage('bot', 'Resuming your previous scout request.');
      await sendChat(message, forceSearch);
    }
  } catch (error) {
    loginStatus.textContent = error.message;
  }
});

logoutButtons.forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (_error) {
      // Still clear local state.
    }
    isAuthenticated = false;
    showView('view-login');
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formStatus.textContent = 'Saving...';
  try {
    const res = await apiFetch('/api/players', { method: 'POST', body: new FormData(form) });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Save failed');
    form.reset();
    formStatus.textContent = `Saved ${payload.firstName} ${payload.lastName}.`;
  } catch (error) {
    formStatus.textContent = error.message;
  }
});

boxscoreForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  boxscoreStatus.textContent = 'Processing boxscore...';
  try {
    const res = await apiFetch('/api/boxscores/upload', { method: 'POST', body: new FormData(boxscoreForm) });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Boxscore upload failed');
    boxscoreForm.reset();
    const missing = payload.unmatched.filter((u) => u.name).map((u) => u.name);
    boxscoreStatus.textContent =
      `Added ${payload.matchedRows} game line(s).` + (missing.length ? ` Not found in the database: ${missing.join(', ')}.` : '');
    await fetchPlayers();
  } catch (error) {
    boxscoreStatus.textContent = error.message;
  }
});

function renderResults(payload) {
  chatResults.replaceChildren();
  const sections = [
    ['Matches', payload.matches],
    ['Matches with missing data', payload.separateMatches]
  ];
  for (const [title, rows] of sections) {
    if (!Array.isArray(rows) || !rows.length) continue;
    const heading = document.createElement('h3');
    heading.textContent = `${title} (${rows.length})`;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const table = document.createElement('table');
    renderTable(table, RESULT_COLUMNS, rows);
    wrap.appendChild(table);
    chatResults.append(heading, wrap);
  }
}

async function sendChat(message, forceSearch = false) {
  chatInput.disabled = true;
  try {
    const res = await apiFetch('/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, forceSearch })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Search request failed');

    if (payload.notice) addMessage('notice', payload.notice);

    if (!payload.done) {
      addMessage('bot', `${payload.question} (${payload.candidatesSoFar} candidates so far)`);
      return;
    }

    addMessage('bot', payload.summary);
    if (Array.isArray(payload.matches)) {
      if (!payload.matches.length && payload.engine === 'rules') {
        addMessage('bot', 'No matches. Try relaxing one filter, like the points or shooting threshold.');
      }
      renderResults(payload);
    }
  } catch (error) {
    if (error.message === 'Please log in to continue.') {
      pendingChatRequest = { message, forceSearch };
      addMessage('bot', 'Please log in. I will resume your last request automatically.');
      return;
    }
    addMessage('bot', error.message);
  } finally {
    chatInput.disabled = false;
    chatInput.focus();
  }
}

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  addMessage('user', message);
  chatInput.value = '';
  await sendChat(message, false);
});

chatDoneBtn.addEventListener('click', async () => {
  if (agentEnabled) {
    await apiFetch('/api/agent/reset', { method: 'POST' }).catch(() => {});
    greet();
    return;
  }
  addMessage('user', 'Done');
  await sendChat('', true);
});

refreshBtn.addEventListener('click', fetchPlayers);
playersFilter.addEventListener('input', renderPlayers);

(async function initializeAuth() {
  try {
    const res = await fetch('/api/auth/me');
    isAuthenticated = res.ok && Boolean((await res.json()).authenticated);
  } catch (_error) {
    isAuthenticated = false;
  }
  if (isAuthenticated) await onAuthenticated();
  showView(isAuthenticated ? 'view-home' : 'view-login');
})();
