# Amer_Schedule

**Amer OS** is an agentic weekly planner for a student-founder's week: classes, startup work (Belay), gym, career prep (LeetCode, interview prep, applications), meals, and protected free time.

The planner lays out the week. Claude handles the judgment calls. Nothing changes until you approve it.

It runs in two ways from the same code:

- **As a Claude artifact** — the page uses Claude's own database and Claude model. No server to run.
- **As a web app** — `server/` serves the page, stores everything in SQLite, and runs the nightly jobs. This is the version you deploy to a URL.

## How it works

You own the inputs, and the planner builds the week from them.

| You tell it | Examples |
| --- | --- |
| **Weekly schedule**: things that repeat and never move | Lectures, TA lab sections, ITS shifts, club meetings |
| **One-off events** | Midterms, a meeting with a cofounder, an interview |
| **Tasks** with a time estimate and a due date | "Apply to 3 internships, 90 min, due Fri" |
| **Goals**: sessions per week | Lift 4×75 min, LeetCode 5×45 min, Belay deep work 5×2 h |
| **Rules** in plain English | "No LeetCode after 10pm. Saturday night is free." |

When you press **Plan**, the planner fills free time in a fixed order, so the important things get placed first:

1. **Fixed items**: weekly schedule and one-off events
2. **Meals**: each one placed inside its time window
3. **Protected goals**: marked "protect", such as deep work, lifting and free time
4. **Tasks**: earliest due date first, split into blocks of 2 hours or less and spread across days
5. **Everything else**: the remaining goals, wherever time is left

Anything that doesn't fit is listed under "didn't fit" instead of being quietly dropped.

The planner is **deterministic**: the same inputs always produce the same week, and `tests/api.test.mjs` checks that no two blocks ever overlap. Claude never places time blocks. When you type "my midterm moved to Thursday," Claude proposes changes to your *inputs* (add an event, add a prep task, trim a goal). You tick the ones you want, and the planner re-lays out the week. Same idea as Belay: the model proposes, deterministic code checks, a human approves.

## Run it

```bash
npm install
cp .env.example .env          # the defaults are fine to start
npm start                     # builds, then serves on http://localhost:3000
```

The first visit asks you to create an account (email and a password of at least
10 characters). That account owns the planner, and signup closes behind it
unless you set `SIGNUP_OPEN=true`. Sessions are cookies; passwords are hashed
with scrypt.

Other ways to run the same code:

```bash
npm run dev                   # same, restarting when a server file changes
npm run build                 # then open app/preview.html directly (browser-only, no server)
```

Opened as a plain file, the page saves to that one browser and Ask Claude is off. Published as a Claude artifact, it saves to your Claude account.

## Settings

All optional except the access key. See `.env.example`.

| Variable | What it does |
| --- | --- |
| `API_TOKEN` | Optional key for scripts and uptime checks. It acts as the first account. |
| `SIGNUP_OPEN` | `true` allows more than one account. |
| `PUBLIC_URL` | The app's public address, used for the Google OAuth redirect. |
| `NODE_ENV` | `production` marks session cookies Secure (HTTPS only). |
| `VAPID_*` | Web push keys from `npm run keys:push`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Calendar sync. |
| `DB_FILE` | Where the SQLite file lives (default `data/amer.db`). |
| `DATABASE_URL` | A hosted Postgres connection string. Set it and the app uses Postgres instead of SQLite. |
| `PORT` | Default 3000. |
| `TZ` | Your timezone, so 7am means 7am. Hosts usually default to UTC. |
| `ANTHROPIC_API_KEY` | Turns on Ask Claude and lets Claude write the briefs. |
| `ANTHROPIC_MODEL` | Override the model (default `claude-sonnet-4-5`). |
| `JOBS` | `off` skips the scheduled jobs. |

## The API

Everything except `/api/health` and `/api/auth/*` needs a session cookie, or
`Authorization: Bearer <API_TOKEN>` if you set one.

