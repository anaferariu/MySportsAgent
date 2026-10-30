// Claude-backed scouting agent. Claude reads the request, calls search_players
// (which runs the same filter engine as the rule-based search), and answers in
// plain language. Opt-in: needs SEARCH_ENGINE=agent plus an Anthropic credential;
// otherwise the app uses the rule-based search.

const Anthropic = require('@anthropic-ai/sdk');
const { searchPlayers, SORT_FIELDS, normalizeEntity, calculateAgeFromDob } = require('./search');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 6;
// History is append-only (required for preserved thinking); start over instead of trimming.
const MAX_HISTORY_MESSAGES = 60;

let client = null;

function hasCredential() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function isAgentRequested() {
  return String(process.env.SEARCH_ENGINE || '').trim().toLowerCase() === 'agent';
}

function isAgentEnabled() {
  return isAgentRequested() && hasCredential();
}

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

// tool input field -> [criteria key, type]
const SEARCH_FIELDS = {
  gender: ['gender', 'enum', ['male', 'female']],
  league: ['league', 'enum', ['NBA', 'WNBA']],
  team: ['team', 'string'],
  position: ['position', 'enum', ['guard', 'point guard', 'shooting guard', 'forward', 'small forward', 'power forward', 'center']],
  nationality: ['nationality', 'string'],
  name_contains: ['nameContains', 'string'],
  min_points_per_game: ['minPointsPerGame', 'number'],
  min_rebounds_per_game: ['minReboundsPerGame', 'number'],
  min_assists_per_game: ['minAssistsPerGame', 'number'],
  min_steals_per_game: ['minStealsPerGame', 'number'],
  min_blocks_per_game: ['minBlocksPerGame', 'number'],
  max_turnovers_per_game: ['maxTurnoversPerGame', 'number'],
  min_fg_pct: ['minFgPercentage', 'number'],
  min_three_pt_pct: ['minThreePtPercentage', 'number'],
  min_three_attempts_per_game: ['minThreeAttemptsPerGame', 'number'],
  min_ft_pct: ['minFtPercentage', 'number'],
  min_games_played: ['minGamesPlayed', 'number'],
  min_minutes_per_game: ['minMinutesPerGame', 'number'],
  min_height_inches: ['minHeightInches', 'number'],
  min_age: ['minAge', 'number'],
  max_age: ['maxAge', 'number'],
  min_ast_to_turnover: ['minAstToTurnover', 'number'],
  keywords: ['keywords', 'string[]'],
  sort_by: ['sortBy', 'enum', Object.keys(SORT_FIELDS)],
  limit: ['limit', 'number']
};

function schemaFor([, type, values]) {
  if (type === 'enum') return { type: 'string', enum: values };
  if (type === 'string[]') return { type: 'array', items: { type: 'string' } };
  return { type };
}

const TOOLS = [
  {
    name: 'list_teams',
    description: 'List the teams in the database with league, season, gender and roster size. Call this when the user refers to a team you are unsure about.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'search_players',
    description:
      'Filter and rank players by season per-game averages. All filters are optional and combined with AND. ' +
      'Percentages are 0-100. Use sort_by to rank (turnovers sorts ascending, everything else descending). ' +
      'Players missing a filtered field (e.g. height, age, nationality are unknown for seeded players) are excluded.',
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(SEARCH_FIELDS).map(([name, spec]) => [name, schemaFor(spec)])),
      additionalProperties: false
    }
  },
  {
    name: 'get_player',
    description: 'Get one player\'s full profile and any uploaded game lines, looked up by (partial) name.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Full or partial player name' } },
      required: ['name'],
      additionalProperties: false
    }
  }
];

function buildSystemPrompt(teams) {
  const teamLines = teams.map((t) => `- ${t.team} (${t.league} ${t.season}, ${t.gender})`).join('\n');
  return [
    'You are the scouting assistant inside MySportsAgent, a basketball scouting app.',
    'The database holds season per-game averages for these teams:',
    teamLines,
    'Users may also add their own players or upload boxscores, so call the tools rather than relying on memory.',
    'Seeded players have stats, position (Guard/Forward/Center), team, league and gender, but no height, age, nationality or scouting notes. ' +
      'If a request depends on those fields, say the data is not available and search on what is.',
    'Use search_players for every question about which players fit; never quote a number that did not come from a tool result. ' +
      'Choose sensible defaults instead of asking follow-up questions; ask only when the request cannot be turned into a search at all. ' +
      'When ranking by a percentage, add a minimum attempts or games filter so tiny samples do not dominate, and say you did.',
    'The app shows the players from your last search_players call as a table under your reply, so do not repeat the full list. ' +
      'Reply in two to five short sentences of plain text (no markdown tables): state the filters you used and point out the standout names and numbers.'
  ].join('\n\n');
}

