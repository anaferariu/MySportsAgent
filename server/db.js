const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Bump when the players/player_game_stats layout changes. An older local DB is
// dropped and rebuilt from data/seed on the next start.
const SCHEMA_VERSION = 2;

// [js key, sql column, sql type]. Single source of truth for the players table.
const PLAYER_COLUMNS = [
  ['id', 'id', 'TEXT PRIMARY KEY'],
  ['createdAt', 'created_at', 'TEXT NOT NULL'],
  ['updatedAt', 'updated_at', 'TEXT NOT NULL'],
  ['firstName', 'first_name', 'TEXT NOT NULL'],
  ['lastName', 'last_name', 'TEXT NOT NULL'],
  ['gender', 'gender', 'TEXT'],
  ['nationality', 'nationality', 'TEXT'],
  ['playsInNationalTeam', 'plays_in_national_team', 'TEXT'],
  ['dob', 'dob', 'TEXT'],
  ['heightDisplay', 'height_display', 'TEXT'],
  ['heightInches', 'height_inches', 'REAL'],
  ['weightDisplay', 'weight_display', 'TEXT'],
  ['weightLbs', 'weight_lbs', 'REAL'],
  ['position', 'position', 'TEXT NOT NULL'],
  ['handedness', 'handedness', 'TEXT'],
  ['team', 'team', 'TEXT'],
  ['league', 'league', 'TEXT'],
  ['season', 'season', 'TEXT'],
  ['gamesPlayed', 'games_played', 'REAL'],
  ['gamesStarted', 'games_started', 'REAL'],
  ['minutesPerGame', 'minutes_per_game', 'REAL'],
  ['pointsPerGame', 'points_per_game', 'REAL'],
  ['reboundsPerGame', 'rebounds_per_game', 'REAL'],
  ['assistsPerGame', 'assists_per_game', 'REAL'],
  ['stealsPerGame', 'steals_per_game', 'REAL'],
  ['blocksPerGame', 'blocks_per_game', 'REAL'],
  ['turnoversPerGame', 'turnovers_per_game', 'REAL'],
  ['fgMadePerGame', 'fgm_per_game', 'REAL'],
  ['fgAttemptsPerGame', 'fga_per_game', 'REAL'],
  ['fgPercentage', 'fg_percentage', 'REAL'],
  ['threeMadePerGame', 'tpm_per_game', 'REAL'],
  ['threeAttemptsPerGame', 'tpa_per_game', 'REAL'],
  ['threePtPercentage', 'three_pt_percentage', 'REAL'],
  ['ftMadePerGame', 'ftm_per_game', 'REAL'],
  ['ftAttemptsPerGame', 'fta_per_game', 'REAL'],
  ['ftPercentage', 'ft_percentage', 'REAL'],
  ['verticalInches', 'vertical_inches', 'REAL'],
  ['keywords', 'keywords', 'TEXT'],
  ['notes', 'notes', 'TEXT'],
  ['highlightVideoPath', 'highlight_video_path', 'TEXT'],
  ['source', 'source', 'TEXT']
];

const NUMERIC_KEYS = new Set(PLAYER_COLUMNS.filter(([, , type]) => type === 'REAL').map(([key]) => key));

const POSITION_NAMES = { G: 'Guard', F: 'Forward', C: 'Center', PG: 'Point Guard', SG: 'Shooting Guard', SF: 'Small Forward', PF: 'Power Forward' };

function toNumberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round1(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

// Minimal RFC 4180 CSV parser (quoted fields, escaped quotes). Enough for seed files.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((cell) => cell !== '')) rows.push(row);

  const [header = [], ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((name, idx) => [name.trim(), (cells[idx] || '').trim()])));
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

