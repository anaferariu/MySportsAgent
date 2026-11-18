// Exercises the agent's tool loop against a scripted fake of the Anthropic SDK,
// so it runs without an API key or network access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const requests = [];
let scripted = [];

class FakeAnthropic {
  constructor() {
    this.beta = {
      messages: {
        create: async (params) => {
          requests.push(structuredClone(params));
          const next = scripted.shift();
          if (next instanceof Error) throw next;
          return next;
        }
      }
    };
  }
}
const sdkPath = require.resolve('@anthropic-ai/sdk');
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.SEARCH_ENGINE = 'agent';

const { openDatabase } = require('../server/db');
const { runAgentChat, isAgentEnabled, buildTools, validateSearchInput } = require('../server/agent');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-agent-'));
const fullStore = openDatabase({ dbPath: path.join(tmpDir, 'test.db'), seedDir: path.join(__dirname, '..', 'data', 'seed') });
// The server hands the agent one sport's slice of the database, like this.
const storeFor = (sport) => ({
  ...fullStore,
  teams: fullStore.teams.filter((t) => t.sport === sport),
  readPlayers: () => fullStore.readPlayers().filter((p) => p.sport === sport)
});
const store = storeFor('basketball');

const searchTool = (sport) => buildTools(sport, storeFor(sport).teams).find((t) => t.name === 'search_players');

test('each sport gets its own search tool filters', () => {
  const basketball = Object.keys(searchTool('basketball').input_schema.properties);
  const soccer = searchTool('soccer').input_schema.properties;
  const football = searchTool('football').input_schema.properties;
  assert.ok(basketball.includes('min_points_per_game'));
  assert.ok('min_goals' in soccer && 'max_yellow_cards' in soccer && !('min_points_per_game' in soccer));
  assert.deepEqual(soccer.league.enum, ['Premier League', 'NWSL']);
  assert.ok(soccer.position.enum.includes('goalkeeper'));
  assert.ok('min_rush_yds' in football && 'max_pass_int' in football && 'min_sacks' in football);
  assert.ok(football.sort_by.enum.includes('sacks'));
});

test('the agent gets the same minimum-volume rules as the rule-based search', () => {
  const criteria = validateSearchInput({ position: 'kicker', min_fg_pct: 80 }, storeFor('football').teams, 'football');
  assert.equal(criteria.minFga, 10);
  assert.throws(() => validateSearchInput({ min_goals: 5 }, storeFor('football').teams, 'football'), /Unknown filter/);
});

test('the agent searches soccer with soccer filters', async () => {
  requests.length = 0;
  scripted = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_s', name: 'search_players', input: { position: 'forward', min_goals: 10 } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Salah leads with 29 goals.' }] }
  ];
  const reply = await runAgentChat({ messages: [] }, 'forwards with 10+ goals', storeFor('soccer'), 'soccer');
  assert.deepEqual(reply.matches.map((p) => p.lastName).slice(0, 2), ['Salah', 'Haaland']);
  assert.match(requests[0].system[0].text, /soccer scouting assistant/);
  assert.match(requests[0].system[0].text, /Liverpool \(Premier League 2024-25, male\)/);
  const toolResult = JSON.parse(requests[1].messages.at(-1).content[0].content);
  assert.equal(toolResult.players[0].stats.goals, 29);
  assert.equal(toolResult.players[0].stats.goalContributions, 47); // derived stats are included
});

test('the agent is opt-in: an API key alone keeps the rule-based search', () => {
  process.env.SEARCH_ENGINE = '';
  assert.equal(isAgentEnabled(), false);
  process.env.SEARCH_ENGINE = 'agent';
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(isAgentEnabled(), false);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  assert.equal(isAgentEnabled(), true);
});

test('agent runs search_players and returns its matches with the reply', async () => {
  assert.equal(isAgentEnabled(), true);
  requests.length = 0;
  scripted = [
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'search_players', input: { position: 'guard', min_points_per_game: 20 } }]
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Three guards average 20+ points.' }] }
  ];

  const session = { messages: [] };
  const reply = await runAgentChat(session, 'guard with at least 20 points per game', store);

  assert.equal(reply.engine, 'agent');
  assert.equal(reply.summary, 'Three guards average 20+ points.');
  assert.deepEqual(reply.matches.map((p) => p.lastName), ['Gilgeous-Alexander', 'Brown', 'Williams']);

  const [first, second] = requests;
  assert.equal(first.model, 'claude-opus-5-5');
  assert.deepEqual(first.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(first.fallbacks, 'default');
  assert.deepEqual(first.tools.map((t) => t.name), ['list_teams', 'search_players', 'get_player']);

  const toolResult = second.messages.at(-1).content[0];
  assert.equal(toolResult.tool_use_id, 'tu_1');
  assert.equal(JSON.parse(toolResult.content).total_matches, 3);

  // user, assistant(tool_use), user(tool_result), assistant(text): append-only history.
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('invalid tool input comes back to the model as an error result', async () => {
  requests.length = 0;
  scripted = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_2', name: 'search_players', input: { team: 'Lakers' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The Lakers are not in the database.' }] }
  ];
  const reply = await runAgentChat({ messages: [] }, 'lakers guards', store);
  const toolResult = requests[1].messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /Unknown team/);
  assert.equal(reply.matches, null);
});

test('an API error clears the conversation so the next turn starts clean', async () => {
  scripted = [new Error('overloaded')];
  const session = { messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] };
  await assert.rejects(runAgentChat(session, 'centers', store), /overloaded/);
  assert.deepEqual(session.messages, []);
});
