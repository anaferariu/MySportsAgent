// Claude-backed scouting agent. Claude reads the request, calls search_players
// (which runs the same filter engine as the rule-based search), and answers in
// plain language. Opt-in: needs SEARCH_ENGINE=agent plus an Anthropic credential;
// otherwise the app uses the rule-based search.
//
// Each sport gets its own tool definition and instructions, generated from that
// sport's search profile (search.js) and definitions (sports.js), so the agent
// can use exactly the filters and rankings the rule-based search understands.

const Anthropic = require('@anthropic-ai/sdk');
const { searchPlayers, searchSchema, applyVolumeGuards, normalizeEntity, calculateAgeFromDob, metric } = require('./search');
const { SPORTS } = require('./sports');

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

// minPointsPerGame -> min_points_per_game
const toSnake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// Season stats worth showing Claude next to the stored ones (they are computed, not stored).
const DERIVED_FOR = {
  soccer: ['starts', 'goalContributions', 'goalsPerApp'],
  football: ['scrimmageYds', 'totalTd', 'completionPct', 'yardsPerCarry', 'fgPct']
};

// tool input field -> { key: criteria key, type, values?, description? } for one sport.
function searchFields(sport, teams) {
  const schema = searchSchema(sport);
  const leagues = [...new Set(teams.map((t) => t.league))];
  const fields = {
    gender: { key: 'gender', type: 'enum', values: ['male', 'female'] },
    league: { key: 'league', type: 'enum', values: leagues },
    team: { key: 'team', type: 'string', description: 'Team name or nickname' },
    position: { key: 'position', type: 'enum', values: SPORTS[sport].positions.map((p) => p.toLowerCase()) },
    nationality: { key: 'nationality', type: 'string' },
    name_contains: { key: 'nameContains', type: 'string' },
    min_age: { key: 'minAge', type: 'number' },
    max_age: { key: 'maxAge', type: 'number' }
  };
  for (const [key, def] of Object.entries(schema.thresholds)) {
    fields[toSnake(key)] = { key, type: 'number', description: `${def.dir === 'min' ? 'Minimum' : 'Maximum'} ${def.label}` };
  }
  if (sport === 'basketball') fields.min_ast_to_turnover = { key: 'minAstToTurnover', type: 'number', description: 'Minimum assist-to-turnover ratio' };
  fields.keywords = { key: 'keywords', type: 'string[]', description: 'Free-text traits matched against scouting notes' };
  fields.sort_by = {
    key: 'sortBy',
    type: 'enum',
    values: Object.keys(schema.sortFields),
    description: Object.entries(schema.sortFields)
      .map(([key, def]) => `${key}: ${def.label}${def.ascending ? ' (lowest first)' : ''}`)
      .join('; ')
  };
  fields.limit = { key: 'limit', type: 'number', description: 'How many players to return (1-50, default 15)' };
  return fields;
}

function schemaFor(field) {
  const base =
    field.type === 'enum'
      ? { type: 'string', enum: field.values }
      : field.type === 'string[]'
        ? { type: 'array', items: { type: 'string' } }
        : { type: field.type };
  return field.description ? { ...base, description: field.description } : base;
}

const STAT_NOTES = {
  basketball: 'Stats are season per-game averages; percentages are 0-100.',
  soccer: 'Stats are league season totals (appearances, goals, assists, shots, cards; saves and goals conceded for goalkeepers); percentages are 0-100. A blank stat means it did not happen and counts as 0.',
  football: 'Stats are regular-season totals (passing, rushing, receiving, defense, kicking); percentages are 0-100. A blank stat means it did not happen and counts as 0.'
};

function buildTools(sport, teams) {
  const fields = searchFields(sport, teams);
  return [
    {
      name: 'list_teams',
      description: 'List the teams in the database with league, season, gender and roster size. Call this when the user refers to a team you are unsure about.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'search_players',
      description:
        `Filter and rank ${SPORTS[sport].noun} players. All filters are optional and combined with AND. ${STAT_NOTES[sport]} ` +
        'Use sort_by to rank; a "highest first" ranking only lists players with a non-zero value. ' +
        'Percentage filters and rankings automatically add a minimum volume (e.g. attempts) so tiny samples do not dominate. ' +
        'Players missing height, age or nationality are excluded when you filter on those fields.',
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, schemaFor(field)])),
        additionalProperties: false
      }
    },
    {
      name: 'get_player',
      description: "Get one player's full profile and any uploaded game lines, looked up by (partial) name.",
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Full or partial player name' } },
        required: ['name'],
        additionalProperties: false
      }
    }
  ];
}

