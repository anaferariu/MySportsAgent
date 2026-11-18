// Rule-based scouting search. parseCriteria() turns free text into a criteria
// object; searchPlayers() filters and ranks players against it. The engine is
// shared by all sports; each sport has a profile (below) with its positions,
// leagues, stat phrases, rankings and follow-up questions. The Claude agent
// (agent.js) builds the same basketball criteria through a tool call, so both
// engines share one filter implementation.

const NUM = '(\\d+(?:\\.\\d+)?)';
const AT_LEAST = '(?:at least|min(?:imum)?|over|above|more than|greater than|>=|>)';
const AT_MOST = '(?:at most|max(?:imum)?|under|below|less than|fewer than|no more than|<=|<)';
const OR_MORE = '(?:\\s*\\+|\\s*or\\s*(?:more|better|higher|above))?';

// ---------- shared helpers ----------

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

// Like matchMin/matchMax, but removes each matched phrase from the working text
// so a later, more general pattern ("yards") can't re-read a specific one
// ("1000 rushing yards"). Specific phrases must be read before general ones.
function phraseReader(text) {
  let t = ` ${text} `;
  const take = (match) => {
    if (!match) return null;
    t = t.replace(match[0], ' ');
    return Number(match[1]);
  };
  return {
    min(pattern) {
      if (new RegExp(`${AT_MOST}\\s*${NUM}\\s*%?\\s*(?:${pattern})(?![a-z])`).test(t)) return null;
      return (
        take(t.match(new RegExp(`(?:${AT_LEAST}\\s*)?${NUM}\\s*%?${OR_MORE}\\s*(?:${pattern})(?![a-z])`))) ??
        take(t.match(new RegExp(`\\b(?:${pattern})\\s*(?:per game\\s*)?(?:of\\s*)?(?:${AT_LEAST}\\s*)?${NUM}(?![a-z])`)))
      );
    },
    max(pattern) {
      return (
        take(t.match(new RegExp(`${AT_MOST}\\s*${NUM}\\s*%?\\s*(?:${pattern})(?![a-z])`))) ??
        take(t.match(new RegExp(`\\b(?:${pattern})\\s*(?:of\\s*)?${AT_MOST}\\s*${NUM}(?![a-z])`)))
      );
    },
    match(regex) {
      const m = t.match(regex);
      if (m) t = t.replace(m[0], ' ');
      return m;
    }
  };
}

// Season stats that are sums or ratios of stored ones (soccer and football).
const sumOf = (...values) => (values.some(hasValue) ? values.reduce((sum, v) => sum + (Number(v) || 0), 0) : null);
const ratioOf = (num, den, scale = 1, digits = 1) =>
  hasValue(num) && Number(den) > 0 ? Math.round((Number(num) / Number(den)) * scale * 10 ** digits) / 10 ** digits : null;

const DERIVED = {
  starts: (s) => (hasValue(s.apps) ? s.apps - (Number(s.subApps) || 0) : null),
  goalContributions: (s) => sumOf(s.goals, s.assists),
  goalsPerApp: (s) => ratioOf(s.goals, s.apps, 1, 2),
  scrimmageYds: (s) => sumOf(s.rushYds, s.recYds),
  totalYds: (s) => sumOf(s.passYds, s.rushYds, s.recYds),
  totalTd: (s) => sumOf(s.rushTd, s.recTd),
  completionPct: (s) => ratioOf(s.passCmp, s.passAtt, 100),
  yardsPerCarry: (s) => ratioOf(s.rushYds, s.rushAtt),
  fgPct: (s) => ratioOf(s.fgm, s.fga, 100)
};

// A player's value for a stat: derived, sport stats (JSON), or a top-level field
// (basketball stats, height, ...).
function metric(player, key) {
  const stats = player.stats || {};
  if (DERIVED[key]) return DERIVED[key](stats);
  if (hasValue(stats[key])) return stats[key];
  return hasValue(player[key]) ? player[key] : null;
}

// Threshold definition. `missing` says what an empty value means:
//   'unknown' - data we don't have (height, basketball stats): excluded and reported
//   'zero'    - a stat that simply never happened (no shots, no tackles): counts as 0
//   'exclude' - doesn't apply to this player (saves for an outfielder): left out quietly
const th = (metricKey, label, dir, weight, missing = 'unknown') => ({ metric: metricKey, label, dir, weight, missing });

const COMMON_FILTER_GROUPS = {
  position: ['position'],
  league: ['league'],
  team: ['team'],
  gender: ['gender'],
  age: ['minAge', 'maxAge'],
  nationality: ['nationality'],
  country: ['nationality'],
  height: ['minHeightInches']
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
  australia: 'australia', australian: 'australia',
  england: 'england', english: 'england',
  brazil: 'brazil', brazilian: 'brazil',
  netherlands: 'netherlands', dutch: 'netherlands',
  portugal: 'portugal', portuguese: 'portugal',
  argentina: 'argentina', argentinian: 'argentina', argentine: 'argentina',
  belgium: 'belgium', belgian: 'belgium',
  norway: 'norway', norwegian: 'norway',
  nigeria: 'nigeria', nigerian: 'nigeria',
  egypt: 'egypt', egyptian: 'egypt',
  japan: 'japan', japanese: 'japan',
  italy: 'italy', italian: 'italy',
  colombia: 'colombia', colombian: 'colombia'
};

const SOFT_TRAITS = [
  'long', 'athletic', 'quick', 'aggressive', 'switchable', 'high iq', 'high motor', 'catch and shoot', 'on ball', 'off ball'
];

// ---------- basketball ----------

