const form = document.getElementById('player-form');
const formStatus = document.getElementById('form-status');
const sportInput = document.getElementById('sport-input');
const sportFields = document.getElementById('sport-fields');
const sportFormTitle = document.getElementById('sport-form-title');
const sportCards = document.getElementById('sport-cards');
const sportTabs = document.getElementById('sport-tabs');
const playersTable = document.getElementById('players-table');
const playersFilter = document.getElementById('players-filter');
const playersCount = document.getElementById('players-count');
const playersSubtitle = document.getElementById('players-subtitle');
const refreshBtn = document.getElementById('refresh-btn');
const boxscoreSection = document.getElementById('boxscore-section');
const boxscoreForm = document.getElementById('boxscore-form');
const boxscoreStatus = document.getElementById('boxscore-status');

const pageViews = document.querySelectorAll('.page-view');

const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatLog = document.getElementById('chat-log');
const chatResults = document.getElementById('chat-results');
const chatDoneBtn = document.getElementById('chat-done-btn');
const engineStatus = document.getElementById('engine-status');
const videoInput = document.getElementById('highlight-video');
const videoStatus = document.getElementById('video-status');

const VIDEO_DISABLED_MESSAGE = 'For demo only: video uploads are disabled for safety reasons.';

// Identifies this tab's conversation so follow-up questions keep their context.
const sessionId = crypto.randomUUID();

let agentEnabled = false;
let videoUploadsEnabled = false;
let sports = {}; // sport definitions from /api/sports
let databaseSport = 'basketball'; // tab selected in the Player Database
let allPlayers = [];

// ---------- helpers ----------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.appendChild(child);
  return node;
}

function fmt(value, fallback = '-') {
  return value === '' || value === null || value === undefined ? fallback : String(value);
}

const fullName = (p) => `${p.firstName || ''} ${p.lastName || ''}`.trim();
const statDefs = (sport) => (sports[sport] ? sports[sport].statGroups.flatMap((g) => g.stats) : []);
// Basketball stats are top-level fields; other sports keep theirs in player.stats.
const statValue = (p, key) => (p.sport === 'basketball' ? p[key] : p.stats && p.stats[key]);

function videoLink(player) {
  const href = player.highlightVideoPath;
  if (!href || !href.startsWith('/uploads/')) return '-';
  return el('a', { href, target: '_blank', rel: 'noreferrer', text: 'Open' });
}

// Builds a table with DOM nodes only; player data is never parsed as HTML.
function renderTable(table, columns, rows) {
  table.replaceChildren();
  const headRow = table.createTHead().insertRow();
  for (const [label, , title] of columns) headRow.appendChild(el('th', { text: label, title }));
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

function columnsFor(sport, extra = []) {
  const stats = statDefs(sport)
    .filter((def) => def.table !== false)
    .map((def) => [def.short, (p) => statValue(p, def.key), def.label]);
  return [
    ['Name', fullName],
    ['Team', (p) => p.team],
    ['League', (p) => p.league],
    ['Pos', (p) => p.position],
    ...stats,
    ...extra
  ];
}

const DATABASE_EXTRA_COLUMNS = [
  ['Gender', (p) => p.gender],
  ['Ht', (p) => p.heightDisplay],
  ['Nationality', (p) => p.nationality],
  ['Age', (p) => p.age],
  ['Traits', (p) => p.keywords],
  ['Notes', (p) => p.notes],
  ['Video', videoLink]
];

const RESULT_EXTRA_COLUMNS = [
  ['Why', (p) => (Array.isArray(p.matchReasons) && p.matchReasons.length ? p.matchReasons.join(', ') : '')]
];

// ---------- navigation ----------

function showView(viewId) {
  pageViews.forEach((view) => view.classList.toggle('active', view.id === viewId));
  if (viewId === 'view-player-database') fetchPlayers();
  window.scrollTo(0, 0);
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-target]');
  if (!link) return;
  event.preventDefault();
  showView(link.dataset.target);
});

// ---------- ScoutBoard ----------

function renderSportCards() {
  sportCards.replaceChildren(
    ...Object.entries(sports).map(([id, sport]) => {
      const card = el('button', { type: 'button', className: 'sport-card', 'data-sport': id }, [
        el('span', { className: 'sport-card-icon', text: sport.icon, 'aria-hidden': 'true' }),
        el('span', { className: 'sport-card-label', text: sport.label }),
        el('span', { className: 'sport-card-description', text: sport.description })
      ]);
      card.addEventListener('click', () => openSportForm(id));
      return card;
    })
  );
}

