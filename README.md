# TaskFlow

A small multi-tenant SaaS: a team task board with workspaces (organizations),
invite codes, and per-tenant data isolation. Built with **zero npm dependencies**
on Node.js ≥ 22.5 (`node:http` for the server, `node:sqlite` for storage,
`node:crypto` scrypt for password hashing).

## Features

- Sign up creates a user **and** a new workspace (organization); the creator is `owner`
- Other users join an existing workspace with its invite code (`role: member`)
- Login/logout with bearer-token sessions (7-day expiry, stored server-side)
- Projects and tasks CRUD, strictly scoped to the caller's organization
- Cross-tenant access returns `404` (verified by tests)
- Single-page web UI served by the same process

## Run

```bash
npm start          # http://localhost:3000
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/taskflow.db` | SQLite file (`:memory:` for ephemeral) |

## Test

```bash
npm test
```

Spins up the server on an ephemeral port with an in-memory database and exercises
auth, validation, CRUD, invite flow, session invalidation, and tenant isolation.

## API

All `/api/*` routes except `signup`/`join`/`login`/`health` require
`Authorization: Bearer <token>`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Liveness probe |
| POST | `/api/signup` | `{name, email, password, orgName?}` → creates user + workspace + session |
| POST | `/api/join` | `{name, email, password, inviteCode}` → joins an existing workspace |
| POST | `/api/login` | `{email, password}` → `{token, user}` |
| POST | `/api/logout` | Invalidates the current token |
| GET | `/api/me` | Current user and their workspaces |
| GET | `/api/org` | Current workspace (name, invite code, role) |
| POST | `/api/projects` | `{name}` → create project |
| GET | `/api/projects` | List projects with task counts |
| DELETE | `/api/projects/:id` | Delete project and its tasks |
| GET | `/api/projects/:id/tasks` | List tasks of a project |
| POST | `/api/projects/:id/tasks` | `{title}` → create task (`status: todo`) |
| PATCH | `/api/tasks/:id` | `{title?, status?}` — status: `todo` \| `in_progress` \| `done` |
| DELETE | `/api/tasks/:id` | Delete task |

## Layout

```
src/server.js   HTTP server, router, static files, API handlers
src/db.js       SQLite schema + openDb()
src/auth.js     scrypt password hashing, token generation
public/         Web UI (index.html, app.js, style.css)
test/           node:test API tests (in-memory DB)
```