const BASKETBALL = {
  thresholds: {
    minHeightInches: th('heightInches', 'height', 'min', 7),
    minGamesPlayed: th('gamesPlayed', 'GP', 'min', 1),
    minMinutesPerGame: th('minutesPerGame', 'MIN', 'min', 2),
    minPointsPerGame: th('pointsPerGame', 'PPG', 'min', 6),
    minReboundsPerGame: th('reboundsPerGame', 'RPG', 'min', 5),
    minAssistsPerGame: th('assistsPerGame', 'APG', 'min', 5),
    minStealsPerGame: th('stealsPerGame', 'SPG', 'min', 3),
    minBlocksPerGame: th('blocksPerGame', 'BPG', 'min', 3),
    maxTurnoversPerGame: th('turnoversPerGame', 'TOV', 'max', 4),
    minFgPercentage: th('fgPercentage', 'FG%', 'min', 5),
    minThreePtPercentage: th('threePtPercentage', '3PT%', 'min', 7),
    minThreeAttemptsPerGame: th('threeAttemptsPerGame', '3PA', 'min', 2),
    minFtPercentage: th('ftPercentage', 'FT%', 'min', 4),
    minVerticalInches: th('verticalInches', 'vertical', 'min', 4)
  },
  sortFields: {
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
  },
  tiebreak: 'pointsPerGame',
  traitSorts: [
    [/\b(?:scorers?|bucket getters?)\b/, 'points'],
    [/\b(?:shooters?|snipers?|marksm[ae]n)\b/, 'three_pt_pct'],
    [/\b(?:playmakers?|passers?|facilitators?)\b/, 'assists'],
    [/\b(?:rebounders?|glass cleaners?)\b/, 'rebounds'],
    [/\b(?:rim protectors?|shot blockers?)\b/, 'blocks'],
    [/\b(?:ball hawks?|defensive guards?|perimeter defenders?)\b/, 'steals'],
    [/\b(?:ball security|takes care of the ball|low turnovers?)\b/, 'turnovers']
  ],
  filterGroups: {
    points: ['minPointsPerGame'],
    scoring: ['minPointsPerGame'],
    rebounds: ['minReboundsPerGame'],
    assists: ['minAssistsPerGame'],
    steals: ['minStealsPerGame'],
    blocks: ['minBlocksPerGame'],
    turnovers: ['maxTurnoversPerGame'],
    three: ['minThreePtPercentage', 'minThreeAttemptsPerGame'],
    '3pt': ['minThreePtPercentage', 'minThreeAttemptsPerGame'],
    '3 pt': ['minThreePtPercentage', 'minThreeAttemptsPerGame'],
    games: ['minGamesPlayed'],
    minutes: ['minMinutesPerGame']
  },
  positions: [
    [/\bpoint guards?\b/, 'point guard'],
    [/\bshooting guards?\b/, 'shooting guard'],
    [/\bsmall forwards?\b/, 'small forward'],
    [/\bpower forwards?\b/, 'power forward'],
    [/\b(?:centers?|centres?|bigs?|big m[ae]n)\b/, 'center'],
    [/\bguards?\b/, 'guard'],
    [/\b(?:forwards?|wings?)\b/, 'forward']
  ],
  leagues(text, criteria) {
    if (/\bwnba\b/.test(text)) Object.assign(criteria, { league: 'WNBA', gender: 'female' });
    else if (/\bnba\b/.test(text)) Object.assign(criteria, { league: 'NBA', gender: 'male' });
  },
  parseStats(text, criteria) {
    if (/left\s*-?\s*hand(?:ed)?|lefty|southpaw/.test(text)) criteria.handedness = 'left';
    else if (/right\s*-?\s*hand(?:ed)?/.test(text)) criteria.handedness = 'right';
    else if (/ambidextrous/.test(text)) criteria.handedness = 'ambidextrous';

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

    const astTo = text.match(/(?:a\/t|assists?[-\s]*to[-\s]*turnovers?(?:\s*ratio)?)\s*(?:of\s*)?(?:>=|>|above|over|at least|min)?\s*(\d+(?:\.\d+)?)/);
    if (astTo) criteria.minAstToTurnover = Number(astTo[1]);
  },
  // Ranking by a percentage needs a minimum volume, or 1-for-1 shooters top the list.
  sortGuards: { three_pt_pct: ['minThreeAttemptsPerGame', 2] },
  filterGuards: {},
  questionOrder: 'impact',
  questions: [
    { key: 'position', question: 'Which position should I prioritize (guard, forward, center)?' },
    { key: 'minPointsPerGame', metric: 'pointsPerGame', question: 'Minimum points per game? (example: 15). Reply NA to skip.' },
    { key: 'minThreePtPercentage', metric: 'threePtPercentage', question: 'Minimum 3PT%? (example: 38). Reply NA to skip.' },
    { key: 'minAssistsPerGame', metric: 'assistsPerGame', question: 'Minimum assists per game? (example: 5). Reply NA to skip.' },
    { key: 'minHeightInches', metric: 'heightInches', question: "Minimum height? (example: 6'6 or 78 inches). Reply NA to skip." },
    { key: 'maxAge', metric: 'age', question: 'Any age limit? (example: 24). Reply NA to skip.' }
  ]
};

// ---------- soccer ----------