function selectField(label, name, options, { required = false, placeholder = 'Unknown' } = {}) {
  const select = el('select', { name, required: required ? '' : null }, [
    el('option', { value: '', text: required ? 'Choose…' : placeholder }),
    ...options.map(([value, text]) => el('option', { value, text }))
  ]);
  return el('label', { text: label }, [select]);
}

function statInput(def) {
  const input = el('input', {
    name: def.key,
    type: 'number',
    min: def.min ?? 0,
    max: def.max,
    step: def.step ?? 0.1,
    inputmode: 'decimal'
  });
  return el('label', { text: def.label, title: def.short }, [input]);
}

function openSportForm(sportId) {
  const sport = sports[sportId];
  sportInput.value = sportId;
  sportFormTitle.textContent = `ScoutBoard · ${sport.icon} ${sport.label}`;
  form.querySelector('#team-input').placeholder = sport.examples.team;
  form.querySelector('#league-input').placeholder = sport.examples.league;
  form.querySelector('#keywords-input').placeholder = sport.examples.keywords;

  const profile = [
    selectField('Position *', 'position', sport.positions.map((p) => [p, p]), { required: true }),
    sport.handedness ? selectField(sport.handedness.label, 'handedness', sport.handedness.options) : null,
    el('label', { text: 'Nationality' }, [el('input', { name: 'nationality', maxlength: 60, placeholder: 'e.g. USA, Spain, Nigeria' })]),
    sport.nationalTeam ? selectField('Plays in National Team', 'playsInNationalTeam', [['yes', 'Yes'], ['no', 'No']]) : null
  ].filter(Boolean);

  const groups = sport.statGroups.map((group) =>
    el('fieldset', { className: 'stat-group' }, [el('legend', { text: group.title }), el('div', { className: 'grid four' }, group.stats.map(statInput))])
  );

  sportFields.replaceChildren(el('div', { className: `grid ${profile.length > 2 ? 'four' : 'two'}` }, profile), ...groups);
  formStatus.textContent = '';
  videoStatus.textContent = '';
  showView('view-scoutboard-form');
}

// The picker looks normal; when uploads are off, clicking it shows a notice instead of opening.
videoInput.addEventListener('click', (event) => {
  if (videoUploadsEnabled) return;
  event.preventDefault();
  videoStatus.textContent = VIDEO_DISABLED_MESSAGE;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formStatus.textContent = 'Saving...';
  const sportId = sportInput.value;
  try {
    const res = await fetch('/api/players', { method: 'POST', body: new FormData(form) });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Save failed');
    form.reset();
    sportInput.value = sportId; // reset() clears the hidden field too
    videoStatus.textContent = '';
    formStatus.textContent = `Saved ${fullName(payload)} (${sports[sportId].label}).`;
  } catch (error) {
    formStatus.textContent = error.message;
  }
});

// ---------- Player Database ----------

function renderSportTabs() {
  sportTabs.replaceChildren(
    ...Object.entries(sports).map(([id, sport]) => {
      const tab = el('button', { type: 'button', role: 'tab', className: 'sport-tab', 'aria-selected': String(id === databaseSport) }, [
        el('span', { text: `${sport.icon} ${sport.label}` })
      ]);
      tab.addEventListener('click', () => {
        databaseSport = id;
        renderSportTabs();
        renderPlayers();
      });
      return tab;
    })
  );
}

function renderPlayers() {
  const sport = sports[databaseSport];
  if (!sport) return;
  const query = playersFilter.value.trim().toLowerCase();
  const sortKeys = [].concat(sport.defaultSort);
  const sortValue = (p) => sortKeys.reduce((sum, key) => sum + (Number(statValue(p, key)) || 0), 0);

  const inSport = allPlayers
    .filter((p) => p.sport === databaseSport)
    .sort((a, b) => sortValue(b) - sortValue(a) || fullName(a).localeCompare(fullName(b)));
  const rows = query
    ? inSport.filter((p) =>
        [fullName(p), p.team, p.league, p.position, p.nationality].some((v) => String(v || '').toLowerCase().includes(query))
      )
    : inSport;

  playersSubtitle.textContent = sport.tableNote;
  boxscoreSection.hidden = databaseSport !== 'basketball';
  renderTable(playersTable, columnsFor(databaseSport, DATABASE_EXTRA_COLUMNS), rows);
  playersCount.textContent = `${rows.length} of ${inSport.length} ${sport.label.toLowerCase()} players`;
}

