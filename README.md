# MySportsAgent

A scouting prototype for basketball, soccer and American football. It holds season stats for 375 players on 13 teams and lets you search the basketball players in plain English, for example *"guard with at least 20 points per game"* or *"WNBA forward with 8 rebounds and at least 20 games"*.

Search runs on a rule-based (regex) parser by default. Optionally, a Claude agent can handle the requests instead. Search covers basketball for now; soccer and football players can be browsed and added.

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

- **Scout assistant**: ask in plain English and get a ranked table of matching basketball players.
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
"guard with at least 20 points per game"  ->  { position: "guard", minPointsPerGame: 20 }
"top 3 scorers"                           ->  { sortBy: "points", limit: 3 }
"celtics center"                          ->  { team: "Boston Celtics", position: "center" }
```

It then filters and ranks players. If a request is broad (more than 12 matches), it asks up to two follow-up questions; reply `NA` to skip one, or click **Done** to search right away.

Understood: positions, men's/women's, NBA/WNBA, team names, points/rebounds/assists/steals/blocks per game, max turnovers, FG/3PT/FT %, games, minutes, height, age, assist-to-turnover ratio, "top N", and traits such as *scorer*, *shooter*, *playmaker*, *rebounder* or *rim protector*, which rank by the matching stat.

### Claude agent (optional)

If you have your own Anthropic API key, set both of these to use it (no key is included in this repo):

```bash
SEARCH_ENGINE=agent
ANTHROPIC_API_KEY=<your-anthropic-api-key>
```

With only one of them set, the app stays on the rule-based search. If an agent request fails, that answer falls back to the rule-based search.

The app has no login, so with the agent on, every visitor's search is billed to your API key. Set a monthly spend limit in the Anthropic Console before enabling it on a public deployment.

The agent ([`server/agent.js`](server/agent.js)) uses `claude-opus-5-5` (override with `ANTHROPIC_MODEL`). It does not receive the database. It gets:

- a system prompt listing the teams and which fields exist,
- the conversation so far, so follow-ups like "only Celtics" refine the last request,
- three tools: `search_players` (structured filters, run by the same engine as the rule-based search), `get_player` and `list_teams`.

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
  search.js   Rule-based parser and the shared filter/ranking engine (basketball)
  agent.js    Optional Claude agent (tool use over search.js)
client/       Static HTML/CSS/JS frontend
data/seed/    Team CSVs for all three sports + teams.json (committed)
data/samples/ Example boxscore for the upload feature
test/         node:test suites (agent tests use a mocked SDK, no API key needed)
```

## Data note

Statistics are factual season figures from ESPN's public team pages, included for demonstration. No personal data beyond names, teams, nationality (soccer) and on-field statistics is stored for seeded players.