| Route | What it does |
| --- | --- |
| `GET /` | The planner page, pointed at this API |
| `GET /api/health` | Is the server up, and which features are switched on |
| `POST /api/auth/signup` / `login` / `logout` | Accounts and sessions |
| `GET /api/auth/me` | Who is signed in |
| `GET /api/state` | Everything: config, goals, commitments, events, tasks, plans, briefs |
| `PUT /api/:collection/:id` | Create or replace one document |
| `DELETE /api/:collection/:id` | Remove one document |
| `POST /api/plan` | Lay out a week and save it: `{"weekStart": "2026-09-21"}` |
| `POST /api/ask` | Relay a prompt to Claude: `{"prompt": "..."}` |
| `POST /api/push/subscribe` | Register this browser for notifications |
| `POST /api/push/test` | Send yourself one now |
| `GET /api/gcal/connect` | Start the Google Calendar sign-in |
| `POST /api/gcal/sync` | Write one week into the "Amer OS" calendar |

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:3000/api/state   # needs API_TOKEN set
curl -X POST -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d '{"weekStart":"2026-09-21"}' http://localhost:3000/api/plan
```

## Scheduled jobs

`server/jobs.mjs` runs two jobs in the server's timezone:

- **Sunday 20:00** — plans next week and saves a summary
- **Weekdays 07:00** — writes a morning brief for the day

Both appear in the Ask Claude panel, and both send a notification to any browser
you registered. Without an Anthropic key the text is assembled from the plan;
with a key, Claude writes it.

## Notifications on your phone

```bash
npm run keys:push     # prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
```

Put those three lines in `.env` (and in your host's settings), restart, then open
the planner and press **Notify me on this device**. Browsers only allow push over
HTTPS, so this works on your deployed URL and on localhost, but not over plain
http on a LAN address. On an iPhone, add the page to your home screen first;
Safari only allows notifications for installed web apps.

## Google Calendar

1. In `console.cloud.google.com`: create a project, enable the **Google Calendar API**.
2. Credentials → **OAuth client ID** → Web application. Add the redirect URI
   `<PUBLIC_URL>/api/gcal/callback`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PUBLIC_URL`, restart, then
   press **Connect Google Calendar** in the planner.

Sync writes to a calendar of its own named "Amer OS", never to your main calendar.
Re-syncing a week replaces the events it created for that week, and blocks you have
already ticked off are skipped.

## Project layout

```
src/shared/engine.js  the planner itself: pure functions, no DOM, no database
src/page.html         HTML + CSS shell (the script is injected at /*__JS__*/)
src/js/01-core.js     app state, DOM helpers, storage (API / Claude artifact / browser)
src/js/02-page-engine.js  thin wrappers that hand page state to the shared engine
src/js/03-render.js   week grid, phone agenda, today list, weekly targets
src/js/04-editors.js  tabs and forms for tasks, events, weekly schedule, goals, rules
src/js/05-agent.js    Ask Claude: prompt, validation of the suggestions, apply + replan
src/js/06-account.js  sign-in overlay, notifications, calendar buttons
src/js/07-boot.js     starts the app
src/static/           service worker, web app manifest, icons (copied into app/)
scripts/build.mjs     bundles the page and re-exports the engine as app/engine.mjs
server/index.mjs      Express app: auth, API routes, serves the page
server/db.mjs         SQLite storage (one table of JSON documents) + store picker
server/db-postgres.mjs  the same store on Postgres, for hosts with no disk
server/plan.mjs       plan a week from the database and save it
server/jobs.mjs       the scheduled jobs
server/ask.mjs        calls to the Anthropic API
server/auth.mjs       accounts, scrypt passwords, session cookies
server/push.mjs       web push subscriptions and sending
server/gcal.mjs       Google Calendar OAuth and week sync
seed/example.json     example data for tests and first runs
tests/api.test.mjs    backend test (in-memory database, no network)
tests/smoke.mjs       browser test, including the page against the real API
```

The engine is written once and used three ways: inlined into the page by the build, imported by the server as `app/engine.mjs`, and called directly by the tests. That is why `scripts/build.mjs` appends an export list to it.

## Test it

```bash
npx playwright install chromium   # first time only
npm test                          # API test, then the browser test
npm run test:api                  # just the backend, no browser needed
DATABASE_URL=postgres://... npm run test:api   # the same checks against Postgres
```

## Deploy it

The app stores everything in one place, and where that place lives is the only real deployment decision.

**With a hosted Postgres (works on any host, including free ones).** Create a database
(Neon, Supabase, Render, Railway), copy its connection string, and set `DATABASE_URL`
on the web service. Nothing on the host's disk has to survive.

**With a disk.** Leave `DATABASE_URL` unset, mount a disk, and point `DB_FILE` at it
(the Dockerfile already uses `/data/amer.db`). Simpler, but the host has to offer a
persistent disk, which usually means a paid instance.

Either way: push this repo to GitHub, create a web service pointing at it, and set
`API_TOKEN`, `TZ`, and optionally `ANTHROPIC_API_KEY`. Hosts that build from the
Dockerfile need no other settings; hosts that run Node directly use
build `npm install && npm run build` and start `node server/index.mjs`.

One catch on free plans: the service sleeps when idle, so the 7am brief only runs if
something wakes it. A free uptime pinger (UptimeRobot, cron-job.org) hitting
`/api/health` every few minutes fixes that.

## Ideas for next steps

- Drag blocks to move them
- Pull class times straight from the university timetable
- A weekly review: planned vs. done, per goal
- Two-way calendar sync, so events added in Google become fixed blocks here
