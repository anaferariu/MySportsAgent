const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const { openDatabase, toNumberOrNull, slug } = require('./db');
const { runRuleChat, normalizeEntity, parseHeightToInches, calculateAgeFromDob } = require('./search');
const { isAgentEnabled, isAgentRequested, hasCredential, runAgentChat, MODEL } = require('./agent');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const SEED_DIR = path.join(ROOT_DIR, 'data', 'seed');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'players.db');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const store = openDatabase({ dbPath: DB_PATH, seedDir: SEED_DIR });

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mpg', '.mpeg', '.mkv', '.webm']);
const BOXSCORE_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!VIDEO_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('Unsupported video format. Allowed: mp4, mov, avi, mpg, mpeg, mkv, webm'));
    }
    return cb(null, true);
  }
});

const boxscoreUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!BOXSCORE_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('Unsupported boxscore format. Allowed: xlsx, xls, csv'));
    }
    return cb(null, true);
  }
});

// ---------- boxscore parsing ----------

function col(row, names) {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

// "7-21" -> [7, 21]
function madeAttempted(value) {
  const m = String(value || '').match(/^\s*(\d+)\s*[-/]\s*(\d+)\s*$/);
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}

function parseMinutes(value) {
  const text = String(value || '').trim();
  const clock = text.match(/^(\d+):(\d{2})$/);
  if (clock) return Math.round((Number(clock[1]) + Number(clock[2]) / 60) * 10) / 10;
  return toNumberOrNull(text);
}

function parseBoxscoreRow(row) {
  const shooting = (combinedNames, madeNames, attemptNames) => {
    const [made, attempted] = madeAttempted(col(row, combinedNames));
    return [made ?? toNumberOrNull(col(row, madeNames)), attempted ?? toNumberOrNull(col(row, attemptNames))];
  };
  const [fgm, fga] = shooting(['FG', 'fg'], ['FGM', 'fgm'], ['FGA', 'fga']);
  const [tpm, tpa] = shooting(['3PT', '3P', '3pt'], ['3PM', '3pm', 'TPM'], ['3PA', '3pa', 'TPA']);
  const [ftm, fta] = shooting(['FT', 'ft'], ['FTM', 'ftm'], ['FTA', 'fta']);

  let rebounds = toNumberOrNull(col(row, ['REB', 'reb', 'TRB', 'Rebounds', 'rebounds']));
  if (rebounds === null) {
    const oreb = toNumberOrNull(col(row, ['OREB', 'OR']));
    const dreb = toNumberOrNull(col(row, ['DREB', 'DR']));
    if (oreb !== null || dreb !== null) rebounds = (oreb || 0) + (dreb || 0);
  }

  return {
    gameDate: String(col(row, ['gameDate', 'game_date', 'Date', 'date'])) || null,
    opponent: String(col(row, ['opponent', 'Opponent', 'OPP'])) || null,
    minutes: parseMinutes(col(row, ['MIN', 'min', 'Minutes'])),
    points: toNumberOrNull(col(row, ['PTS', 'pts', 'Points', 'points'])),
    rebounds,
    assists: toNumberOrNull(col(row, ['AST', 'ast', 'Assists', 'assists'])),
    steals: toNumberOrNull(col(row, ['STL', 'stl', 'Steals', 'steals'])),
    blocks: toNumberOrNull(col(row, ['BLK', 'blk', 'Blocks', 'blocks'])),
    turnovers: toNumberOrNull(col(row, ['TOV', 'TO', 'tov', 'Turnovers', 'turnovers'])),
    fgm, fga, tpm, tpa, ftm, fta
  };
}

function parseRowName(row) {
  const first = String(col(row, ['firstName', 'first_name', 'First Name', 'FirstName'])).trim();
  const last = String(col(row, ['lastName', 'last_name', 'Last Name', 'LastName'])).trim();
  if (first || last) return `${first} ${last}`.trim();
  return String(col(row, ['Player', 'player', 'Name', 'name', 'playerName', 'player_name', 'Athlete'])).trim();
}

// ---------- player intake ----------

function playerFromForm(body, file) {
  const now = new Date().toISOString();
  const firstName = String(body.firstName || '').trim();
  const lastName = String(body.lastName || '').trim();
  const heightDisplay = String(body.heightDisplay || '').trim();
  const weightDisplay = String(body.weightDisplay || '').trim();
  const weightMatch = weightDisplay.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(kg|lb|lbs|pounds?)?/);
  const weightLbs = weightMatch ? Number(weightMatch[1]) * (weightMatch[2] === 'kg' ? 2.20462 : 1) : null;

  const numericFields = [
    'gamesPlayed', 'minutesPerGame', 'pointsPerGame', 'reboundsPerGame', 'assistsPerGame', 'stealsPerGame',
    'blocksPerGame', 'turnoversPerGame', 'fgPercentage', 'threePtPercentage', 'ftPercentage', 'verticalInches'
  ];

  const record = {
    id: `${slug(`${firstName}-${lastName}`)}-${Date.now()}`,
    createdAt: now,
    updatedAt: now,
    firstName,
    lastName,
    gender: body.gender,
    nationality: body.nationality ? normalizeEntity(body.nationality) : '',
    playsInNationalTeam: body.playsInNationalTeam,
    dob: body.dob,
    heightDisplay,
    heightInches: parseHeightToInches(heightDisplay),
    weightDisplay,
    weightLbs: weightLbs === null ? null : Math.round(weightLbs * 10) / 10,
    position: String(body.position || '').trim(),
    handedness: body.handedness,
    team: String(body.team || '').trim(),
    league: String(body.league || '').trim(),
    season: String(body.season || '').trim(),
    keywords: String(body.keywords || '').trim(),
    notes: String(body.notes || '').trim(),
    highlightVideoPath: file ? `/uploads/${file.filename}` : '',
    source: 'manual entry'
  };
  for (const key of numericFields) record[key] = toNumberOrNull(body[key]);
  return record;
}