const SOCCER = {
  thresholds: {
    minHeightInches: th('heightInches', 'height', 'min', 7),
    minApps: th('apps', 'APP', 'min', 2, 'zero'),
    minStarts: th('starts', 'starts', 'min', 2, 'zero'),
    minGoals: th('goals', 'goals', 'min', 6, 'zero'),
    minAssists: th('assists', 'assists', 'min', 5, 'zero'),
    minGoalContributions: th('goalContributions', 'G+A', 'min', 6, 'zero'),
    minGoalsPerApp: th('goalsPerApp', 'goals/app', 'min', 5, 'exclude'),
    minShots: th('shots', 'shots', 'min', 3, 'zero'),
    minShotsOnTarget: th('shotsOnTarget', 'shots on target', 'min', 3, 'zero'),
    maxYellowCards: th('yellowCards', 'yellow cards', 'max', 2, 'zero'),
    maxRedCards: th('redCards', 'red cards', 'max', 2, 'zero'),
    maxFoulsCommitted: th('foulsCommitted', 'fouls', 'max', 2, 'zero'),
    minSaves: th('saves', 'saves', 'min', 5, 'exclude'),
    maxGoalsAgainst: th('goalsAgainst', 'goals conceded', 'max', 5, 'exclude')
  },
  sortFields: {
    goals: { key: 'goals', label: 'goals' },
    assists: { key: 'assists', label: 'assists' },
    contributions: { key: 'goalContributions', label: 'goals + assists' },
    goals_per_app: { key: 'goalsPerApp', label: 'goals per appearance' },
    saves: { key: 'saves', label: 'saves' },
    shots: { key: 'shots', label: 'shots' },
    apps: { key: 'apps', label: 'appearances' },
    discipline: { key: 'yellowCards', label: 'fewest yellow cards', ascending: true }
  },
  tiebreak: 'goalContributions',
  traitSorts: [
    [/\bmost goal contributions\b|\bmost g\s*\+\s*a\b|\bmost goals and assists\b/, 'contributions'],
    [/\b(?:goal ?scorers?|scorers?|finishers?|poachers?|most goals)\b/, 'goals'],
    [/\b(?:creators?|playmakers?|providers?|assisters?|most assists)\b/, 'assists'],
    [/\b(?:shot[- ]?stoppers?|most saves)\b/, 'saves'],
    [/\b(?:most shots|volume shooters?)\b/, 'shots'],
    [/\b(?:disciplined|clean records?|fewest (?:yellow )?cards)\b/, 'discipline'],
    [/\b(?:most appearances|ever[- ]?presents?)\b/, 'apps']
  ],
  filterGroups: {
    goals: ['minGoals', 'minGoalsPerApp'],
    assists: ['minAssists'],
    contributions: ['minGoalContributions'],
    appearances: ['minApps'],
    apps: ['minApps'],
    games: ['minApps'],
    starts: ['minStarts'],
    shots: ['minShots', 'minShotsOnTarget'],
    cards: ['maxYellowCards', 'maxRedCards'],
    fouls: ['maxFoulsCommitted'],
    saves: ['minSaves'],
    conceded: ['maxGoalsAgainst']
  },
  positions: [
    [/\b(?:goal ?keepers?|keepers?|gks?|goalies?)\b/, 'goalkeeper'],
    [/\b(?:defenders?|cent(?:er|re)[- ]?backs?|full[- ]?backs?|wing[- ]?backs?|cbs?)\b/, 'defender'],
    [/\b(?:midfielders?|mids?)\b/, 'midfielder'],
    [/\b(?:forwards?|strikers?|wingers?|attackers?)\b/, 'forward']
  ],
  leagues(text, criteria) {
    if (/\bnwsl\b/.test(text)) Object.assign(criteria, { league: 'NWSL', gender: 'female' });
    else if (/\b(?:premier league|epl|prem)\b/.test(text)) Object.assign(criteria, { league: 'Premier League', gender: 'male' });
  },
  parseStats(text, criteria) {
    const r = phraseReader(text);
    const noCards = r.match(/\bno (red|yellow) cards?\b/);
    if (noCards) criteria[noCards[1] === 'red' ? 'maxRedCards' : 'maxYellowCards'] = 0;

    const set = (key, value) => {
      if (value !== null && value !== undefined) criteria[key] = value;
    };
    set('minGoalContributions', r.min('goal contributions?|g\\s*\\+\\s*a|goals? (?:and|\\+|plus) assists(?: combined)?'));
    const perGame = r.match(new RegExp(`(?:${AT_LEAST}\\s*)?${NUM}\\s*\\+?\\s*goals?\\s*(?:per|a|each)\\s*(?:game|match|appearance|90)`));
    if (perGame) criteria.minGoalsPerApp = Number(perGame[1]);
    const concededPhrase = r.match(/\bconceded\s*(?:fewer than|under|less than|at most|no more than)\s*(\d+)/);
    if (concededPhrase) criteria.maxGoalsAgainst = Number(concededPhrase[1]);
    set('maxGoalsAgainst', r.max('goals? (?:against|conceded)|conceded'));
    set('minGoals', r.min('goals?'));
    set('minAssists', r.min('assists?'));
    set('minShotsOnTarget', r.min('shots? on target|sot'));
    set('minShots', r.min('shots?'));
    set('minStarts', r.min('starts'));
    set('minApps', r.min('appearances|apps|games(?: played)?|matches'));
    set('minSaves', r.min('saves'));
    set('maxYellowCards', r.max('yellow(?: cards?)?|yellows|bookings'));
    set('maxRedCards', r.max('red cards?'));
    set('maxFoulsCommitted', r.max('fouls(?: committed)?'));
  },
  sortGuards: { goals_per_app: ['minApps', 5] },
  filterGuards: { minGoalsPerApp: ['minApps', 5] },
  questionOrder: 'listed',
  questions: [
    { key: 'position', question: 'Which position: goalkeeper, defender, midfielder or forward? Reply NA to skip.' },
    { key: 'minGoals', metric: 'goals', question: 'Minimum goals this season? (example: 5). Reply NA to skip.', when: (c) => !isPosition(c, 'goalkeeper') },
    { key: 'minAssists', metric: 'assists', question: 'Minimum assists? (example: 3). Reply NA to skip.', when: (c) => !isPosition(c, 'goalkeeper') },
    { key: 'minSaves', metric: 'saves', question: 'Minimum saves? (example: 40). Reply NA to skip.', when: (c) => isPosition(c, 'goalkeeper') },
    { key: 'minApps', metric: 'apps', question: 'Minimum appearances? (example: 15). Reply NA to skip.' }
  ]
};

// ---------- American football ----------

const OFFENSE_SKILL = ['running back', 'fullback', 'wide receiver', 'tight end'];
const DEFENSE = ['defensive end', 'defensive tackle', 'linebacker', 'cornerback', 'safety'];