function validateSearchInput(input, teams) {
  const criteria = {};
  for (const [name, value] of Object.entries(input || {})) {
    const spec = SEARCH_FIELDS[name];
    if (!spec) throw new Error(`Unknown filter "${name}".`);
    if (value === null || value === undefined || value === '') continue;
    const [key, type, values] = spec;
    if (type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
      criteria[key] = n;
    } else if (type === 'enum') {
      const match = values.find((v) => v.toLowerCase() === String(value).toLowerCase());
      if (!match) throw new Error(`${name} must be one of: ${values.join(', ')}.`);
      criteria[key] = match;
    } else if (type === 'string[]') {
      if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings.`);
      criteria[key] = value.map(String);
    } else {
      criteria[key] = String(value).trim();
    }
  }

  if (criteria.team) {
    const wanted = normalizeEntity(criteria.team);
    const team = teams.find((t) => [t.team, ...(t.aliases || [])].some((n) => normalizeEntity(n) === wanted || normalizeEntity(t.team).includes(wanted)));
    if (!team) throw new Error(`Unknown team "${criteria.team}". Known teams: ${teams.map((t) => t.team).join(', ')}.`);
    criteria.team = team.team;
  }
  criteria.limit = Math.min(Math.max(criteria.limit || 15, 1), 50);
  return criteria;
}

function compactPlayer(p) {
  const out = {
    name: `${p.firstName} ${p.lastName}`,
    team: p.team,
    league: p.league,
    season: p.season,
    position: p.position,
    gp: p.gamesPlayed,
    mpg: p.minutesPerGame,
    ppg: p.pointsPerGame,
    rpg: p.reboundsPerGame,
    apg: p.assistsPerGame,
    spg: p.stealsPerGame,
    bpg: p.blocksPerGame,
    tov: p.turnoversPerGame,
    fg_pct: p.fgPercentage,
    three_pt_pct: p.threePtPercentage,
    three_pa: p.threeAttemptsPerGame,
    ft_pct: p.ftPercentage
  };
  const age = calculateAgeFromDob(p.dob);
  if (age !== null) out.age = age;
  if (p.heightDisplay) out.height = p.heightDisplay;
  if (p.nationality) out.nationality = p.nationality;
  if (p.keywords) out.traits = p.keywords;
  if (p.notes) out.notes = p.notes;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null && v !== undefined && v !== ''));
}

function runTool(name, input, store, turn) {
  if (name === 'list_teams') {
    const players = store.readPlayers();
    return store.teams.map((t) => ({
      team: t.team,
      league: t.league,
      season: t.season,
      gender: t.gender,
      players: players.filter((p) => p.team === t.team).length
    }));
  }

  if (name === 'search_players') {
    const criteria = validateSearchInput(input, store.teams);
    const result = searchPlayers(store.readPlayers(), criteria);
    turn.lastSearch = { criteria, matches: result.matches };
    return { total_matches: result.total, returned: result.matches.length, players: result.matches.map(compactPlayer) };
  }

  if (name === 'get_player') {
    const wanted = normalizeEntity(input && input.name);
    if (!wanted) throw new Error('name is required.');
    const candidates = store.readPlayers().filter((p) => normalizeEntity(`${p.firstName} ${p.lastName}`).includes(wanted));
    if (!candidates.length) return { found: false };
    return {
      found: true,
      players: candidates.slice(0, 3).map((p) => ({ ...compactPlayer(p), recent_uploaded_games: store.getRecentGames(p.id, 5) }))
    };
  }

  throw new Error(`Unknown tool "${name}".`);
}

function textOf(content) {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// One user turn. session.messages holds the running conversation and is only appended to.
async function runAgentChat(session, message, store) {
  if (!Array.isArray(session.messages) || session.messages.length > MAX_HISTORY_MESSAGES) session.messages = [];
  session.messages.push({ role: 'user', content: message });

  const turn = { lastSearch: null };
  const system = [{ type: 'text', text: buildSystemPrompt(store.teams), cache_control: { type: 'ephemeral' } }];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await getClient().beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system,
        tools: TOOLS,
        messages: session.messages,
        output_config: { effort: 'medium' },
        // On a safety decline, let the API retry on a fallback model chosen by refusal category.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default'
      });

      session.messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'refusal') {
        return finish(turn, "Sorry, I can't help with that request. Try describing the kind of player you're looking for.");
      }
      if (response.stop_reason === 'pause_turn') continue;

      const toolUses = response.content.filter((block) => block.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !toolUses.length) {
        return finish(turn, textOf(response.content) || 'Done.');
      }

      const results = toolUses.map((block) => {
        try {
          return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(runTool(block.name, block.input, store, turn)) };
        } catch (error) {
          return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: error.message };
        }
      });
      session.messages.push({ role: 'user', content: results });
    }

    return finish(turn, 'I hit my step limit for this request. Here is the last search I ran.');
  } catch (error) {
    // The history may now end mid tool call; start the next turn from a clean slate.
    session.messages = [];
    throw error;
  }
}

function finish(turn, summary) {
  return {
    done: true,
    engine: 'agent',
    summary,
    criteriaUsed: turn.lastSearch ? turn.lastSearch.criteria : null,
    matches: turn.lastSearch ? turn.lastSearch.matches : null,
    separateMatches: []
  };
}

module.exports = { isAgentEnabled, isAgentRequested, hasCredential, runAgentChat, validateSearchInput, MODEL };
