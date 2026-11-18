# MySportsAgent

A scouting prototype for basketball, soccer and American football. It holds season stats for 375 players on 13 teams and lets you search them in plain English, for example *"guard with at least 20 points per game"*, *"NWSL midfielder with 5+ assists"* or *"running back with 1000 rushing yards"*.

Search runs on a rule-based (regex) parser by default. Optionally, a Claude agent can handle the requests instead.

## What's in the database

Regular-season statistics from ESPN's public team pages.

**Basketball**: per-game averages for 91 players (games, minutes, points, rebounds, assists, steals, blocks, turnovers, FG/3PT/FT made, attempted and percentage).

| Team | League | Season | Source |
|---|---|---|---|
| Oklahoma City Thunder | NBA | 2024-25 | [ESPN](https://www.espn.com/nba/team/stats/_/name/okc/season/2025/seasontype/2) |
| Indiana Pacers | NBA | 2024-25 | [ESPN](https://www.espn.com/nba/team/stats/_/name/ind/season/2025/seasontype/2) |
| Boston Celtics | NBA | 2024-25 | [ESPN](https://www.espn.com/nba/team/stats/_/name/bos/season/2025/seasontype/2) |
| Las Vegas Aces | WNBA | 2025 | [ESPN](https://www.espn.com/wnba/team/stats/_/name/lv/season/2025/seasontype/2) |
| Phoenix Mercury | WNBA | 2025 | [ESPN](https://www.espn.com/wnba/team/stats/_/name/phx/season/2025/seasontype/2) |

**Soccer**: league season totals for the 125 players who appeared (appearances, substitute appearances, goals, assists, shots, shots on target, fouls committed and suffered, yellow and red cards; saves and goals conceded for goalkeepers), plus nationality.

| Team | League | Season | Source |
|---|---|---|---|
| Liverpool | Premier League | 2024-25 | [ESPN](https://www.espn.com/soccer/team/squad/_/id/364/league/ENG.1/season/2024) |
| Arsenal | Premier League | 2024-25 | [ESPN](https://www.espn.com/soccer/team/squad/_/id/359/league/ENG.1/season/2024) |
| Manchester City | Premier League | 2024-25 | [ESPN](https://www.espn.com/soccer/team/squad/_/id/382/league/ENG.1/season/2024) |
| Gotham FC | NWSL | 2025 | [ESPN](https://www.espn.com/soccer/team/squad/_/id/15364/league/USA.NWSL/season/2025) |
| Washington Spirit | NWSL | 2025 | [ESPN](https://www.espn.com/soccer/team/squad/_/id/15365/league/USA.NWSL/season/2025) |

**American football**: regular-season totals for 159 players (games; passing completions, attempts, yards, touchdowns and interceptions; rushing carries, yards and touchdowns; receptions, targets, receiving yards and touchdowns; tackles, sacks, forced fumbles, interceptions and passes defended; field goals and extra points).

| Team | League | Season | Source |
|---|---|---|---|
| Philadelphia Eagles | NFL | 2024 | [ESPN](https://www.espn.com/nfl/team/stats/_/name/phi/season/2024/seasontype/2) |
| Kansas City Chiefs | NFL | 2024 | [ESPN](https://www.espn.com/nfl/team/stats/_/name/kc/season/2024/seasontype/2) |
| Buffalo Bills | NFL | 2024 | [ESPN](https://www.espn.com/nfl/team/stats/_/name/buf/season/2024/seasontype/2) |

The Chiefs file lists the 27 defenders with the most tackles; a few reserves with only a handful of tackles are not included.

Seeded players have no height, age or scouting notes (soccer players include nationality). You can add players with those fields through the app.

The seed files are plain CSVs in [`data/seed/`](data/seed/) and are listed in [`data/seed/teams.json`](data/seed/teams.json) with their sport. To add a team, drop in another CSV with the same columns as the other teams of that sport and add an entry to `teams.json`.

## Features

- **Scout assistant**: one tab per sport. Ask in plain English and get a ranked table of matching players; each message narrows the same search, and each tab keeps its own conversation.
- **Player database**: one tab per sport, each with that sport's stat columns, plus a text filter.
- **ScoutBoard**: pick a sport (Basketball, Soccer or American Football), then fill in a form with that sport's positions and stats. The database is capped at 500 players in total (`MAX_PLAYERS`). Highlight-video uploads are switched off on the public demo; set `ALLOW_VIDEO_UPLOADS=true` to enable them.
- **Adding a sport or a stat**: sports, positions and stats are defined in one place, [`server/sports.js`](server/sports.js). The ScoutBoard forms and database tables are generated from it.
- **Boxscore upload** (basketball): upload a game boxscore (xlsx/csv). Each row is folded into that player's season averages; shooting percentages are recomputed from makes and attempts. Try [`data/samples/wnba-finals-2025-game4.csv`](data/samples/wnba-finals-2025-game4.csv).

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. There is no login: the app is meant to be a public demo. To change settings, copy `.env.example` to `.env` and start with `node --env-file=.env server/index.js`.

The SQLite database (`data/players.db`) is created on first start from the seed files. Delete it to reset.

Run the tests with `npm test`.

## Search engines

### Rule-based (default)

[`server/search.js`](server/search.js) parses the request with regular expressions into a set of filters, for example:

```
"guard with at least 20 points per game"           ->  { position: "guard", minPointsPerGame: 20 }
"forward with at least 10 goals"                   ->  { position: "forward", minGoals: 10 }
"quarterback with 25 passing TDs and under 10 INT" ->  { position: "quarterback", minPassTd: 25, maxPassInt: 10 }
"top 3 scorers"                                    ->  { sortBy: "points", limit: 3 }
```

It then filters and ranks players. Filters build up over the conversation ("only Celtics", "at least 20 appearances"); a new value replaces the old one, "any position" / "any team" / "no age limit" drops a filter, and **Done** (or typing "start over") clears everything. If a request is broad (more than 12 matches), it asks up to two follow-up questions; reply `NA` to skip one. Ranking requests ("top 5", "best pass rusher") are answered right away.

One engine serves all three sports; each sport has a profile with its positions, leagues, stat phrases, rankings and follow-up questions. What each understands:

- **Basketball**: positions, men's/women's, NBA/WNBA, team names, points/rebounds/assists/steals/blocks per game, max turnovers, FG/3PT/FT %, games, minutes, height, age, assist-to-turnover ratio, "top N", and traits such as *scorer*, *shooter*, *playmaker*, *rebounder* or *rim protector*, which rank by the matching stat.
- **Soccer**: goalkeeper/defender/midfielder/forward (and *striker*, *winger*, *centre-back*, *keeper*…), Premier League/NWSL, team names, nationality ("English midfielder"), goals, assists, goal contributions (G+A), goals per appearance, appearances, starts, shots, shots on target, max yellow/red cards ("no red cards"), max fouls, saves and goals conceded; rankings such as *top scorers*, *creators*, *shot-stoppers* or *most appearances*.
- **American football**: positions and groups (*defensive backs*, *defensive line*, *edge*, *offensive line*), NFL, team names, passing yards/TDs/attempts, interceptions thrown (max) or made (min), completion %, rushing yards/TDs/carries, yards per carry, receptions, targets, receiving yards/TDs, scrimmage yards, total TDs, tackles, sacks, forced fumbles, passes defended, field goals and FG %. A bare "yards" or "touchdowns" means passing for quarterbacks and rushing + receiving for everyone else. Rankings include *best pass rusher* (sacks), *passer*, *rusher*, *tackler*, *ball hawk* and *most accurate quarterback*.

"Most X" rankings list only players with some X (the best pass rusher list only includes players with a sack), while "fewest X" rankings such as fewest yellow cards keep zeros, which rank first.

Ratio filters and rankings come with a minimum volume so tiny samples don't dominate: 2 three-point attempts per game for 3PT%, 5 appearances for goals per appearance, 100 pass attempts for completion %, 50 carries for yards per carry and 10 field-goal attempts for FG %. The summary shows these as filters, so they can be changed.

In soccer and football an empty stat means it didn't happen (a defender with no shots has no shots row), so it counts as 0. Stats that only apply to some players, such as saves or completion %, quietly leave out everyone else.

### Claude agent (optional)

If you have your own Anthropic API key, set both of these to use it (no key is included in this repo):

```bash
SEARCH_ENGINE=agent
ANTHROPIC_API_KEY=<your-anthropic-api-key>
```

With only one of them set, the app stays on the rule-based search. If an agent request fails, that answer falls back to the rule-based search. The agent works in all three sport tabs, with a separate conversation per tab.

The app has no login, so with the agent on, every visitor's search is billed to your API key. Set a monthly spend limit in the Anthropic Console before enabling it on a public deployment.

The agent ([`server/agent.js`](server/agent.js)) uses `claude-opus-5-5` (override with `ANTHROPIC_MODEL`). It does not receive the database. It gets:

- a system prompt for the selected sport, listing its teams, positions and which fields exist,
- the conversation so far in that tab, so follow-ups like "only Celtics" refine the last request,
- three tools: `search_players`, `get_player` and `list_teams`. The `search_players` filters, positions and rankings are generated from that sport's search profile, so the agent has exactly the filters the rule-based search understands (e.g. `min_goals` for soccer, `min_rush_yds` and `max_pass_int` for football) and the same minimum-volume rules.

Claude turns the request into filters and explains the results; the result table comes directly from the search, not from the model's text. Only what the tools return (names, teams, stats and any traits or notes you entered) is sent to the API.

## Deploy on Render

[`render.yaml`](render.yaml) is a Render Blueprint: in Render, choose **New → Blueprint** and select this repository. It uses the free plan and keeps `SEARCH_ENGINE=rules`.

The free plan has no persistent disk, so the database is rebuilt from the seed files on every deploy or restart. Players and boxscores that visitors add, and uploaded videos, are temporary; anything that should last belongs in `data/seed/`. For persistence, use a paid plan with a disk mounted and point `DATA_DIR` at it.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SEARCH_ENGINE` | `rules` | `rules` or `agent` |
| `ANTHROPIC_API_KEY` | | Needed for `SEARCH_ENGINE=agent` |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model for the agent |
| `MAX_PLAYERS` | `500` | Maximum players in the database; adding more is refused |
| `ALLOW_VIDEO_UPLOADS` | `false` | `true` lets visitors attach highlight videos |
| `DATA_DIR` | `./data` | Where the database and uploads live |
| `PORT` | `3000` | HTTP port |

## Project layout

```
server/
  index.js    Express app and routes
  sports.js   Sports, positions and stats (drives the forms and tables)
  db.js       SQLite schema, seeding, boxscore merge
  search.js   Rule-based parser and the shared filter/ranking engine, with one profile per sport
  agent.js    Optional Claude agent (tool use over search.js)
client/       Static HTML/CSS/JS frontend
data/seed/    Team CSVs for all three sports + teams.json (committed)
data/samples/ Example boxscore for the upload feature
test/         node:test suites (agent tests use a mocked SDK, no API key needed)
```

## Data note

Statistics are factual season figures from ESPN's public team pages, included for demonstration. No personal data beyond names, teams, nationality (soccer) and on-field statistics is stored for seeded players.