async function fetchPlayers() {
  try {
    const res = await fetch('/api/players');
    if (!res.ok) throw new Error('Could not load players.');
    allPlayers = await res.json();
    renderPlayers();
  } catch (error) {
    playersCount.textContent = error.message;
  }
}

boxscoreForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  boxscoreStatus.textContent = 'Processing boxscore...';
  try {
    const res = await fetch('/api/boxscores/upload', { method: 'POST', body: new FormData(boxscoreForm) });
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

refreshBtn.addEventListener('click', fetchPlayers);
playersFilter.addEventListener('input', renderPlayers);

// ---------- AI Scout Assistant (basketball) ----------

function addMessage(role, text) {
  chatLog.appendChild(el('div', { className: `msg ${role}`, text }));
  chatLog.scrollTop = chatLog.scrollHeight;
}

function greet() {
  chatLog.replaceChildren();
  chatResults.replaceChildren();
  addMessage(
    'bot',
    agentEnabled
      ? 'Ask me about the basketball players in the database, for example: "guard with at least 20 points per game" or "best rebounder in the WNBA".'
      : 'Describe your target profile, for example: "guard with at least 20 points per game" or "WNBA forward, 8+ rebounds". Each message adds to your filters, so you can keep narrowing the results ("only Celtics", "35% from three", "any league" to drop one). Reply NA to skip a follow-up question. Click Done to clear everything and start a new search.'
  );
}

function renderResults(payload) {
  chatResults.replaceChildren();
  const sections = [
    ['Matches', payload.matches],
    ['Matches with missing data', payload.separateMatches]
  ];
  for (const [title, rows] of sections) {
    if (!Array.isArray(rows) || !rows.length) continue;
    const table = el('table');
    renderTable(table, columnsFor('basketball', RESULT_EXTRA_COLUMNS), rows);
    chatResults.append(el('h3', { text: `${title} (${rows.length})` }), el('div', { className: 'table-wrap' }, [table]));
  }
}

async function sendChat(message, forceSearch = false) {
  chatInput.disabled = true;
  try {
    const res = await fetch('/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message, forceSearch })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Search request failed');

    if (payload.notice) addMessage('notice', payload.notice);

    if (!payload.done) {
      addMessage('bot', `${payload.question} (${payload.candidatesSoFar} candidates so far)`);
      return;
    }

    addMessage('bot', payload.summary);
    if (payload.reset) chatResults.replaceChildren();
    if (Array.isArray(payload.matches)) {
      if (!payload.matches.length && payload.engine === 'rules') {
        addMessage('bot', 'No matches. Try relaxing one filter, like the points or shooting threshold.');
      }
      renderResults(payload);
    }
  } catch (error) {
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

// Done (or "New chat" with the agent) clears the conversation and all filters.
chatDoneBtn.addEventListener('click', async () => {
  await fetch('/api/agent/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  }).catch(() => {});
  greet();
});

// ---------- startup ----------

async function loadConfig() {
  try {
    const [configRes, sportsRes] = await Promise.all([fetch('/api/config'), fetch('/api/sports')]);
    const config = await configRes.json();
    sports = await sportsRes.json();
    agentEnabled = Boolean(config.agentEnabled);
    videoUploadsEnabled = Boolean(config.videoUploadsEnabled);
    const teams = (config.teams || []).filter((t) => t.sport === 'basketball').map((t) => t.team).join(', ');
    engineStatus.textContent = agentEnabled
      ? `Search engine: Claude agent (${config.model}). Basketball teams: ${teams}.`
      : `Search engine: rule-based. Basketball teams: ${teams}.`;
    chatDoneBtn.textContent = agentEnabled ? 'New chat' : 'Done';
  } catch (_error) {
    engineStatus.textContent = '';
  }
}

(async function init() {
  await loadConfig();
  renderSportCards();
  renderSportTabs();
  greet();
})();
