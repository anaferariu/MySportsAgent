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
// The rule-based search covers basketball, like the app's Scout Assistant.
const players = store.readPlayers().filter((p) => p.sport === 'basketball');
const teams = store.teams.filter((t) => t.sport === 'basketball');

const names = (list) => list.map((p) => `${p.firstName} ${p.lastName}`);
const search = (query) => searchPlayers(players, parseCriteria(query, {}, { teams }));

test('seeds 5 basketball teams: 3 NBA (male), 2 WNBA (female)', () => {
  assert.equal(teams.length, 5);
  assert.equal(teams.filter((t) => t.league === 'NBA' && t.gender === 'male').length, 3);
  assert.equal(teams.filter((t) => t.league === 'WNBA' && t.gender === 'female').length, 2);
  assert.equal(players.length, 91);
});

test('seeds 5 soccer teams and 3 NFL teams with sport-specific stats', () => {
  const all = store.readPlayers();
  const soccerTeams = store.teams.filter((t) => t.sport === 'soccer');
  assert.deepEqual(soccerTeams.map((t) => t.league), ['Premier League', 'Premier League', 'Premier League', 'NWSL', 'NWSL']);
  assert.equal(store.teams.filter((t) => t.sport === 'football').length, 3);

  const find = (name) => all.find((p) => `${p.firstName} ${p.lastName}`.trim() === name);
  assert.deepEqual(
    { goals: find('Mohamed Salah').stats.goals, assists: find('Mohamed Salah').stats.assists, position: find('Mohamed Salah').position },
    { goals: 29, assists: 18, position: 'Forward' }
  );
  assert.equal(find('Rodri').lastName, 'Rodri'); // single-name player
  assert.equal(find('Esther González').gender, 'female');
  assert.equal(find('Saquon Barkley').stats.rushYds, 2005);
  assert.equal(find('Saquon Barkley').position, 'Running Back');
  assert.equal(find('Jake Elliott').position, 'Kicker');
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

const newSession = () => ({ criteria: {}, askedQuestions: [], awaitingQuestionKey: null });

test('filters carry over between messages until reset', () => {
  const session = newSession();
  const first = runRuleChat(session, { message: 'guard with at least 15 points per game' }, players, teams);
  assert.equal(first.done, true);
  assert.ok(first.matches.length > 2);

  const second = runRuleChat(session, { message: 'celtics' }, players, teams);
  assert.equal(second.done, true);
  assert.deepEqual(names(second.matches), ['Jaylen Brown', 'Derrick White']);
  assert.match(second.summary, /Filters: Boston Celtics · guard · PPG ≥ 15\./);

  const reset = runRuleChat(session, { message: 'start over' }, players, teams);
  assert.equal(reset.reset, true);
  assert.deepEqual(session.criteria, {});
});

test('a new value replaces the old one, and "any X" removes a filter', () => {
  const session = newSession();
  runRuleChat(session, { message: 'celtics guard with 15 points' }, players, teams);
  runRuleChat(session, { message: '20 points' }, players, teams);
  assert.equal(session.criteria.minPointsPerGame, 20);
  const reply = runRuleChat(session, { message: 'any team' }, players, teams);
  assert.equal(session.criteria.team, undefined);
  assert.deepEqual(names(reply.matches), ['Shai Gilgeous-Alexander', 'Jaylen Brown', 'Jalen Williams']);
});

test('"older than 30" is an age filter, and missing ages are reported', () => {
  const criteria = parseCriteria('male, older than 30, more than 15 points per game', {}, { teams });
  assert.equal(criteria.minAge, 31);
  assert.equal(criteria.minPointsPerGame, 15);
  assert.equal(parseCriteria('younger than 25', {}, { teams }).maxAge, 24);
  assert.equal(parseCriteria('over 30 minutes', {}, { teams }).minAge, undefined);

  const reply = runRuleChat(newSession(), { message: 'male, older than 30, more than 15 points per game' }, players, teams);
  assert.equal(reply.matches.length, 0);
  assert.match(reply.summary, /have no age on record and were left out/);
});

test('a new filter typed while a question is pending is not taken as the answer', () => {
  const session = { ...newSession(), awaitingQuestionKey: 'minThreePtPercentage', askedQuestions: ['minThreePtPercentage'] };
  runRuleChat(session, { message: '8 rebounds' }, players, teams);
  assert.equal(session.criteria.minReboundsPerGame, 8);
  assert.equal(session.criteria.minThreePtPercentage, undefined);
});

test('a bare number still answers the pending question', () => {
  const session = { ...newSession(), criteria: { league: 'NBA', gender: 'male' }, awaitingQuestionKey: 'minThreePtPercentage', askedQuestions: ['minThreePtPercentage'] };
  runRuleChat(session, { message: '35' }, players, teams);
  assert.equal(session.criteria.minThreePtPercentage, 35);
});

// ---------- soccer and football ----------

const allPlayers = store.readPlayers();
const sportSearch = (sport) => {
  const session = newSession();
  const ps = allPlayers.filter((p) => p.sport === sport);
  const ts = store.teams.filter((t) => t.sport === sport);
  return (message) => runRuleChat(session, { message, forceSearch: true }, ps, ts, sport);
};
const top = (reply, n = 5) => names(reply.matches).slice(0, n).map((n) => n.trim());

test('soccer: position, goals, assists and league', () => {
  assert.deepEqual(top(sportSearch('soccer')('forward with at least 10 goals'), 2), ['Mohamed Salah', 'Erling Haaland']);
  const nwsl = sportSearch('soccer')('NWSL midfielder with 5+ assists');
  assert.deepEqual(top(nwsl), ['Sarah Schupansky']);
  assert.match(nwsl.summary, /female · NWSL · midfielder · assists ≥ 5/);
  assert.deepEqual(top(sportSearch('soccer')('top 3 scorers in the premier league')), ['Mohamed Salah', 'Erling Haaland', 'Luis Díaz']);
});

test('soccer: goalkeepers, cards and goal contributions', () => {
  assert.deepEqual(top(sportSearch('soccer')('goalkeeper with 70 saves')), ['David Raya', 'Alisson Becker', 'Aubrey Kingsbury']);
  const defenders = sportSearch('soccer')('defender with fewer than 3 yellow cards and at least 25 appearances');
  assert.ok(defenders.matches.every((p) => p.position === 'Defender' && p.stats.yellowCards <= 3 && p.stats.apps >= 25));
  assert.equal(parseCriteria('15 goal contributions', {}, { sport: 'soccer' }).minGoalContributions, 15);
  assert.equal(parseCriteria('15 goal contributions', {}, { sport: 'soccer' }).minGoals, undefined);
  assert.equal(parseCriteria('under 30 goals conceded', {}, { sport: 'soccer' }).maxGoalsAgainst, 30);
  assert.equal(parseCriteria('no red cards', {}, { sport: 'soccer' }).maxRedCards, 0);
  assert.equal(parseCriteria('english premier league midfielder', {}, { sport: 'soccer' }).nationality, undefined);
});

test('football: rushing, passing and interceptions', () => {
  assert.deepEqual(top(sportSearch('football')('running back with 1000 rushing yards')), ['Saquon Barkley', 'James Cook III']);
  const qb = parseCriteria('quarterback with 25 passing touchdowns and under 10 interceptions', {}, { sport: 'football' });
  assert.deepEqual([qb.position, qb.minPassTd, qb.maxPassInt, qb.minDefInt], ['quarterback', 25, 10, undefined]);
  assert.deepEqual(top(sportSearch('football')('quarterback with 25 passing touchdowns and under 10 interceptions')), ['Josh Allen']);
  // "2 interceptions" for a defender means interceptions made, not thrown.
  const cb = parseCriteria('cornerback with at least 2 interceptions', {}, { sport: 'football' });
  assert.deepEqual([cb.minDefInt, cb.maxPassInt], [2, undefined]);
});

test('football: generic yards depend on the position', () => {
  assert.equal(parseCriteria('receiver with 800 yards', {}, { sport: 'football' }).minScrimmageYds, 800);
  assert.equal(parseCriteria('quarterback with 3500 yards', {}, { sport: 'football' }).minPassYds, 3500);
  assert.equal(parseCriteria('1000 rushing yards and 5 yards per carry', {}, { sport: 'football' }).minRushYds, 1000);
});

test('football: rankings and ratio filters need a minimum volume', () => {
  const rush = sportSearch('football')('best pass rusher');
  assert.equal(rush.done, true); // a ranking is answered without follow-up questions
  assert.equal(top(rush, 1)[0], 'George Karlaftis');
  const kickers = sportSearch('football')('kicker with 80% field goal');
  assert.deepEqual(top(kickers), ['Harrison Butker', 'Tyler Bass']); // not the 3-for-3 backup
  assert.match(kickers.summary, /FG attempts ≥ 10/);
  assert.deepEqual(top(sportSearch('football')('most accurate quarterback')), ['Jalen Hurts', 'Patrick Mahomes', 'Josh Allen']);
});

test('football: position groups', () => {
  const db = sportSearch('football')('defensive backs with 4 interceptions');
  assert.deepEqual(top(db), ['C.J. Gardner-Johnson', 'Reed Blankenship']);
});

test('football: a broad query asks for the position first', () => {
  const session = newSession();
  const ps = allPlayers.filter((p) => p.sport === 'football');
  const ts = store.teams.filter((t) => t.sport === 'football');
  const first = runRuleChat(session, { message: 'NFL players' }, ps, ts, 'football');
  assert.match(first.question, /Which position/);
  const second = runRuleChat(session, { message: 'linebacker' }, ps, ts, 'football');
  assert.match(second.question, /Minimum tackles/);
  const third = runRuleChat(session, { message: '100' }, ps, ts, 'football');
  assert.equal(third.done, true);
  assert.ok(third.matches.every((p) => p.position === 'Linebacker' && p.stats.tackles >= 100));
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