// ---------- app ----------

const app = express();
if (IS_PRODUCTION) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(ROOT_DIR, 'client')));
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// The API is public, so responses carry age instead of a full date of birth.
function publicPlayer(player) {
  const { dob, ...rest } = player;
  return { ...rest, age: calculateAgeFromDob(dob) };
}

app.get('/api/config', (_req, res) => {
  res.json({
    agentEnabled: isAgentEnabled(),
    model: isAgentEnabled() ? MODEL : null,
    teams: store.teams.map(({ team, league, season }) => ({ team, league, season }))
  });
});

app.get('/api/players', (_req, res) => res.json(store.readPlayers().map(publicPlayer)));

app.post('/api/players', videoUpload.single('highlightVideo'), (req, res) => {
  const record = playerFromForm(req.body || {}, req.file);
  if (!record.firstName || !record.lastName || !record.position) {
    return res.status(400).json({ error: 'firstName, lastName, and position are required.' });
  }
  store.insertPlayer(record);
  return res.status(201).json(publicPlayer(store.getPlayer(record.id)));
});

app.post('/api/boxscores/upload', boxscoreUpload.single('boxscoreFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'boxscoreFile is required.' });

  let rows;
  try {
    // raw: keep CSV text as-is, otherwise "7-21" (FG made-attempted) is parsed as a date.
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', raw: true });
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
  } catch {
    return res.status(400).json({ error: 'Could not read that file as a spreadsheet.' });
  }
  if (!rows.length) return res.status(400).json({ error: 'No rows found in uploaded boxscore.' });

  const players = store.readPlayers();
  const byName = new Map();
  for (const p of players) {
    const key = normalizeEntity(`${p.firstName} ${p.lastName}`);
    byName.set(key, [...(byName.get(key) || []), p]);
  }

  let updated = 0;
  const unmatched = [];
  for (const row of rows) {
    const name = parseRowName(row);
    if (!name) {
      unmatched.push({ reason: 'missing_name' });
      continue;
    }
    if (/dnp|did not play|inactive/i.test(String(col(row, ['MIN', 'min', 'Minutes', 'Status'])))) continue;

    let candidates = byName.get(normalizeEntity(name)) || [];
    const team = normalizeEntity(col(row, ['Team', 'team', 'TEAM']));
    if (candidates.length > 1 && team) candidates = candidates.filter((p) => normalizeEntity(p.team).includes(team));
    if (candidates.length !== 1) {
      unmatched.push({ name, reason: candidates.length ? 'ambiguous_name' : 'player_not_found' });
      continue;
    }

    // Re-read so several rows for the same player in one file stack correctly.
    store.recordGame(store.getPlayer(candidates[0].id), parseBoxscoreRow(row), req.file.originalname);
    updated += 1;
  }

  return res.json({ ok: true, sourceFile: req.file.originalname, totalRows: rows.length, matchedRows: updated, unmatchedRows: unmatched.length, unmatched });
});