const FOOTBALL = {
  thresholds: {
    minHeightInches: th('heightInches', 'height', 'min', 7),
    minGamesPlayed: th('gamesPlayed', 'GP', 'min', 1, 'zero'),
    minPassYds: th('passYds', 'passing yds', 'min', 6, 'zero'),
    minPassTd: th('passTd', 'passing TD', 'min', 5, 'zero'),
    minPassAtt: th('passAtt', 'pass attempts', 'min', 1, 'zero'),
    maxPassInt: th('passInt', 'INT thrown', 'max', 4, 'exclude'),
    minCompletionPct: th('completionPct', 'completion%', 'min', 5, 'exclude'),
    minRushYds: th('rushYds', 'rushing yds', 'min', 6, 'zero'),
    minRushTd: th('rushTd', 'rushing TD', 'min', 5, 'zero'),
    minRushAtt: th('rushAtt', 'carries', 'min', 2, 'zero'),
    minYardsPerCarry: th('yardsPerCarry', 'yds/carry', 'min', 4, 'exclude'),
    minRec: th('rec', 'receptions', 'min', 5, 'zero'),
    minTargets: th('targets', 'targets', 'min', 2, 'zero'),
    minRecYds: th('recYds', 'receiving yds', 'min', 6, 'zero'),
    minRecTd: th('recTd', 'receiving TD', 'min', 5, 'zero'),
    minScrimmageYds: th('scrimmageYds', 'scrimmage yds', 'min', 6, 'zero'),
    minTotalTd: th('totalTd', 'rush+rec TD', 'min', 5, 'zero'),
    minTackles: th('tackles', 'tackles', 'min', 6, 'zero'),
    minSacks: th('sacks', 'sacks', 'min', 6, 'zero'),
    minForcedFumbles: th('forcedFumbles', 'forced fumbles', 'min', 3, 'zero'),
    minDefInt: th('defInt', 'interceptions', 'min', 5, 'zero'),
    minPassesDefended: th('passesDefended', 'passes defended', 'min', 4, 'zero'),
    minFgm: th('fgm', 'FG made', 'min', 4, 'zero'),
    minFga: th('fga', 'FG attempts', 'min', 1, 'zero'),
    minFgPct: th('fgPct', 'FG%', 'min', 5, 'exclude')
  },
  sortFields: {
    total_yards: { key: 'totalYds', label: 'total yards' },
    pass_yds: { key: 'passYds', label: 'passing yards' },
    pass_td: { key: 'passTd', label: 'passing TD' },
    completion_pct: { key: 'completionPct', label: 'completion %' },
    rush_yds: { key: 'rushYds', label: 'rushing yards' },
    rec_yds: { key: 'recYds', label: 'receiving yards' },
    scrimmage_yds: { key: 'scrimmageYds', label: 'scrimmage yards' },
    total_td: { key: 'totalTd', label: 'rushing + receiving TD' },
    tackles: { key: 'tackles', label: 'tackles' },
    sacks: { key: 'sacks', label: 'sacks' },
    interceptions: { key: 'defInt', label: 'interceptions' },
    fg_pct: { key: 'fgPct', label: 'FG%' }
  },
  tiebreak: 'totalYds',
  traitSorts: [
    [/\b(?:pass rushers?|edge rushers?|sack (?:artists?|leaders?|masters?)|most sacks)\b/, 'sacks'],
    [/\b(?:reliable kickers?|accurate kickers?|most accurate kickers?)\b/, 'fg_pct'],
    [/\b(?:accurate (?:passers?|quarterbacks?|qbs?)|most accurate)\b/, 'completion_pct'],
    [/\b(?:passers?|gunslingers?|most passing yards)\b/, 'pass_yds'],
    [/\b(?:rushers?|ball ?carriers?|workhorses?|bell ?cows?|most rushing yards)\b/, 'rush_yds'],
    [/\b(?:pass ?catchers?|deep threats?|most receiving yards)\b/, 'rec_yds'],
    [/\b(?:tacklers?|most tackles)\b/, 'tackles'],
    [/\b(?:ball ?hawks?|most interceptions)\b/, 'interceptions'],
    [/\b(?:touchdown makers?|scorers?|red ?zone threats?|most touchdowns)\b/, 'total_td'],
    [/\b(?:playmakers?|most yards)\b/, 'total_yards']
  ],
  filterGroups: {
    games: ['minGamesPlayed'],
    passing: ['minPassYds', 'minPassTd', 'minPassAtt', 'maxPassInt', 'minCompletionPct'],
    rushing: ['minRushYds', 'minRushTd', 'minRushAtt', 'minYardsPerCarry'],
    receiving: ['minRec', 'minTargets', 'minRecYds', 'minRecTd'],
    yards: ['minPassYds', 'minRushYds', 'minRecYds', 'minScrimmageYds', 'minYardsPerCarry'],
    touchdowns: ['minPassTd', 'minRushTd', 'minRecTd', 'minTotalTd'],
    tackles: ['minTackles'],
    sacks: ['minSacks'],
    interceptions: ['minDefInt', 'maxPassInt'],
    kicking: ['minFgm', 'minFga', 'minFgPct']
  },
  positions: [
    [/\b(?:quarterbacks?|qbs?)\b/, 'quarterback'],
    [/\b(?:running backs?|rbs?|halfbacks?|tailbacks?)\b/, 'running back'],
    [/\b(?:fullbacks?|fbs?)\b/, 'fullback'],
    [/\b(?:wide receivers?|wrs?|receivers?|wideouts?)\b/, 'wide receiver'],
    [/\b(?:tight ends?|tes?)\b/, 'tight end'],
    [/\b(?:offensive (?:line(?:m[ae]n)?|tackles?)|o-?line(?:m[ae]n)?|ol)\b/, ['offensive tackle', 'guard', 'center']],
    [/\b(?:defensive line(?:m[ae]n)?|d-?line(?:m[ae]n)?|dl)\b/, ['defensive end', 'defensive tackle']],
    [/\b(?:defensive ends?|des?)\b/, 'defensive end'],
    [/\b(?:edges?|edge rushers?)\b/, ['defensive end', 'linebacker']],
    [/\b(?:defensive tackles?|dts?|nose tackles?)\b/, 'defensive tackle'],
    [/\b(?:linebackers?|lbs?)\b/, 'linebacker'],
    [/\b(?:defensive backs?|dbs?|secondary)\b/, ['cornerback', 'safety']],
    [/\b(?:cornerbacks?|corners?|cbs?)\b/, 'cornerback'],
    [/\b(?:safety|safeties)\b/, 'safety'],
    [/\b(?:kickers?|place ?kickers?|pks?)\b/, 'kicker'],
    [/\bpunters?\b/, 'punter'],
    [/\blong snappers?\b/, 'long snapper']
  ],
  leagues(text, criteria) {
    if (/\bnfl\b/.test(text)) Object.assign(criteria, { league: 'NFL', gender: 'male' });
  },
  parseStats(text, criteria) {
    const r = phraseReader(text);
    const set = (key, value) => {
      if (value !== null && value !== undefined) criteria[key] = value;
    };
    const qb = isPosition(criteria, 'quarterback');

    // Most specific phrases first: each read removes its words from the text.
    set('minYardsPerCarry', r.min('yards per (?:carry|rush|attempt)|ypc'));
    // Percentages written number-first: "70% completion", "85% on field goals".
    const pctFirst = (words) => r.match(new RegExp(`(?:${AT_LEAST}\\s*)?${NUM}\\s*%\\s*\\+?\\s*(?:on\\s+|from\\s+|of\\s+)?(?:${words})(?![a-z])`));
    const completionPct = pctFirst('completions?|comp|(?:their |his )?passes');
    if (completionPct) criteria.minCompletionPct = Number(completionPct[1]);
    const fgPctFirst = pctFirst('field goals?|fgs?|kicks');
    if (fgPctFirst) criteria.minFgPct = Number(fgPctFirst[1]);
    set('minCompletionPct', r.min('completion (?:percentage|pct|rate|%)|comp(?:letion)?\\s*%'));
    set('minFgPct', r.min('field goal (?:percentage|pct|%)|fg\\s*%'));
    set('minPassYds', r.min('passing yards|passing yds|pass(?:ing)? yds|yards passing|pass yards|yards through the air'));
    set('minRushYds', r.min('rushing yards|rushing yds|rush(?:ing)? yds|yards rushing|rush yards'));
    set('minRecYds', r.min('receiving yards|receiving yds|rec(?:eiving)? yds|yards receiving|rec yards'));
    set('minScrimmageYds', r.min('scrimmage yards|yards from scrimmage|total yards|all[- ]purpose yards|yards of offense'));
    set('minPassTd', r.min('passing (?:touchdowns|tds?)|pass(?:ing)? tds?|td passes|touchdown passes'));
    set('minRushTd', r.min('rushing (?:touchdowns|tds?)|rush(?:ing)? tds?'));
    set('minRecTd', r.min('receiving (?:touchdowns|tds?)|rec(?:eiving)? tds?|touchdown catches|td catches'));
    set('maxPassInt', r.max('interceptions? thrown|ints? thrown|picks? thrown|interceptions|ints|picks'));
    set('minDefInt', r.min('interceptions|ints?|picks'));
    // Generic "yards" / "touchdowns": passing for quarterbacks, otherwise rushing + receiving.
    set(qb ? 'minPassYds' : 'minScrimmageYds', r.min('yards|yds'));
    set(qb ? 'minPassTd' : 'minTotalTd', r.min('touchdowns|tds?'));
    set('minRushAtt', r.min('carries|rushes|rushing attempts|rush attempts'));
    set('minRec', r.min('receptions|catches|rec'));
    set('minTargets', r.min('targets'));
    set('minTackles', r.min('tackles|tkls?'));
    set('minSacks', r.min('sacks?'));
    set('minForcedFumbles', r.min('forced fumbles?|ff'));
    set('minPassesDefended', r.min('passes defended|pass(?:es)? deflect(?:ed|ions)|pass breakups|pbus?|pds?'));
    set('minFgm', r.min('field goals?(?: made)?|fgs?(?: made)?|fgm'));
    set('minGamesPlayed', r.min('games(?: played)?|gp'));
  },
  sortGuards: { completion_pct: ['minPassAtt', 100], fg_pct: ['minFga', 10] },
  filterGuards: { minCompletionPct: ['minPassAtt', 100], minFgPct: ['minFga', 10], minYardsPerCarry: ['minRushAtt', 50] },
  questionOrder: 'listed',
  questions: [
    { key: 'position', question: 'Which position? (e.g. quarterback, running back, wide receiver, linebacker, cornerback). Reply NA to skip.' },
    { key: 'minPassYds', metric: 'passYds', question: 'Minimum passing yards? (example: 3000). Reply NA to skip.', when: (c) => isPosition(c, 'quarterback') },
    {
      key: 'minScrimmageYds',
      metric: 'scrimmageYds',
      question: 'Minimum yards from scrimmage (rushing + receiving)? (example: 500). Reply NA to skip.',
      when: (c) => OFFENSE_SKILL.some((p) => isPosition(c, p))
    },
    { key: 'minTackles', metric: 'tackles', question: 'Minimum tackles? (example: 50). Reply NA to skip.', when: (c) => DEFENSE.some((p) => isPosition(c, p)) }
  ]
};

