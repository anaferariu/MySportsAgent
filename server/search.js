// Rule-based scouting search. parseCriteria() turns free text into a criteria
// object; searchPlayers() filters and ranks players against it. The Claude agent
// (agent.js) builds the same criteria object through a tool call, so both
// engines share one filter implementation.

const NUM = '(\\d+(?:\\.\\d+)?)';
const AT_LEAST = '(?:at least|min(?:imum)?|over|above|more than|greater than|>=|>)';
const AT_MOST = '(?:at most|max(?:imum)?|under|below|less than|fewer than|no more than|<=|<)';
const OR_MORE = '(?:\\s*\\+|\\s*or\\s*(?:more|better|higher|above))?';

const SORT_FIELDS = {
  points: { key: 'pointsPerGame', label: 'PPG' },
  rebounds: { key: 'reboundsPerGame', label: 'RPG' },
  assists: { key: 'assistsPerGame', label: 'APG' },
  steals: { key: 'stealsPerGame', label: 'SPG' },
  blocks: { key: 'blocksPerGame', label: 'BPG' },
  turnovers: { key: 'turnoversPerGame', label: 'TOV', ascending: true },
  minutes: { key: 'minutesPerGame', label: 'MIN' },
  fg_pct: { key: 'fgPercentage', label: 'FG%' },
  three_pt_pct: { key: 'threePtPercentage', label: '3PT%' },
  ft_pct: { key: 'ftPercentage', label: 'FT%' },
  three_made: { key: 'threeMadePerGame', label: '3PM' },
  games: { key: 'gamesPlayed', label: 'GP' }
};

// Numeric thresholds: criteria key -> [player key, label, direction, score weight].
const THRESHOLDS = {
  minHeightInches: ['heightInches', 'height', 'min', 7],
  minGamesPlayed: ['gamesPlayed', 'GP', 'min', 1],
  minMinutesPerGame: ['minutesPerGame', 'MIN', 'min', 2],
  minPointsPerGame: ['pointsPerGame', 'PPG', 'min', 6],
  minReboundsPerGame: ['reboundsPerGame', 'RPG', 'min', 5],
  minAssistsPerGame: ['assistsPerGame', 'APG', 'min', 5],
  minStealsPerGame: ['stealsPerGame', 'SPG', 'min', 3],
  minBlocksPerGame: ['blocksPerGame', 'BPG', 'min', 3],
  maxTurnoversPerGame: ['turnoversPerGame', 'TOV', 'max', 4],
  minFgPercentage: ['fgPercentage', 'FG%', 'min', 5],
  minThreePtPercentage: ['threePtPercentage', '3PT%', 'min', 7],
  minThreeAttemptsPerGame: ['threeAttemptsPerGame', '3PA', 'min', 2],
  minFtPercentage: ['ftPercentage', 'FT%', 'min', 4],
  minVerticalInches: ['verticalInches', 'vertical', 'min', 4]
};

const COUNTRY_ALIASES = {
  usa: 'usa', american: 'usa', 'united states': 'usa',
  canada: 'canada', canadian: 'canada',
  spain: 'spain', spanish: 'spain',
  france: 'france', french: 'france',
  germany: 'germany', german: 'germany',
  serbia: 'serbia', serbian: 'serbia',
  greece: 'greece', greek: 'greece',
  latvia: 'latvia', latvian: 'latvia',
  romania: 'romania', romanian: 'romania',
  poland: 'poland', polish: 'poland',
  slovakia: 'slovakia', slovak: 'slovakia',
  cameroon: 'cameroon', cameroonian: 'cameroon',
  australia: 'australia', australian: 'australia'
};

// Traits that map to a stat ranking rather than free-text notes.
const TRAIT_SORTS = [
  [/\b(?:scorers?|bucket getters?)\b/, 'points'],
  [/\b(?:shooters?|snipers?|marksm[ae]n)\b/, 'three_pt_pct'],
  [/\b(?:playmakers?|passers?|facilitators?)\b/, 'assists'],
  [/\b(?:rebounders?|glass cleaners?)\b/, 'rebounds'],
  [/\b(?:rim protectors?|shot blockers?)\b/, 'blocks'],
  [/\b(?:ball hawks?|defensive guards?|perimeter defenders?)\b/, 'steals'],
  [/\b(?:ball security|takes care of the ball|low turnovers?)\b/, 'turnovers']
];

