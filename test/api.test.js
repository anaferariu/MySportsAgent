// Starts the real Express app on a random port against a throwaway data dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-api-'));
delete process.env.SEARCH_ENGINE;
delete process.env.ALLOW_VIDEO_UPLOADS;
// 91 seeded players + room for exactly one more, so the cap is reachable in tests.
process.env.MAX_PLAYERS = '92';
const app = require('../server/index');

let server;
let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const sessionId = '0b6f3a4e-1111-4c2d-9e8f-123456789abc';
const chat = (body) =>
  fetch(`${base}/api/agent/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('players are public and carry age, not date of birth', async () => {
  const res = await fetch(`${base}/api/players`);
  assert.equal(res.status, 200);
  const players = await res.json();
  assert.equal(players.length, 91);
  assert.ok(players.every((p) => !('dob' in p)));
});

test('search works without a login', async () => {
  const res = await chat({ sessionId, message: 'guard with at least 20 points per game' });
  const body = await res.json();
  assert.equal(body.done, true);
  assert.deepEqual(body.matches.map((p) => p.lastName), ['Gilgeous-Alexander', 'Brown', 'Williams']);
});

test('a follow-up question round trip does not crash the server', async () => {
  const id = '9a7e2c1d-2222-4b3a-8c9d-abcdefabcdef';
  const first = await (await chat({ sessionId: id, message: 'NBA players' })).json();
  assert.equal(first.done, false);
  assert.ok(first.question);
  const second = await (await chat({ sessionId: id, forceSearch: true })).json();
  assert.equal(second.done, true);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('chat requires a session id', async () => {
  const res = await chat({ message: 'guards' });
  assert.equal(res.status, 400);
});

test('a player added through the form is returned with age only', async () => {
  const form = new FormData();
  form.append('firstName', 'Test');
  form.append('lastName', 'Player');
  form.append('position', 'Guard');
  form.append('dob', '2000-05-01');
  const res = await fetch(`${base}/api/players`, { method: 'POST', body: form });
  assert.equal(res.status, 201);
  const player = await res.json();
  assert.equal('dob' in player, false);
  assert.equal(typeof player.age, 'number');
});

test('video uploads are refused and nothing is saved', async () => {
  const before = (await (await fetch(`${base}/api/players`)).json()).length;
  const form = new FormData();
  form.append('firstName', 'Video');
  form.append('lastName', 'Attempt');
  form.append('position', 'Guard');
  form.append('highlightVideo', new Blob(['not really a video']), 'clip.mp4');
  const res = await fetch(`${base}/api/players`, { method: 'POST', body: form });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /video uploads are disabled for safety reasons/);
  const after = (await (await fetch(`${base}/api/players`)).json()).length;
  assert.equal(after, before);
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'uploads')), false);
});

test('adding players stops at the cap', async () => {
  const form = new FormData();
  form.append('firstName', 'One');
  form.append('lastName', 'TooMany');
  form.append('position', 'Center');
  const res = await fetch(`${base}/api/players`, { method: 'POST', body: form });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /database is full \(92 players\)/);
});

test('the sample boxscore uploads and updates 18 players', async () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'data', 'samples', 'wnba-finals-2025-game4.csv'));
  const form = new FormData();
  form.append('boxscoreFile', new Blob([file]), 'wnba-finals-2025-game4.csv');
  const body = await (await fetch(`${base}/api/boxscores/upload`, { method: 'POST', body: form })).json();
  assert.equal(body.matchedRows, 18);
  assert.equal(body.unmatchedRows, 0);
});