function slug(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function seedRowToPlayer(row, team, now) {
  const { firstName, lastName } = splitName(row.name);
  return {
    id: slug(`${team.league}-${team.team}-${row.name}`),
    createdAt: now,
    updatedAt: now,
    firstName,
    lastName,
    gender: team.gender,
    position: POSITION_NAMES[row.pos] || row.pos,
    team: team.team,
    league: team.league,
    season: team.season,
    gamesPlayed: toNumberOrNull(row.gp),
    gamesStarted: toNumberOrNull(row.gs),
    minutesPerGame: toNumberOrNull(row.min),
    pointsPerGame: toNumberOrNull(row.pts),
    reboundsPerGame: toNumberOrNull(row.reb),
    assistsPerGame: toNumberOrNull(row.ast),
    stealsPerGame: toNumberOrNull(row.stl),
    blocksPerGame: toNumberOrNull(row.blk),
    turnoversPerGame: toNumberOrNull(row.tov),
    fgMadePerGame: toNumberOrNull(row.fgm),
    fgAttemptsPerGame: toNumberOrNull(row.fga),
    fgPercentage: toNumberOrNull(row.fg_pct),
    threeMadePerGame: toNumberOrNull(row.tpm),
    threeAttemptsPerGame: toNumberOrNull(row.tpa),
    threePtPercentage: toNumberOrNull(row.tp_pct),
    ftMadePerGame: toNumberOrNull(row.ftm),
    ftAttemptsPerGame: toNumberOrNull(row.fta),
    ftPercentage: toNumberOrNull(row.ft_pct),
    source: team.source
  };
}

function loadSeedPlayers(seedDir) {
  const teams = JSON.parse(fs.readFileSync(path.join(seedDir, 'teams.json'), 'utf8'));
  const now = new Date().toISOString();
  const players = [];
  for (const team of teams) {
    const rows = parseCsv(fs.readFileSync(path.join(seedDir, team.file), 'utf8'));
    for (const row of rows) players.push(seedRowToPlayer(row, team, now));
  }
  return { teams, players };
}

// Folds one game line into a player's season averages. Shooting percentages are
// recomputed from makes/attempts when the game provides them.
function mergeGameIntoSeason(player, game) {
  const gp = Number(player.gamesPlayed) || 0;
  const next = { gamesPlayed: gp + 1 };

  const average = (seasonValue, gameValue) => {
    if (gameValue === null) return seasonValue;
    if (seasonValue === null || seasonValue === undefined) return gp === 0 ? gameValue : seasonValue;
    return round1((seasonValue * gp + gameValue) / (gp + 1));
  };

  const pairs = [
    ['minutesPerGame', 'minutes'],
    ['pointsPerGame', 'points'],
    ['reboundsPerGame', 'rebounds'],
    ['assistsPerGame', 'assists'],
    ['stealsPerGame', 'steals'],
    ['blocksPerGame', 'blocks'],
    ['turnoversPerGame', 'turnovers'],
    ['fgMadePerGame', 'fgm'],
    ['fgAttemptsPerGame', 'fga'],
    ['threeMadePerGame', 'tpm'],
    ['threeAttemptsPerGame', 'tpa'],
    ['ftMadePerGame', 'ftm'],
    ['ftAttemptsPerGame', 'fta']
  ];
  for (const [seasonKey, gameKey] of pairs) next[seasonKey] = average(player[seasonKey], game[gameKey]);

  // Percentages come from season totals (made / attempted), not from averaging percentages.
  const pct = (madeKey, attemptsKey, gameMade, gameAttempts, previous) => {
    if (gameMade === null || gameAttempts === null) return previous;
    const made = (Number(player[madeKey]) || 0) * gp + gameMade;
    const attempts = (Number(player[attemptsKey]) || 0) * gp + gameAttempts;
    return attempts > 0 ? round1((made / attempts) * 100) : previous;
  };
  next.fgPercentage = pct('fgMadePerGame', 'fgAttemptsPerGame', game.fgm, game.fga, player.fgPercentage);
  next.threePtPercentage = pct('threeMadePerGame', 'threeAttemptsPerGame', game.tpm, game.tpa, player.threePtPercentage);
  next.ftPercentage = pct('ftMadePerGame', 'ftAttemptsPerGame', game.ftm, game.fta, player.ftPercentage);

  return next;
}

function openDatabase({ dbPath, seedDir }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS player_game_stats; DROP TABLE IF EXISTS players;');
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      ${PLAYER_COLUMNS.map(([, col, type]) => `${col} ${type}`).join(',\n      ')}
    );

    CREATE TABLE IF NOT EXISTS player_game_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_date TEXT,
      opponent TEXT,
      minutes REAL,
      points REAL,
      rebounds REAL,
      assists REAL,
      steals REAL,
      blocks REAL,
      turnovers REAL,
      fgm REAL,
      fga REAL,
      tpm REAL,
      tpa REAL,
      ftm REAL,
      fta REAL,
      source_file TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_players_name ON players(first_name, last_name);
    CREATE INDEX IF NOT EXISTS idx_game_stats_player_id ON player_game_stats(player_id);
  `);

  const insertPlayerStmt = db.prepare(`
    INSERT INTO players (${PLAYER_COLUMNS.map(([, col]) => col).join(', ')})
    VALUES (${PLAYER_COLUMNS.map(([key]) => `@${key}`).join(', ')})
  `);
  const selectAllPlayersStmt = db.prepare('SELECT * FROM players ORDER BY points_per_game DESC, last_name');
  const selectPlayerStmt = db.prepare('SELECT * FROM players WHERE id = ?');
  const selectGamesStmt = db.prepare(
    'SELECT * FROM player_game_stats WHERE player_id = ? ORDER BY created_at DESC LIMIT ?'
  );
  const insertGameStmt = db.prepare(`
    INSERT INTO player_game_stats (
      player_id, game_date, opponent, minutes, points, rebounds, assists, steals, blocks, turnovers,
      fgm, fga, tpm, tpa, ftm, fta, source_file, created_at
    ) VALUES (
      @playerId, @gameDate, @opponent, @minutes, @points, @rebounds, @assists, @steals, @blocks, @turnovers,
      @fgm, @fga, @tpm, @tpa, @ftm, @fta, @sourceFile, @createdAt
    )
  `);

  function rowToPlayer(row) {
    const player = {};
    for (const [key, col] of PLAYER_COLUMNS) player[key] = row[col] ?? null;
    return player;
  }

  function insertPlayer(record) {
    const params = {};
    for (const [key] of PLAYER_COLUMNS) {
      const value = record[key];
      params[key] = NUMERIC_KEYS.has(key) ? toNumberOrNull(value) : value === undefined || value === '' ? null : String(value);
    }
    insertPlayerStmt.run(params);
  }

  function updatePlayer(id, fields) {
    const keys = Object.keys(fields).filter((key) => key !== 'id' && PLAYER_COLUMNS.some(([k]) => k === key));
    if (!keys.length) return;
    const colFor = Object.fromEntries(PLAYER_COLUMNS.map(([key, col]) => [key, col]));
    const sql = `UPDATE players SET ${keys.map((key) => `${colFor[key]} = @${key}`).join(', ')}, updated_at = @updatedAt WHERE id = @id`;
    db.prepare(sql).run({ ...fields, id, updatedAt: new Date().toISOString() });
  }

  function readPlayers() {
    return selectAllPlayersStmt.all().map(rowToPlayer);
  }

  function getPlayer(id) {
    const row = selectPlayerStmt.get(id);
    return row ? rowToPlayer(row) : null;
  }

  function getRecentGames(playerId, limit = 5) {
    return selectGamesStmt.all(playerId, limit);
  }

  const recordGame = db.transaction((player, game, sourceFile) => {
    insertGameStmt.run({ ...game, playerId: player.id, sourceFile, createdAt: new Date().toISOString() });
    updatePlayer(player.id, mergeGameIntoSeason(player, game));
  });

  let teams = [];
  if (seedDir && fs.existsSync(path.join(seedDir, 'teams.json'))) {
    const seed = loadSeedPlayers(seedDir);
    teams = seed.teams;
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM players').get();
    if (count === 0) db.transaction((rows) => rows.forEach(insertPlayer))(seed.players);
  }

  return { db, teams, readPlayers, getPlayer, getRecentGames, insertPlayer, recordGame };
}

module.exports = { openDatabase, parseCsv, mergeGameIntoSeason, toNumberOrNull, slug };