const PROFILES = { basketball: BASKETBALL, soccer: SOCCER, football: FOOTBALL };
const profileFor = (sport) => PROFILES[sport] || BASKETBALL;

function isPosition(criteria, position) {
  return [].concat(criteria.position || []).some((p) => normalizeEntity(p) === position);
}

// ---------- parsing ----------

function parseCriteria(message, previousCriteria = {}, context = {}) {
  const profile = profileFor(context.sport);
  const text = normalizeQuery(message);
  const criteria = { ...previousCriteria };
  const teams = context.teams || [];

  if (/\b(?:show results|search now|run search|find them|that'?s all|go ahead)\b/.test(text)) {
    criteria._forceSearch = true;
  }

  // "any league", "no age limit", "remove the team filter": drop a filter from the running search.
  const groups = { ...COMMON_FILTER_GROUPS, ...profile.filterGroups };
  const words = Object.keys(groups).sort((a, b) => b.length - a.length);
  const removable = new RegExp(`\\b(?:any|no|remove|clear|drop|without)\\s+(?:the\\s+)?(${words.join('|')})\\b`, 'g');
  for (const [, field] of text.matchAll(removable)) {
    for (const key of groups[field] || []) delete criteria[key];
  }

  if (/\b(?:female|women'?s?|woman|girls?|ladies)\b/.test(text)) criteria.gender = 'female';
  else if (/\b(?:male|men'?s?|boys?)\b/.test(text)) criteria.gender = 'male';
  profile.leagues(text, criteria);

  for (const team of teams) {
    const names = [team.team, ...(team.aliases || [])].map(normalizeEntity);
    if (names.some((name) => new RegExp(`\\b${name}\\b`).test(normalizeEntity(text)))) {
      criteria.team = team.team;
      break;
    }
  }

  if (/exclude unknown|only complete|complete data only|no missing/.test(text)) criteria.unknownDataMode = 'exclude';
  if (/include unknown|allow missing|missing is ok/.test(text)) criteria.unknownDataMode = 'include';
  if (/show unknown separately|separate unknown|split unknown/.test(text)) criteria.unknownDataMode = 'separate';

  if (/national team/.test(text)) {
    if (/\b(?:not|no|never|exclude)\b[^.]*national team/.test(text)) criteria.playsInNationalTeam = 'no';
    else criteria.playsInNationalTeam = 'yes';
  }

  for (const [pattern, position] of profile.positions) {
    if (pattern.test(text)) {
      criteria.position = position;
      break;
    }
  }

  for (const [alias, country] of Object.entries(COUNTRY_ALIASES)) {
    // "English Premier League" names a league, not a nationality.
    if (new RegExp(`\\b${alias}\\b(?! premier)`).test(text)) {
      criteria.nationality = country;
      break;
    }
  }

  const height = text.match(/(\d)\s*(?:'|ft|feet)\s*(\d{1,2})?\s*(?:"|in)?\s*(?:\+|or taller|and up|or above)?/);
  if (height) criteria.minHeightInches = Number(height[1]) * 12 + Number(height[2] || 0);

  profile.parseStats(text, criteria);

  const ageBetween = text.match(/between\s+(\d{1,2})\s*(?:and|-)\s*(\d{1,2})\s*(?:years?|yrs?|yo)/);
  if (ageBetween) {
    criteria.minAge = Number(ageBetween[1]);
    criteria.maxAge = Number(ageBetween[2]);
  }
  // "older/younger than N" is unambiguous; bare "over/under N" needs "years" so
  // it isn't confused with a stat. Strict comparisons are converted to inclusive ages.
  const maxAge =
    text.match(/\b(?:younger than|under the age of|age\s*(?:under|below|<))\s*(\d{1,2})\b/) ||
    text.match(/\bunder\s*(\d{1,2})\s*(?:years?|yrs?|yo)\b/);
  if (maxAge) criteria.maxAge = Number(maxAge[1]) - 1;
  const maxAgeInclusive = text.match(/\bat most\s*(\d{1,2})\s*(?:years?|yrs?|yo)\b|\bmax(?:imum)? age(?: of)?\s*(\d{1,2})\b/);
  if (maxAgeInclusive) criteria.maxAge = Number(maxAgeInclusive[1] || maxAgeInclusive[2]);
  const minAge =
    text.match(/\b(?:older than|over the age of|age\s*(?:over|above|>))\s*(\d{1,2})\b/) ||
    text.match(/\bover\s*(\d{1,2})\s*(?:years?|yrs?|yo)\b/);
  if (minAge) criteria.minAge = Number(minAge[1]) + 1;
  const minAgeInclusive = text.match(/\bat least\s*(\d{1,2})\s*(?:years?|yrs?|yo)\b|\baged?\s*(\d{1,2})\s*\+|\bmin(?:imum)? age(?: of)?\s*(\d{1,2})\b/);
  if (minAgeInclusive) criteria.minAge = Number(minAgeInclusive[1] || minAgeInclusive[2] || minAgeInclusive[3]);

  for (const [pattern, sortBy] of profile.traitSorts) {
    if (pattern.test(text)) {
      criteria.sortBy = sortBy;
      break;
    }
  }
  // Quarterbacks score through the air: rank them by passing TDs, not rushing + receiving.
  if (criteria.sortBy === 'total_td' && isPosition(criteria, 'quarterback')) criteria.sortBy = 'pass_td';
  // Ratios need a minimum volume, or a 3-for-3 backup tops the list.
  const guard = (profile.sortGuards || {})[criteria.sortBy];
  if (guard && !hasValue(criteria[guard[0]])) criteria[guard[0]] = guard[1];
  for (const [filterKey, [volumeKey, minimum]] of Object.entries(profile.filterGuards || {})) {
    if (hasValue(criteria[filterKey]) && !hasValue(criteria[volumeKey])) criteria[volumeKey] = minimum;
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

// ---------- matching and ranking ----------

function evaluatePlayer(player, criteria, profile) {
  const state = { pass: true, score: 0, reasons: [], missing: [], hasUnknown: false };
  const unknownMode = criteria.unknownDataMode || 'exclude';

  const allowUnknown = (label) => {
    state.missing.push(label);
    if (unknownMode === 'exclude') return false;
    if (unknownMode === 'separate') state.hasUnknown = true;
    return true;
  };

  // "guard" matches "Point Guard"; "point guard" also matches a generic "Guard".
  // A position can also be a group, e.g. defensive backs = cornerback or safety.
  const positionMatches = (target, actual) =>
    [].concat(target).some((t) => {
      const want = normalizeEntity(t);
      return actual.includes(want) || want.includes(actual);
    });

  const categories = [
    ['gender', player.gender, 8, (t, a) => a === normalizeEntity(t)],
    ['league', player.league, 6, (t, a) => a === normalizeEntity(t)],
    ['team', player.team, 6, (t, a) => a === normalizeEntity(t)],
    ['handedness', player.handedness, 5, (t, a) => a === normalizeEntity(t)],
    ['position', player.position, 8, positionMatches],
    ['nationality', player.nationality, 4, (t, a) => a === normalizeEntity(t) || a === COUNTRY_ALIASES[normalizeEntity(t)]],
    ['playsInNationalTeam', player.playsInNationalTeam, 3, (t, a) => a === normalizeEntity(t)]
  ];

  for (const [key, actualRaw, weight, matcher] of categories) {
    if (!hasValue(criteria[key])) continue;
    const actual = normalizeEntity(actualRaw);
    if (!actual) {
      if (!allowUnknown(key)) return { ...state, pass: false };
      continue;
    }
    if (!matcher(criteria[key], actual)) return { ...state, pass: false };
    state.score += weight;
    state.reasons.push(`${key} match`);
  }

  const thresholds = {
    ...profile.thresholds,
    minAge: th('age', 'age', 'min', 2),
    maxAge: th('age', 'age', 'max', 2)
  };

  for (const [criteriaKey, def] of Object.entries(thresholds)) {
    const threshold = criteria[criteriaKey];
    if (!hasValue(threshold)) continue;
    let value = def.metric === 'age' ? calculateAgeFromDob(player.dob) : metric(player, def.metric);
    if (!hasValue(value)) {
      if (def.missing === 'zero') value = 0;
      else if (def.missing === 'exclude') return { ...state, pass: false };
      else if (!allowUnknown(def.label)) return { ...state, pass: false };
      else continue;
    }
    const v = Number(value);
    const t = Number(threshold);
    if (def.dir === 'min' ? v < t : v > t) return { ...state, pass: false };
    const ratio = def.dir === 'min' ? (t > 0 ? v / t : 1) : t / Math.max(v, 0.1);
    state.score += def.weight * Math.min(ratio, 1.5);
    state.reasons.push(`${def.label} ${def.dir === 'min' ? '>=' : '<='} ${t}`);
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

function searchPlayers(players, criteria = {}, sport = 'basketball') {
  const profile = profileFor(sport);
  const sort = profile.sortFields[criteria.sortBy];
  const limit = Math.min(Math.max(Number(criteria.limit) || 25, 1), 100);
  // Players dropped only because a filtered field is empty (e.g. no birth date), by field.
  const excludedForMissing = {};

  const evaluated = players
    .map((player) => {
      const result = evaluatePlayer(player, criteria, profile);
      if (!result.pass && result.missing.length && (criteria.unknownDataMode || 'exclude') === 'exclude') {
        const field = result.missing[result.missing.length - 1];
        excludedForMissing[field] = (excludedForMissing[field] || 0) + 1;
      }
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

  const statOf = (entry, key) => {
    const value = metric(entry.player, key);
    return hasValue(value) ? Number(value) : null;
  };
  evaluated.sort((a, b) => {
    if (sort) {
      const av = statOf(a, sort.key);
      const bv = statOf(b, sort.key);
      if (av === null || bv === null) {
        if (av !== bv) return av === null ? 1 : -1;
      } else if (av !== bv) {
        return sort.ascending ? av - bv : bv - av;
      }
    }
    return b.player.fitScore - a.player.fitScore || (statOf(b, profile.tiebreak) || 0) - (statOf(a, profile.tiebreak) || 0);
  });

  const separate = criteria.unknownDataMode === 'separate';
  const matches = evaluated.filter((e) => !separate || !e.unknown).map((e) => e.player);
  const separateMatches = separate ? evaluated.filter((e) => e.unknown).map((e) => e.player) : [];

  return {
    total: matches.length,
    matches: matches.slice(0, limit),
    separateMatches: separateMatches.slice(0, limit),
    excludedForMissing
  };
}

// ---------- summaries and follow-up questions ----------

function formatHeight(inches) {
  const feet = Math.floor(inches / 12);
  return `${feet}'${Math.round(inches - feet * 12)}"`;
}

// Human-readable list of the active filters, e.g. "male · PPG ≥ 15 · 3PT% ≥ 35".
function describeCriteria(criteria, sport = 'basketball') {
  const profile = profileFor(sport);
  const parts = [];
  if (criteria.gender) parts.push(criteria.gender);
  if (criteria.league) parts.push(criteria.league);
  if (criteria.team) parts.push(criteria.team);
  if (criteria.position) parts.push([].concat(criteria.position).join('/'));
  if (criteria.nationality) parts.push(`nationality: ${criteria.nationality}`);
  if (criteria.handedness) parts.push(sport === 'soccer' ? `${criteria.handedness}-footed` : `${criteria.handedness}-handed`);
  if (criteria.playsInNationalTeam) parts.push(`national team: ${criteria.playsInNationalTeam}`);

  for (const [key, def] of Object.entries(profile.thresholds)) {
    if (!hasValue(criteria[key])) continue;
    const isPct = def.label.endsWith('%');
    const value = key === 'minHeightInches' ? formatHeight(criteria[key]) : `${criteria[key]}${isPct ? '%' : ''}`;
    parts.push(`${def.label} ${def.dir === 'min' ? '≥' : '≤'} ${value}`);
  }

  if (hasValue(criteria.minAge) && hasValue(criteria.maxAge)) parts.push(`age ${criteria.minAge}–${criteria.maxAge}`);
  else if (hasValue(criteria.minAge)) parts.push(`age ≥ ${criteria.minAge}`);
  else if (hasValue(criteria.maxAge)) parts.push(`age ≤ ${criteria.maxAge}`);
  if (hasValue(criteria.minAstToTurnover)) parts.push(`A/T ≥ ${criteria.minAstToTurnover}`);
  if (Array.isArray(criteria.keywords) && criteria.keywords.length) parts.push(`traits: ${criteria.keywords.join(', ')}`);
  if (profile.sortFields[criteria.sortBy]) parts.push(`ranked by ${profile.sortFields[criteria.sortBy].label}`);
  if (hasValue(criteria.limit)) parts.push(`top ${criteria.limit}`);
  return parts.join(' · ');
}

const MISSING_FIELD_NAMES = { playsInNationalTeam: 'national team info', vertical: 'vertical jump', 'A/T': 'assist/turnover data' };

function missingDataNote(excludedForMissing) {
  return Object.entries(excludedForMissing)
    .map(([field, count]) => `${count} player(s) have no ${MISSING_FIELD_NAMES[field] || field} on record and were left out.`)
    .join(' ');
}

// Picks the next follow-up question. Basketball asks whichever would split the
// pool the most; soccer and football go through their list in order. Questions
// about fields no candidate has data for are skipped.
function determineQuestion(criteria, asked, pool, profile) {
  let best = null;
  for (const candidate of profile.questions) {
    if (asked.includes(candidate.key) || hasValue(criteria[candidate.key])) continue;
    if (candidate.when && !candidate.when(criteria)) continue;
    const values =
      candidate.key === 'position'
        ? pool.map((p) => normalizeEntity(p.position)).filter(Boolean)
        : pool.map((p) => (candidate.metric === 'age' ? calculateAgeFromDob(p.dob) : metric(p, candidate.metric))).filter(hasValue);
    const impact =
      candidate.key === 'position'
        ? new Set(values).size > 1 ? new Set(values).size * 4 : 0
        : values.length ? values.length + Math.max(...values) - Math.min(...values) : 0;
    if (impact <= 0) continue;
    if (profile.questionOrder === 'listed') return candidate;
    if (!best || impact > best.impact) best = { ...candidate, impact };
  }
  return best;
}

const FOLLOW_UP_POOL_THRESHOLD = 12;
const MAX_FOLLOW_UPS = 2;

function resetRuleSession(session) {
  session.criteria = {};
  session.askedQuestions = [];
  session.awaitingQuestionKey = null;
}

const RESET_PATTERN = /^(?:new search|start over|reset|clear(?: all)?(?: filters)?)$/;

// One turn of the rule-based assistant. `session` is mutated in place. Filters
// accumulate across turns so each message refines the same search; only an
// explicit reset (the Done button, or "start over") clears them.
function runRuleChat(session, { message = '', forceSearch = false }, players, teams, sport = 'basketball') {
  const profile = profileFor(sport);
  if (RESET_PATTERN.test(normalizeQuery(message))) {
    resetRuleSession(session);
    return { done: true, engine: 'rules', reset: true, summary: 'Filters cleared. Describe the player you are looking for.', matches: null, separateMatches: [] };
  }

  const awaiting = session.awaitingQuestionKey;
  session.awaitingQuestionKey = null;
  const before = JSON.stringify(session.criteria);
  session.criteria = parseCriteria(message, session.criteria, { teams, sport });
  const force = Boolean(forceSearch || session.criteria._forceSearch);
  delete session.criteria._forceSearch;

  // Treat the message as the answer to a pending question only if it didn't set
  // filters of its own; "8 rebounds" after "Minimum 3PT%?" is a new filter, not 8%.
  if (JSON.stringify(session.criteria) === before) applyDirectAnswerToQuestion(message, awaiting, session.criteria);

  const pool = searchPlayers(players, { ...session.criteria, limit: 100 }, sport);
  // A ranking request ("top 5 scorers", "best pass rusher") is answered right away.
  const wantsRanking = Boolean(session.criteria.sortBy) || hasValue(session.criteria.limit);
  const question =
    !force && !wantsRanking && session.askedQuestions.length < MAX_FOLLOW_UPS && pool.total > FOLLOW_UP_POOL_THRESHOLD
      ? determineQuestion(session.criteria, session.askedQuestions, pool.matches, profile)
      : null;

  if (question) {
    session.askedQuestions.push(question.key);
    session.awaitingQuestionKey = question.key;
    return { done: false, engine: 'rules', question: question.question, criteria: session.criteria, candidatesSoFar: pool.total };
  }

  const result = searchPlayers(players, session.criteria, sport);
  const filters = describeCriteria(session.criteria, sport);
  const summary = [
    `Found ${result.total} matching player(s)${result.total > result.matches.length ? `, showing the top ${result.matches.length}` : ''}.`,
    filters ? `Filters: ${filters}.` : 'No filters yet: showing everyone.',
    missingDataNote(result.excludedForMissing)
  ]
    .filter(Boolean)
    .join(' ');

  return {
    done: true,
    engine: 'rules',
    summary,
    criteriaUsed: { ...session.criteria },
    matches: result.matches,
    separateMatches: result.separateMatches
  };
}

// Kept for the Claude agent, which searches basketball only.
const SORT_FIELDS = BASKETBALL.sortFields;

module.exports = {
  SORT_FIELDS,
  normalizeEntity,
  parseCriteria,
  parseHeightToInches,
  searchPlayers,
  describeCriteria,
  runRuleChat,
  resetRuleSession,
  calculateAgeFromDob,
  metric
};
