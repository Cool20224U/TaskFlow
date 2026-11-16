import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDb } from './db.js';
import { hashPassword, verifyPassword, newToken } from './auth.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TASK_STATUSES = new Set(['todo', 'in_progress', 'done']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateCredentials(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!name || !validateEmail(email) || password.length < 8) {
    throw new HttpError(400, 'name, a valid email and a password of at least 8 characters are required');
  }
  return { name, email, password };
}

function tokenFromRequest(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function getUserByToken(db, req) {
  const token = tokenFromRequest(req);
  if (!token) return null;
  const row = db
    .prepare('SELECT u.id, u.name, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
    .get(token);
  if (!row || Number(row.expires_at) < Date.now()) return null;
  return { id: row.id, name: row.name, email: row.email };
}

function createSession(db, userId) {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function resolveOrg(db, userId, requestedOrgId) {
  const memberships = db.prepare('SELECT org_id, role FROM org_members WHERE user_id = ? ORDER BY rowid').all(userId);
  if (memberships.length === 0) return null;
  const membership = memberships.find((m) => m.org_id === requestedOrgId) || memberships[0];
  const org = db.prepare('SELECT id, name, invite_code FROM orgs WHERE id = ?').get(membership.org_id);
  return { org, role: membership.role };
}

function requireAuth(ctx) {
  if (!ctx.user) throw new HttpError(401, 'authentication required');
  const resolved = resolveOrg(ctx.db, ctx.user.id, ctx.query.get('org'));
  if (!resolved) throw new HttpError(403, 'user has no organization');
  return { user: ctx.user, org: resolved.org, role: resolved.role };
}

function findOwnedProject(db, projectId, orgId) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(projectId, orgId);
}

function findOwnedTask(db, taskId, orgId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(taskId, orgId);
}

async function signup({ db, body }) {
  const { name, email, password } = validateCredentials(body);
  const orgName = typeof body.orgName === 'string' && body.orgName.trim() ? body.orgName.trim() : `${name.split(' ')[0]}'s workspace`;
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'email already registered');
  }
  const userId = randomUUID();
  const orgId = randomUUID();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, name, email, hashPassword(password), Date.now());
    db.prepare('INSERT INTO orgs (id, name, invite_code, created_at) VALUES (?, ?, ?, ?)')
      .run(orgId, orgName, newToken(), Date.now());
    db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)').run(orgId, userId, 'owner');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const token = createSession(db, userId);
  return { status: 201, data: { token, user: { id: userId, name, email }, org: { id: orgId, name: orgName } } };
}

async function join({ db, body }) {
  const { name, email, password } = validateCredentials(body);
  const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
  const org = db.prepare('SELECT id, name FROM orgs WHERE invite_code = ?').get(inviteCode);
  if (!org) throw new HttpError(404, 'invalid invite code');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'email already registered');
  }
  const userId = randomUUID();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, name, email, hashPassword(password), Date.now());
    db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)').run(org.id, userId, 'member');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const token = createSession(db, userId);
  return { status: 201, data: { token, user: { id: userId, name, email }, org } };
}

async function login({ db, body }) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = db.prepare('SELECT id, name, email, password_hash FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'invalid credentials');
  }
  const token = createSession(db, user.id);
  return { data: { token, user: { id: user.id, name: user.name, email: user.email } } };
}

