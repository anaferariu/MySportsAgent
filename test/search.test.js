const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDatabase, mergeGameIntoSeason } = require('../server/db');
const { parseCriteria, searchPlayers, runRuleChat } = require('../server/search');
const { validateSearchInput } = require('../server/agent');

const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-test-'));
const store = openDatabase({ dbPath: path.join(tmpDir, 'test.db'), seedDir: SEED_DIR });
const players = store.readPlayers();
const teams = store.teams;

const names = (list) => list.map((p) => `${p.firstName} ${p.lastName}`);
const search = (query) => searchPlayers(players, parseCriteria(query, {}, { teams }));

test('seeds 5 teams: 3 NBA (male), 2 WNBA (female)', () => {
  assert.equal(teams.length, 5);
  assert.equal(teams.filter((t) => t.league === 'NBA' && t.gender === 'male').length, 3);
  assert.equal(teams.filter((t) => t.league === 'WNBA' && t.gender === 'female').length, 2);
  assert.equal(players.length, 91);
});

test('"guard with at least 20 points per game"', () => {
  const result = search('guard with at least 20 points per game');
  assert.deepEqual(names(result.matches), ['Shai Gilgeous-Alexander', 'Jaylen Brown', 'Jalen Williams']);
});

test('number-first phrasing works the same', () => {
  assert.deepEqual(names(search('guards 20+ ppg').matches), names(search('guard with at least 20 points per game').matches));
});

test('league and gender filters', () => {
  // Without a games filter, a 1-game player with 8.0 RPG would also qualify.
  const result = search('WNBA forward with 8 rebounds and at least 20 games');
  assert.deepEqual(names(result.matches), ['Alyssa Thomas']);
  assert.ok(result.matches.every((p) => p.gender === 'female'));
});

test('team alias filter', () => {
  const result = search('celtics center');
  assert.ok(result.total > 0);
  assert.ok(result.matches.every((p) => p.team === 'Boston Celtics' && p.position === 'Center'));
});

test('"at least 20 points" is not read as an age limit', () => {
  const criteria = parseCriteria('at least 20 points', {}, { teams });
  assert.equal(criteria.minPointsPerGame, 20);
  assert.equal(criteria.minAge, undefined);
});

test('"us" in a sentence does not set nationality', () => {
  assert.equal(parseCriteria('show us guards', {}, { teams }).nationality, undefined);
});

test('"6 ft 6" is height, not FT%', () => {
  const criteria = parseCriteria("6 ft 6 wing", {}, { teams });
  assert.equal(criteria.minHeightInches, 78);
  assert.equal(criteria.minFtPercentage, undefined);
});

test('3PT% thresholds', () => {
  assert.equal(parseCriteria('40% from three', {}, { teams }).minThreePtPercentage, 40);
  assert.equal(parseCriteria('3pt 38', {}, { teams }).minThreePtPercentage, 38);
  assert.equal(parseCriteria('40%+ 3PT', {}, { teams }).minThreePtPercentage, 40);
});

test('max turnovers', () => {
  const criteria = parseCriteria('point guard under 2 turnovers', {}, { teams });
  assert.equal(criteria.maxTurnoversPerGame, 2);
  assert.equal(criteria.position, 'point guard');
});

test('"top 3 scorers" ranks by points', () => {
  assert.deepEqual(names(search('top 3 scorers').matches), ['Shai Gilgeous-Alexander', 'Jayson Tatum', 'A\'ja Wilson']);
});

test('rule chat answers a specific query without follow-ups', () => {
  const session = { criteria: {}, askedQuestions: [], awaitingQuestionKey: null };
  const reply = runRuleChat(session, { message: 'guard with at least 20 points per game' }, players, teams);
  assert.equal(reply.done, true);
  assert.equal(reply.matches.length, 3);
});

test('rule chat asks a follow-up for a broad query, then searches', () => {
  const session = { criteria: {}, askedQuestions: [], awaitingQuestionKey: null };
  const first = runRuleChat(session, { message: 'NBA players' }, players, teams);
  assert.equal(first.done, false);
  const second = runRuleChat(session, { forceSearch: true }, players, teams);
  assert.equal(second.done, true);
});

test('agent tool input maps onto the same criteria', () => {
  const criteria = validateSearchInput({ position: 'guard', min_points_per_game: 20, team: 'okc' }, teams);
  assert.equal(criteria.team, 'Oklahoma City Thunder');
  assert.deepEqual(names(searchPlayers(players, criteria).matches), ['Shai Gilgeous-Alexander', 'Jalen Williams']);
  assert.throws(() => validateSearchInput({ shoe_size: 12 }, teams), /Unknown filter/);
  assert.throws(() => validateSearchInput({ team: 'Lakers' }, teams), /Unknown team/);
});

test('a boxscore game is folded into season averages', () => {
  const season = { gamesPlayed: 2, pointsPerGame: 10, fgMadePerGame: 4, fgAttemptsPerGame: 10, fgPercentage: 40 };
  const next = mergeGameIntoSeason(season, { points: 31, fgm: 7, fga: 21 });
  assert.equal(next.gamesPlayed, 3);
  assert.equal(next.pointsPerGame, 17);
  assert.equal(next.fgPercentage, 36.6); // (8 + 7) / (20 + 21)
});