const SEEDED_FIELDS = {
  basketball: 'Seeded players have stats, position, team, league and gender, but no height, age, nationality or scouting notes.',
  soccer: 'Seeded players have stats, position, team, league, gender and nationality, but no height, age or scouting notes.',
  football: 'Seeded players have stats, position, team, league and gender, but no height, age, nationality or scouting notes.'
};

function buildSystemPrompt(sport, teams) {
  const def = SPORTS[sport];
  const teamLines = teams.map((t) => `- ${t.team} (${t.league} ${t.season}, ${t.gender})`).join('\n');
  return [
    `You are the ${def.noun} scouting assistant inside MySportsAgent, a scouting app for basketball, soccer and American football. This conversation is about ${def.noun} only.`,
    'The database holds season statistics for these teams:',
    teamLines,
    `Positions: ${def.positions.join(', ')}. ${STAT_NOTES[sport]}`,
    'Users may also add their own players or upload boxscores, so call the tools rather than relying on memory.',
    `${SEEDED_FIELDS[sport]} If a request depends on fields that are not available, say so and search on what is.`,
    'Use search_players for every question about which players fit; never quote a number that did not come from a tool result. ' +
      'Choose sensible defaults instead of asking follow-up questions; ask only when the request cannot be turned into a search at all.',
    'The app shows the players from your last search_players call as a table under your reply, so do not repeat the full list. ' +
      'Reply in two to five short sentences of plain text (no markdown tables): state the filters you used and point out the standout names and numbers.'
  ].join('\n\n');
}

function validateSearchInput(input, teams, sport = 'basketball') {
  const fields = searchFields(sport, teams);
  const criteria = {};
  for (const [name, value] of Object.entries(input || {})) {
    const field = fields[name];
    if (!field) throw new Error(`Unknown filter "${name}".`);
    if (value === null || value === undefined || value === '') continue;
    if (field.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
      criteria[field.key] = n;
    } else if (field.type === 'enum') {
      const match = field.values.find((v) => v.toLowerCase() === String(value).toLowerCase());
      if (!match) throw new Error(`${name} must be one of: ${field.values.join(', ')}.`);
      criteria[field.key] = match;
    } else if (field.type === 'string[]') {
      if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings.`);
      criteria[field.key] = value.map(String);
    } else {
      criteria[field.key] = String(value).trim();
    }
  }

  if (criteria.team) {
    const wanted = normalizeEntity(criteria.team);
    const team = teams.find((t) => [t.team, ...(t.aliases || [])].some((n) => normalizeEntity(n) === wanted || normalizeEntity(t.team).includes(wanted)));
    if (!team) throw new Error(`Unknown team "${criteria.team}". Known teams: ${teams.map((t) => t.team).join(', ')}.`);
    criteria.team = team.team;
  }
  criteria.limit = Math.min(Math.max(criteria.limit || 15, 1), 50);
  return applyVolumeGuards(criteria, sport);
}

function compactPlayer(p) {
  const out = {
    name: `${p.firstName || ''} ${p.lastName || ''}`.trim(),
    team: p.team,
    league: p.league,
    season: p.season,
    position: p.position
  };
  if (p.sport === 'basketball') {
    Object.assign(out, {
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
    });
  } else {
    out.stats = { ...p.stats };
    for (const key of DERIVED_FOR[p.sport] || []) {
      const value = metric(p, key);
      if (value !== null) out.stats[key] = value;
    }
  }
  const age = calculateAgeFromDob(p.dob);
  if (age !== null) out.age = age;
  if (p.heightDisplay) out.height = p.heightDisplay;
  if (p.nationality) out.nationality = p.nationality;
  if (p.keywords) out.traits = p.keywords;
  if (p.notes) out.notes = p.notes;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null && v !== undefined && v !== ''));
}

function runTool(name, input, store, sport, turn) {
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
    const criteria = validateSearchInput(input, store.teams, sport);
    const result = searchPlayers(store.readPlayers(), criteria, sport);
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

// One user turn. session.messages holds the running conversation (one per sport
// tab) and is only appended to. `store` holds that sport's players and teams.
async function runAgentChat(session, message, store, sport = 'basketball') {
  if (!Array.isArray(session.messages) || session.messages.length > MAX_HISTORY_MESSAGES) session.messages = [];
  session.messages.push({ role: 'user', content: message });

  const turn = { lastSearch: null };
  const system = [{ type: 'text', text: buildSystemPrompt(sport, store.teams), cache_control: { type: 'ephemeral' } }];
  const tools = buildTools(sport, store.teams);

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await getClient().beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system,
        tools,
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
          return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(runTool(block.name, block.input, store, sport, turn)) };
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

module.exports = { isAgentEnabled, isAgentRequested, hasCredential, runAgentChat, validateSearchInput, buildTools, MODEL };