const SOFT_TRAITS = [
  'long', 'athletic', 'quick', 'aggressive', 'switchable', 'high iq', 'high motor', 'catch and shoot', 'on ball', 'off ball'
];

function normalizeEntity(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Keeps the punctuation that carries meaning in queries (% + ' " . / -).
function normalizeQuery(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9\s%+'"./<>=-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasValue(value) {
  return value !== '' && value !== null && value !== undefined && !(typeof value === 'number' && Number.isNaN(value));
}

function calculateAgeFromDob(dob) {
  if (!dob) return null;
  const date = new Date(dob);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const monthDelta = today.getMonth() - date.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < date.getDate())) age -= 1;
  return age;
}

function parseHeightToInches(value) {
  const text = normalizeQuery(value);
  if (!text) return null;
  const feetInch = text.match(/(\d)\s*(?:'|ft|feet|foot)\s*(\d{1,2})?/);
  if (feetInch) return Number(feetInch[1]) * 12 + Number(feetInch[2] || 0);
  const cm = text.match(/(\d{3}(?:\.\d+)?)\s*cm/);
  if (cm) return Math.round((Number(cm[1]) / 2.54) * 10) / 10;
  const inches = text.match(/(\d{2}(?:\.\d+)?)\s*(?:"|in\b|inch|inches)/);
  if (inches) return Number(inches[1]);
  return null;
}

// "20 points", "20+ ppg", "20 or more points", "at least 20 points", "over 20 ppg".
function matchMin(text, statPattern) {
  const after = text.match(new RegExp(`${NUM}\\s*%?${OR_MORE}\\s*(?:${statPattern})(?![a-z])`));
  // Leading \b so "ast" does not match inside "at least".
  const before = text.match(new RegExp(`\\b(?:${statPattern})\\s*(?:per game\\s*)?(?:of\\s*)?${AT_LEAST}?\\s*${NUM}`));
  const atMost = new RegExp(`${AT_MOST}\\s*${NUM}\\s*%?\\s*(?:${statPattern})`).test(text);
  if (atMost) return null;
  if (after) return Number(after[1]);
  if (before) return Number(before[1]);
  return null;
}

function matchMax(text, statPattern) {
  const m = text.match(new RegExp(`${AT_MOST}\\s*${NUM}\\s*%?\\s*(?:${statPattern})`));
  return m ? Number(m[1]) : null;
}

function parseCriteria(message, previousCriteria = {}, context = {}) {
  const text = normalizeQuery(message);
  const criteria = { ...previousCriteria };
  const teams = context.teams || [];

  if (/\b(?:show results|search now|run search|find them|that'?s all|done|go ahead)\b/.test(text)) {
    criteria._forceSearch = true;
  }

  if (/\b(?:female|women'?s?|woman|girls?|ladies)\b/.test(text)) criteria.gender = 'female';
  else if (/\b(?:male|men'?s?|boys?)\b/.test(text)) criteria.gender = 'male';

  if (/\bwnba\b/.test(text)) {
    criteria.league = 'WNBA';
    criteria.gender = 'female';
  } else if (/\bnba\b/.test(text)) {
    criteria.league = 'NBA';
    criteria.gender = 'male';
  }

  for (const team of teams) {
    const names = [team.team, ...(team.aliases || [])].map(normalizeEntity);
    if (names.some((name) => new RegExp(`\\b${name}\\b`).test(normalizeEntity(text)))) {
      criteria.team = team.team;
      break;
    }
  }

  if (/left\s*-?\s*hand(?:ed)?|lefty|southpaw/.test(text)) criteria.handedness = 'left';
  else if (/right\s*-?\s*hand(?:ed)?/.test(text)) criteria.handedness = 'right';
  else if (/ambidextrous/.test(text)) criteria.handedness = 'ambidextrous';

  if (/exclude unknown|only complete|complete data only|no missing/.test(text)) criteria.unknownDataMode = 'exclude';
  if (/include unknown|allow missing|missing is ok/.test(text)) criteria.unknownDataMode = 'include';
  if (/show unknown separately|separate unknown|split unknown/.test(text)) criteria.unknownDataMode = 'separate';

  if (/national team/.test(text)) {
    if (/\b(?:not|no|never|exclude)\b[^.]*national team/.test(text)) criteria.playsInNationalTeam = 'no';
    else criteria.playsInNationalTeam = 'yes';
  }

  const positions = [
    [/\bpoint guards?\b/, 'point guard'],
    [/\bshooting guards?\b/, 'shooting guard'],
    [/\bsmall forwards?\b/, 'small forward'],
    [/\bpower forwards?\b/, 'power forward'],
    [/\b(?:centers?|centres?|bigs?|big m[ae]n)\b/, 'center'],
    [/\bguards?\b/, 'guard'],
    [/\b(?:forwards?|wings?)\b/, 'forward']
  ];
  for (const [pattern, position] of positions) {
    if (pattern.test(text)) {
      criteria.position = position;
      break;
    }
  }

  for (const [alias, country] of Object.entries(COUNTRY_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(text)) {
      criteria.nationality = country;
      break;
    }
  }

  const height = text.match(/(\d)\s*(?:'|ft|feet)\s*(\d{1,2})?\s*(?:"|in)?\s*(?:\+|or taller|and up|or above)?/);
  if (height) criteria.minHeightInches = Number(height[1]) * 12 + Number(height[2] || 0);

  const stats = [
    ['minPointsPerGame', 'ppg|points?|pts'],
    ['minReboundsPerGame', 'rpg|rebounds?|boards|reb'],
    ['minAssistsPerGame', 'apg|assists?|ast'],
    ['minStealsPerGame', 'spg|steals?|stl'],
    ['minBlocksPerGame', 'bpg|blocks?|blk'],
    ['minGamesPlayed', 'games(?: played)?|gp'],
    ['minMinutesPerGame', 'mpg|minutes']
  ];
  for (const [key, pattern] of stats) {
    const value = matchMin(text, pattern);
    if (value !== null) criteria[key] = value;
  }

  const maxTov = matchMax(text, 'tov|turnovers?');
  if (maxTov !== null) criteria.maxTurnoversPerGame = maxTov;

  const threePattern = "3\\s*pt%?|3p%?|three\\s*-?\\s*point(?:ers?| percentage| shooting)?|from (?:three|3|deep|downtown)";
  const three = matchMin(text, threePattern);
  if (three !== null) criteria.minThreePtPercentage = three;

  // Bare "ft" is ambiguous with height ("6 ft 6"), so it needs a % sign nearby.
  const ftPercentFirst = text.match(new RegExp(`${NUM}\\s*%\\s*\\+?\\s*ft\\b`));
  const ft = ftPercentFirst ? Number(ftPercentFirst[1]) : matchMin(text, 'ft\\s*%|ft pct|free\\s*throws?(?: percentage)?|from the line');
  if (ft !== null) criteria.minFtPercentage = ft;

  const fg = matchMin(text, 'fg%?|field\\s*goals?(?: percentage)?');
  if (fg !== null) criteria.minFgPercentage = fg;

  const vertical = text.match(new RegExp(`${NUM}\\s*(?:"|in|inch(?:es)?)?\\s*(?:vertical|vert|jump)`));
  if (vertical) criteria.minVerticalInches = Number(vertical[1]);

  const ageBetween = text.match(/between\s+(\d{1,2})\s*(?:and|-)\s*(\d{1,2})\s*(?:years?|yrs?|yo)/);
  if (ageBetween) {
    criteria.minAge = Number(ageBetween[1]);
    criteria.maxAge = Number(ageBetween[2]);
  }
  const maxAge = text.match(/(?:under|younger than|at most|max(?:imum)? age(?: of)?)\s*(\d{1,2})\s*(?:years?|yrs?|yo)\b|age\s*(?:under|below|<)\s*(\d{1,2})/);
  if (maxAge) criteria.maxAge = Number(maxAge[1] || maxAge[2]);
  const minAge = text.match(/(?:over|older than|at least)\s*(\d{1,2})\s*(?:years?|yrs?|yo)\b|age\s*(?:over|above|>)\s*(\d{1,2})/);
  if (minAge) criteria.minAge = Number(minAge[1] || minAge[2]);

  const astTo = text.match(/(?:a\/t|assists?[-\s]*to[-\s]*turnovers?(?:\s*ratio)?)\s*(?:of\s*)?(?:>=|>|above|over|at least|min)?\s*(\d+(?:\.\d+)?)/);
  if (astTo) criteria.minAstToTurnover = Number(astTo[1]);

  for (const [pattern, sortBy] of TRAIT_SORTS) {
    if (pattern.test(text)) {
      criteria.sortBy = sortBy;
      break;
    }
  }
  if (criteria.sortBy === 'three_pt_pct' && !hasValue(criteria.minThreeAttemptsPerGame)) {
    criteria.minThreeAttemptsPerGame = 2; // ignore 1-for-1 shooters when ranking by 3PT%
  }

  const top = text.match(/\b(?:top|best)\s+(\d{1,2})\b/);
  if (top) criteria.limit = Number(top[1]);

  const keywords = new Set(criteria.keywords || []);
  for (const trait of SOFT_TRAITS) if (new RegExp(`\\b${trait}\\b`).test(text)) keywords.add(trait);
  for (const quoted of text.match(/"([^"]+)"/g) || []) keywords.add(quoted.replace(/"/g, '').trim());
  if (keywords.size) criteria.keywords = [...keywords].filter(Boolean);

  return criteria;
}

function isNoPreferenceAnswer(message) {
  return /^(?:n\/a|na|none|skip|no preference|dont care|don't care|doesn't matter|anything|any is fine|not sure|unknown|no|nope|nah)$/.test(
    normalizeQuery(message)
  );
}

function applyDirectAnswerToQuestion(message, questionKey, criteria) {
  if (!questionKey) return false;
  const text = normalizeQuery(message);
  if (!text) return false;

  if (isNoPreferenceAnswer(message) || /^0(?:\.0+)?%?$/.test(text)) {
    delete criteria[questionKey];
    return true;
  }
  if (questionKey === 'position' || questionKey === 'nationality') {
    if (!criteria[questionKey]) criteria[questionKey] = normalizeEntity(text);
    return true;
  }
  if (questionKey === 'minHeightInches') {
    const parsed = parseHeightToInches(text);
    if (parsed !== null) criteria.minHeightInches = parsed;
    return parsed !== null;
  }
  const numeric = text.match(/(-?\d+(?:\.\d+)?)/);
  if (!numeric) return false;
  criteria[questionKey] = Number(numeric[1]);
  return true;
}

function evaluatePlayer(player, criteria) {
  const state = { pass: true, score: 0, reasons: [], missing: [], hasUnknown: false };
  const unknownMode = criteria.unknownDataMode || 'exclude';

  const allowUnknown = (label) => {
    state.missing.push(label);
    if (unknownMode === 'exclude') return false;
    if (unknownMode === 'separate') state.hasUnknown = true;
    return true;
  };

  const categories = [
    ['gender', player.gender, 8, (t, a) => a === t],
    ['league', player.league, 6, (t, a) => a === t],
    ['team', player.team, 6, (t, a) => a === t],
    ['handedness', player.handedness, 5, (t, a) => a === t],
    // "guard" matches "Point Guard"; "point guard" also matches a generic "Guard".
    ['position', player.position, 8, (t, a) => a.includes(t) || t.includes(a)],
    ['nationality', player.nationality, 4, (t, a) => a === t || a === COUNTRY_ALIASES[t]],
    ['playsInNationalTeam', player.playsInNationalTeam, 3, (t, a) => a === t]
  ];

  for (const [key, actualRaw, weight, matcher] of categories) {
    if (!hasValue(criteria[key])) continue;
    const actual = normalizeEntity(actualRaw);
    if (!actual) {
      if (!allowUnknown(key)) return { ...state, pass: false };
      continue;
    }
    if (!matcher(normalizeEntity(criteria[key]), actual)) return { ...state, pass: false };
    state.score += weight;
    state.reasons.push(`${key} match`);
  }

  const age = calculateAgeFromDob(player.dob);
  const thresholds = {
    ...THRESHOLDS,
    minAge: [null, 'age', 'min', 2],
    maxAge: [null, 'age', 'max', 2]
  };

  for (const [criteriaKey, [playerKey, label, direction, weight]] of Object.entries(thresholds)) {
    const threshold = criteria[criteriaKey];
    if (!hasValue(threshold)) continue;
    const value = playerKey ? player[playerKey] : age;
    if (!hasValue(value)) {
      if (!allowUnknown(label)) return { ...state, pass: false };
      continue;
    }
    const v = Number(value);
    const t = Number(threshold);
    if (direction === 'min' ? v < t : v > t) return { ...state, pass: false };
    const ratio = direction === 'min' ? (t > 0 ? v / t : 1) : t / Math.max(v, 0.1);
    state.score += weight * Math.min(ratio, 1.5);
    state.reasons.push(`${label} ${direction === 'min' ? '>=' : '<='} ${t}`);
  }

  if (hasValue(criteria.minAstToTurnover)) {
    const ast = player.assistsPerGame;
    const tov = player.turnoversPerGame;
    if (!hasValue(ast) || !hasValue(tov) || Number(tov) === 0) {
      if (!allowUnknown('A/T')) return { ...state, pass: false };
    } else {
      const ratio = Number(ast) / Number(tov);
      if (ratio < Number(criteria.minAstToTurnover)) return { ...state, pass: false };
      state.score += 4 * Math.min(ratio / Number(criteria.minAstToTurnover), 1.5);
      state.reasons.push(`A/T >= ${criteria.minAstToTurnover}`);
    }
  }

  if (hasValue(criteria.nameContains)) {
    const fullName = normalizeEntity(`${player.firstName} ${player.lastName}`);
    if (!fullName.includes(normalizeEntity(criteria.nameContains))) return { ...state, pass: false };
  }

  // Free-text traits only boost the score; seeded players have no scouting notes.
  if (Array.isArray(criteria.keywords) && criteria.keywords.length) {
    const blob = normalizeEntity(`${player.keywords || ''} ${player.notes || ''}`);
    const matched = criteria.keywords.filter((term) => blob.includes(normalizeEntity(term)));
    if (matched.length) {
      state.score += matched.length * 2;
      state.reasons.push(`traits: ${matched.join(', ')}`);
    }
  }

  return state;
}

function searchPlayers(players, criteria = {}) {
  const sort = SORT_FIELDS[criteria.sortBy];
  const limit = Math.min(Math.max(Number(criteria.limit) || 25, 1), 100);

  const evaluated = players
    .map((player) => {
      const result = evaluatePlayer(player, criteria);
      return {
        player: {
          ...player,
          fitScore: Math.round(result.score * 100) / 100,
          matchReasons: result.reasons,
          missingForCriteria: result.missing
        },
        pass: result.pass,
        unknown: result.hasUnknown
      };
    })
    .filter((entry) => entry.pass);

  const statOf = (entry, key) => (hasValue(entry.player[key]) ? Number(entry.player[key]) : null);
  evaluated.sort((a, b) => {
    if (sort) {
      const av = statOf(a, sort.key);
      const bv = statOf(b, sort.key);
      if (av === null || bv === null) return av === null ? (bv === null ? 0 : 1) : -1;
      if (av !== bv) return sort.ascending ? av - bv : bv - av;
    }
    return b.player.fitScore - a.player.fitScore || (statOf(b, 'pointsPerGame') || 0) - (statOf(a, 'pointsPerGame') || 0);
  });

  const separate = criteria.unknownDataMode === 'separate';
  const matches = evaluated.filter((e) => !separate || !e.unknown).map((e) => e.player);
  const separateMatches = separate ? evaluated.filter((e) => e.unknown).map((e) => e.player) : [];

  return {
    total: matches.length,
    matches: matches.slice(0, limit),
    separateMatches: separateMatches.slice(0, limit)
  };
}

const FOLLOW_UP_QUESTIONS = [
  { key: 'position', question: 'Which position should I prioritize (guard, forward, center)?' },
  { key: 'minPointsPerGame', question: 'Minimum points per game? (example: 15). Reply NA to skip.' },
  { key: 'minThreePtPercentage', question: 'Minimum 3PT%? (example: 38). Reply NA to skip.' },
  { key: 'minAssistsPerGame', question: 'Minimum assists per game? (example: 5). Reply NA to skip.' },
  { key: 'minHeightInches', question: "Minimum height? (example: 6'6 or 78 inches). Reply NA to skip." },
  { key: 'maxAge', question: 'Any age limit? (example: 24). Reply NA to skip.' }
];

// Picks the unanswered question that would split the current pool the most.
// Questions about fields no candidate has data for are skipped.
function determineQuestion(criteria, asked, pool) {
  const valuesFor = {
    position: pool.map((p) => normalizeEntity(p.position)).filter(Boolean),
    minPointsPerGame: pool.map((p) => p.pointsPerGame).filter(hasValue),
    minThreePtPercentage: pool.map((p) => p.threePtPercentage).filter(hasValue),
    minAssistsPerGame: pool.map((p) => p.assistsPerGame).filter(hasValue),
    minHeightInches: pool.map((p) => p.heightInches).filter(hasValue),
    maxAge: pool.map((p) => calculateAgeFromDob(p.dob)).filter(hasValue)
  };

  let best = null;
  for (const candidate of FOLLOW_UP_QUESTIONS) {
    if (asked.includes(candidate.key) || hasValue(criteria[candidate.key])) continue;
    const values = valuesFor[candidate.key];
    const impact = candidate.key === 'position' ? new Set(values).size * 4 : values.length ? values.length + Math.max(...values) - Math.min(...values) : 0;
    if (impact > 0 && (!best || impact > best.impact)) best = { ...candidate, impact };
  }
  return best;
}

const FOLLOW_UP_POOL_THRESHOLD = 12;
const MAX_FOLLOW_UPS = 2;

// One turn of the rule-based assistant. `session` is mutated in place.
function runRuleChat(session, { message = '', forceSearch = false }, players, teams) {
  const awaiting = session.awaitingQuestionKey;
  session.awaitingQuestionKey = null;
  session.criteria = parseCriteria(message, session.criteria, { teams });
  applyDirectAnswerToQuestion(message, awaiting, session.criteria);

  const force = Boolean(forceSearch || session.criteria._forceSearch);
  delete session.criteria._forceSearch;

  const pool = searchPlayers(players, { ...session.criteria, limit: 100 });
  const question =
    !force && session.askedQuestions.length < MAX_FOLLOW_UPS && pool.total > FOLLOW_UP_POOL_THRESHOLD
      ? determineQuestion(session.criteria, session.askedQuestions, pool.matches)
      : null;

  if (question) {
    session.askedQuestions.push(question.key);
    session.awaitingQuestionKey = question.key;
    return { done: false, engine: 'rules', question: question.question, criteria: session.criteria, candidatesSoFar: pool.total };
  }

  const result = searchPlayers(players, session.criteria);
  const criteriaUsed = session.criteria;
  session.criteria = {};
  session.askedQuestions = [];

  return {
    done: true,
    engine: 'rules',
    summary: `Found ${result.total} matching player(s)${result.total > result.matches.length ? `, showing the top ${result.matches.length}` : ''}.`,
    criteriaUsed,
    matches: result.matches,
    separateMatches: result.separateMatches
  };
}

module.exports = {
  SORT_FIELDS,
  THRESHOLDS,
  normalizeEntity,
  parseCriteria,
  parseHeightToInches,
  searchPlayers,
  runRuleChat,
  calculateAgeFromDob
};