async function logout({ db, req }) {
  const token = tokenFromRequest(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return { data: { ok: true } };
}

async function me(ctx) {
  if (!ctx.user) throw new HttpError(401, 'authentication required');
  const orgs = ctx.db
    .prepare('SELECT o.id, o.name, m.role FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY m.rowid')
    .all(ctx.user.id);
  return { data: { user: ctx.user, orgs } };
}

async function getOrg(ctx) {
  const { org, role } = requireAuth(ctx);
  return { data: { id: org.id, name: org.name, invite_code: org.invite_code, role } };
}

async function createProject(ctx) {
  const { org } = requireAuth(ctx);
  const name = typeof ctx.body.name === 'string' ? ctx.body.name.trim() : '';
  if (!name) throw new HttpError(400, 'project name is required');
  const id = randomUUID();
  ctx.db.prepare('INSERT INTO projects (id, org_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, org.id, name, Date.now());
  return { status: 201, data: { id, org_id: org.id, name } };
}

async function listProjects(ctx) {
  const { org } = requireAuth(ctx);
  const projects = ctx.db
    .prepare(
      `SELECT p.id, p.name, p.created_at,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count
       FROM projects p WHERE p.org_id = ? ORDER BY p.created_at DESC, p.id`
    )
    .all(org.id);
  return { data: { projects } };
}

async function deleteProject(ctx) {
  const { org } = requireAuth(ctx);
  const project = findOwnedProject(ctx.db, ctx.params.id, org.id);
  if (!project) throw new HttpError(404, 'project not found');
  ctx.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(project.id);
  ctx.db.prepare('DELETE FROM projects WHERE id = ? AND org_id = ?').run(project.id, org.id);
  return { data: { ok: true } };
}

async function listTasks(ctx) {
  const { org } = requireAuth(ctx);
  if (!findOwnedProject(ctx.db, ctx.params.id, org.id)) throw new HttpError(404, 'project not found');
  const tasks = ctx.db
    .prepare('SELECT id, project_id, title, status, created_at FROM tasks WHERE project_id = ? AND org_id = ? ORDER BY created_at ASC, id')
    .all(ctx.params.id, org.id);
  return { data: { tasks } };
}

async function createTask(ctx) {
  const { org } = requireAuth(ctx);
  const project = findOwnedProject(ctx.db, ctx.params.id, org.id);
  if (!project) throw new HttpError(404, 'project not found');
  const title = typeof ctx.body.title === 'string' ? ctx.body.title.trim() : '';
  if (!title) throw new HttpError(400, 'task title is required');
  const id = randomUUID();
  ctx.db.prepare('INSERT INTO tasks (id, org_id, project_id, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, org.id, project.id, title, 'todo', Date.now());
  return { status: 201, data: { id, project_id: project.id, title, status: 'todo' } };
}

async function updateTask(ctx) {
  const { org } = requireAuth(ctx);
  const task = findOwnedTask(ctx.db, ctx.params.id, org.id);
  if (!task) throw new HttpError(404, 'task not found');
  const title = typeof ctx.body.title === 'string' && ctx.body.title.trim() ? ctx.body.title.trim() : task.title;
  const status = ctx.body.status !== undefined ? ctx.body.status : task.status;
  if (!TASK_STATUSES.has(status)) throw new HttpError(400, `status must be one of: ${[...TASK_STATUSES].join(', ')}`);
  ctx.db.prepare('UPDATE tasks SET title = ?, status = ? WHERE id = ? AND org_id = ?').run(title, status, task.id, org.id);
  return { data: { id: task.id, title, status } };
}

async function deleteTask(ctx) {
  const { org } = requireAuth(ctx);
  const task = findOwnedTask(ctx.db, ctx.params.id, org.id);
  if (!task) throw new HttpError(404, 'task not found');
  ctx.db.prepare('DELETE FROM tasks WHERE id = ? AND org_id = ?').run(task.id, org.id);
  return { data: { ok: true } };
}

const routes = [
  ['GET', '/api/health', async () => ({ data: { ok: true } })],
  ['POST', '/api/signup', signup],
  ['POST', '/api/join', join],
  ['POST', '/api/login', login],
  ['POST', '/api/logout', logout],
  ['GET', '/api/me', me],
  ['GET', '/api/org', getOrg],
  ['POST', '/api/projects', createProject],
  ['GET', '/api/projects', listProjects],
  ['DELETE', '/api/projects/:id', deleteProject],
  ['GET', '/api/projects/:id/tasks', listTasks],
  ['POST', '/api/projects/:id/tasks', createTask],
  ['PATCH', '/api/tasks/:id', updateTask],
  ['DELETE', '/api/tasks/:id', deleteTask],
];

function compile(pattern) {
  const names = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (segment) => {
    names.push(segment.slice(1));
    return '([^/]+)';
  }) + '$');
  return { regex, names };
}

function serveStatic(req, res, publicDir, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.normalize(path.join(publicDir, rel));
  if (!filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handle(req, res, db, publicDir) {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  if (!pathname.startsWith('/api/')) {
    serveStatic(req, res, publicDir, pathname);
    return;
  }
  for (const [method, pattern, handler] of routes) {
    if (method !== req.method) continue;
    const { regex, names } = compile(pattern);
    const match = regex.exec(pathname);
    if (!match) continue;
    const params = {};
    names.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });
    try {
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const user = getUserByToken(db, req);
      const result = await handler({ db, body, params, query: parsed.searchParams, user, req });
      sendJson(res, result.status ?? 200, result.data);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'internal server error' });
      }
    }
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

export function createApp(options = {}) {
  const dbPath = options.dbPath ?? ':memory:';
  const db = openDb(dbPath);
  const publicDir = path.resolve(options.publicDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'));
  const server = http.createServer((req, res) => {
    handle(req, res, db, publicDir).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' });
      else res.end();
    });
  });
  return { server, db };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const port = Number(process.env.PORT || 3000);
  const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'taskflow.db');
  const { server } = createApp({ dbPath });
  server.listen(port, () => {
    console.log(`TaskFlow running at http://localhost:${port} (db: ${dbPath})`);
  });
}