// Chat state per visitor, keyed by a random id the browser generates. Capped so
// traffic can't grow memory without bound (oldest conversation is dropped first).
const MAX_CHAT_SESSIONS = 2000;
const chatSessions = new Map();

function chatKey(req) {
  const id = String((req.body && req.body.sessionId) || '');
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}

function chatStateFor(key) {
  if (!chatSessions.has(key)) {
    if (chatSessions.size >= MAX_CHAT_SESSIONS) chatSessions.delete(chatSessions.keys().next().value);
    chatSessions.set(key, { rules: { criteria: {}, askedQuestions: [], awaitingQuestionKey: null }, agent: { messages: [] } });
  }
  return chatSessions.get(key);
}

// Express 4 does not catch rejected promises; without this an error in an async
// route would crash the whole process instead of returning a 500.
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.post('/api/agent/chat', asyncRoute(async (req, res) => {
  const { message = '', forceSearch = false } = req.body || {};
  const text = String(message).slice(0, 2000).trim();
  if (!text && !forceSearch) return res.status(400).json({ error: 'Message is required.' });

  const key = chatKey(req);
  if (!key) return res.status(400).json({ error: 'sessionId is required.' });
  const chat = chatStateFor(key);
  let notice = null;

  if (isAgentEnabled() && text) {
    try {
      const reply = await runAgentChat(chat.agent, text, store);
      return res.json({ ...reply, matches: reply.matches ? reply.matches.map(publicPlayer) : null });
    } catch (error) {
      console.error('Agent request failed, falling back to rule-based search:', error.message);
      notice = 'The AI agent is unavailable right now, so this answer comes from the rule-based search.';
    }
  }

  const result = runRuleChat(chat.rules, { message: text, forceSearch }, store.readPlayers(), store.teams);
  // A follow-up question (done: false) carries no player lists.
  const response = result.done
    ? { ...result, matches: result.matches.map(publicPlayer), separateMatches: result.separateMatches.map(publicPlayer) }
    : result;
  return res.json(notice ? { ...response, notice } : response);
}));

app.post('/api/agent/reset', (req, res) => {
  const key = chatKey(req);
  if (key) chatSessions.delete(key);
  res.json({ ok: true });
});

app.get('*', (_req, res) => res.sendFile(path.join(ROOT_DIR, 'client', 'index.html')));

app.use((err, _req, res, _next) => {
  const status = err instanceof multer.MulterError || err.message?.startsWith('Unsupported') ? 400 : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong.' : err.message });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    if (isAgentEnabled()) console.log(`Search engine: Claude agent (${MODEL}), falling back to rule-based search on errors`);
    else if (isAgentRequested() && !hasCredential()) console.log('Search engine: rule-based (SEARCH_ENGINE=agent is set but ANTHROPIC_API_KEY is missing)');
    else console.log('Search engine: rule-based (set SEARCH_ENGINE=agent and ANTHROPIC_API_KEY to use the Claude agent)');
  });
}

module.exports = app;
