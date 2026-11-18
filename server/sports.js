// Sport definitions: positions, profile fields and stats for each sport. The
// server uses them to store and seed players; the client builds the ScoutBoard
// forms and Player Database tables from them (served at /api/sports).
//
// Basketball stats live in their own database columns (the search engine uses
// them). Soccer and football stats are stored in the players.stats JSON column.
// `csv` names the seed-file column; `table: false` hides a stat from the table.
// `defaultSort` is a stat key, or a list of keys whose values are summed.

const SPORTS = {
  basketball: {
    label: 'Basketball',
    icon: '🏀',
    description: 'Per-game averages: points, rebounds, assists, shooting',
    tableNote: 'Season averages per game. Sorted by points.',
    defaultSort: 'pointsPerGame',
    examples: { team: 'e.g. CB Gran Canaria', league: 'e.g. Liga ACB', keywords: 'e.g. long guard, quick, aggressive on defense' },
    positions: ['Point Guard', 'Shooting Guard', 'Guard', 'Small Forward', 'Power Forward', 'Forward', 'Center'],
    handedness: { label: 'Handedness', options: [['left', 'Left'], ['right', 'Right'], ['ambidextrous', 'Ambidextrous']] },
    nationalTeam: true,
    statGroups: [
      {
        title: 'Season averages (per game)',
        stats: [
          { key: 'gamesPlayed', label: 'Games Played', short: 'GP', step: 1, max: 200 },
          { key: 'minutesPerGame', label: 'Minutes', short: 'MIN', max: 60 },
          { key: 'pointsPerGame', label: 'Points', short: 'PPG', max: 80 },
          { key: 'reboundsPerGame', label: 'Rebounds', short: 'RPG', max: 30 },
          { key: 'assistsPerGame', label: 'Assists', short: 'APG', max: 30 },
          { key: 'stealsPerGame', label: 'Steals', short: 'SPG', max: 10 },
          { key: 'blocksPerGame', label: 'Blocks', short: 'BPG', max: 10 },
          { key: 'turnoversPerGame', label: 'Turnovers', short: 'TOV', max: 15 },
          { key: 'fgPercentage', label: 'FG%', short: 'FG%', max: 100 },
          { key: 'threePtPercentage', label: '3PT%', short: '3PT%', max: 100 },
          { key: 'threeAttemptsPerGame', label: '3PT attempts', short: '3PA', max: 20 },
          { key: 'ftPercentage', label: 'FT%', short: 'FT%', max: 100 },
          { key: 'verticalInches', label: 'Vertical (inches)', short: 'Vert', max: 80, table: false }
        ]
      }
    ]
  },

  soccer: {
    label: 'Soccer',
    icon: '⚽',
    description: 'Season totals: appearances, goals, assists, shots, cards, saves',
    tableNote: 'League season totals. Sorted by goals.',
    defaultSort: 'goals',
    examples: { team: 'e.g. Ajax', league: 'e.g. Eredivisie', keywords: 'e.g. box-to-box, strong in the air, quick' },
    positions: ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'],
    handedness: { label: 'Preferred foot', options: [['left', 'Left'], ['right', 'Right'], ['both', 'Both']] },
    nationalTeam: true,
    statGroups: [
      {
        title: 'Season totals',
        stats: [
          { key: 'apps', csv: 'apps', label: 'Appearances', short: 'APP', step: 1 },
          { key: 'subApps', csv: 'sub_apps', label: 'Sub appearances', short: 'SUB', step: 1 },
          { key: 'goals', csv: 'goals', label: 'Goals', short: 'G', step: 1 },
          { key: 'assists', csv: 'assists', label: 'Assists', short: 'A', step: 1 },
          { key: 'shots', csv: 'shots', label: 'Shots', short: 'SH', step: 1 },
          { key: 'shotsOnTarget', csv: 'shots_on_target', label: 'Shots on target', short: 'SOT', step: 1 },
          { key: 'foulsCommitted', csv: 'fouls_committed', label: 'Fouls committed', short: 'FC', step: 1 },
          { key: 'foulsSuffered', csv: 'fouls_suffered', label: 'Fouls suffered', short: 'FS', step: 1 },
          { key: 'yellowCards', csv: 'yellow_cards', label: 'Yellow cards', short: 'YC', step: 1 },
          { key: 'redCards', csv: 'red_cards', label: 'Red cards', short: 'RC', step: 1 }
        ]
      },
      {
        title: 'Goalkeeping',
        stats: [
          { key: 'saves', csv: 'saves', label: 'Saves', short: 'SV', step: 1 },
          { key: 'goalsAgainst', csv: 'goals_against', label: 'Goals conceded', short: 'GA', step: 1 }
        ]
      }
    ]
  },

  football: {
    label: 'American Football',
    icon: '🏈',
    description: 'Season totals: passing, rushing, receiving, defense, kicking',
    tableNote: 'Regular-season totals. Sorted by total yards (passing + rushing + receiving).',
    defaultSort: ['passYds', 'rushYds', 'recYds'], // summed

    examples: { team: 'e.g. Ohio State Buckeyes', league: 'e.g. NCAA FBS', keywords: 'e.g. pocket passer, physical, good hands' },
    positions: [
      'Quarterback', 'Running Back', 'Fullback', 'Wide Receiver', 'Tight End', 'Offensive Tackle', 'Guard', 'Center',
      'Defensive End', 'Defensive Tackle', 'Linebacker', 'Cornerback', 'Safety', 'Kicker', 'Punter', 'Long Snapper'
    ],
    handedness: null,
    nationalTeam: false,
    statGroups: [
      { title: 'Season', stats: [{ key: 'gamesPlayed', csv: 'gp', label: 'Games Played', short: 'GP', step: 1 }] },
      {
        title: 'Passing',
        stats: [
          { key: 'passCmp', csv: 'pass_cmp', label: 'Completions', short: 'CMP', step: 1 },
          { key: 'passAtt', csv: 'pass_att', label: 'Attempts', short: 'ATT', step: 1 },
          { key: 'passYds', csv: 'pass_yds', label: 'Passing yards', short: 'PASS YDS', step: 1, min: -100 },
          { key: 'passTd', csv: 'pass_td', label: 'Passing TDs', short: 'PASS TD', step: 1 },
          { key: 'passInt', csv: 'pass_int', label: 'Interceptions thrown', short: 'INT THR', step: 1 }
        ]
      },
      {
        title: 'Rushing',
        stats: [
          { key: 'rushAtt', csv: 'rush_att', label: 'Carries', short: 'CAR', step: 1 },
          { key: 'rushYds', csv: 'rush_yds', label: 'Rushing yards', short: 'RUSH YDS', step: 1, min: -100 },
          { key: 'rushTd', csv: 'rush_td', label: 'Rushing TDs', short: 'RUSH TD', step: 1 }
        ]
      },
      {
        title: 'Receiving',
        stats: [
          { key: 'rec', csv: 'rec', label: 'Receptions', short: 'REC', step: 1 },
          { key: 'targets', csv: 'targets', label: 'Targets', short: 'TGT', step: 1 },
          { key: 'recYds', csv: 'rec_yds', label: 'Receiving yards', short: 'REC YDS', step: 1, min: -100 },
          { key: 'recTd', csv: 'rec_td', label: 'Receiving TDs', short: 'REC TD', step: 1 }
        ]
      },
      {
        title: 'Defense',
        stats: [
          { key: 'tackles', csv: 'tackles', label: 'Total tackles', short: 'TKL', step: 1 },
          { key: 'soloTackles', csv: 'solo_tackles', label: 'Solo tackles', short: 'SOLO', step: 1 },
          { key: 'sacks', csv: 'sacks', label: 'Sacks', short: 'SACK', step: 0.5 },
          { key: 'forcedFumbles', csv: 'forced_fumbles', label: 'Forced fumbles', short: 'FF', step: 1 },
          { key: 'defInt', csv: 'def_int', label: 'Interceptions', short: 'INT', step: 1 },
          { key: 'passesDefended', csv: 'passes_defended', label: 'Passes defended', short: 'PD', step: 1 }
        ]
      },
      {
        title: 'Kicking',
        stats: [
          { key: 'fgm', csv: 'fgm', label: 'Field goals made', short: 'FGM', step: 1 },
          { key: 'fga', csv: 'fga', label: 'Field goal attempts', short: 'FGA', step: 1 },
          { key: 'xpm', csv: 'xpm', label: 'Extra points made', short: 'XPM', step: 1 },
          { key: 'xpa', csv: 'xpa', label: 'Extra point attempts', short: 'XPA', step: 1 }
        ]
      }
    ]
  }
};

const SPORT_IDS = Object.keys(SPORTS);

// ESPN position abbreviations used in the seed files -> full position names.
const POSITION_CODES = {
  soccer: { G: 'Goalkeeper', D: 'Defender', M: 'Midfielder', F: 'Forward' },
  football: {
    QB: 'Quarterback', RB: 'Running Back', FB: 'Fullback', WR: 'Wide Receiver', TE: 'Tight End',
    OT: 'Offensive Tackle', G: 'Guard', C: 'Center', DE: 'Defensive End', DT: 'Defensive Tackle',
    LB: 'Linebacker', CB: 'Cornerback', S: 'Safety', K: 'Kicker', PK: 'Kicker', P: 'Punter', LS: 'Long Snapper'
  }
};

function statDefs(sport) {
  return SPORTS[sport].statGroups.flatMap((group) => group.stats);
}

module.exports = { SPORTS, SPORT_IDS, POSITION_CODES, statDefs };
