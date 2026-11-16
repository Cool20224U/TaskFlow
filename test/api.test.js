import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

let server;
let base;

before(async () => {
  const app = createApp({ dbPath: ':memory:' });
  server = app.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* empty body */ }
  return { status: res.status, data };
}

const owner = { name: 'Ada Owner', email: 'ada@example.com', password: 'password-123', orgName: 'Acme' };
const mate = { name: 'Milo Mate', email: 'milo@example.com', password: 'password-456' };

let ownerToken;
let ownerOrg;
let projectId;
let taskId;

test('health endpoint responds', async () => {
  const res = await api('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true });
});

test('signup rejects weak input', async () => {
  const res = await api('POST', '/api/signup', { body: { name: 'X', email: 'not-an-email', password: 'short' } });
  assert.equal(res.status, 400);
});

test('owner can sign up and gets a session token', async () => {
  const res = await api('POST', '/api/signup', { body: owner });
  assert.equal(res.status, 201);
  assert.ok(res.data.token);
  assert.equal(res.data.org.name, 'Acme');
  ownerToken = res.data.token;
});

test('duplicate email is rejected', async () => {
  const res = await api('POST', '/api/signup', { body: owner });
  assert.equal(res.status, 409);
});

test('login with wrong password fails, correct password works', async () => {
  const bad = await api('POST', '/api/login', { body: { email: owner.email, password: 'wrong-password' } });
  assert.equal(bad.status, 401);
  const good = await api('POST', '/api/login', { body: { email: owner.email, password: owner.password } });
  assert.equal(good.status, 200);
  assert.ok(good.data.token);
});

test('protected routes require a token', async () => {
  const res = await api('GET', '/api/projects');
  assert.equal(res.status, 401);
});

test('org endpoint exposes the invite code to members', async () => {
  const res = await api('GET', '/api/org', { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.name, 'Acme');
  assert.equal(res.data.role, 'owner');
  assert.ok(res.data.invite_code);
  ownerOrg = res.data;
});

test('owner can create and list projects', async () => {
  const created = await api('POST', '/api/projects', { token: ownerToken, body: { name: 'Launch' } });
  assert.equal(created.status, 201);
  projectId = created.data.id;
  const list = await api('GET', '/api/projects', { token: ownerToken });
  assert.equal(list.status, 200);
  assert.equal(list.data.projects.length, 1);
  assert.equal(list.data.projects[0].name, 'Launch');
  assert.equal(list.data.projects[0].task_count, 0);
});

test('project creation validates the name', async () => {
  const res = await api('POST', '/api/projects', { token: ownerToken, body: { name: '  ' } });
  assert.equal(res.status, 400);
});

test('tasks can be created, listed, updated and deleted', async () => {
  const created = await api('POST', `/api/projects/${projectId}/tasks`, { token: ownerToken, body: { title: 'Ship v1' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'todo');
  taskId = created.data.id;

  let list = await api('GET', `/api/projects/${projectId}/tasks`, { token: ownerToken });
  assert.equal(list.data.tasks.length, 1);

  const updated = await api('PATCH', `/api/tasks/${taskId}`, { token: ownerToken, body: { status: 'in_progress' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.status, 'in_progress');

  const invalid = await api('PATCH', `/api/tasks/${taskId}`, { token: ownerToken, body: { status: 'nope' } });
  assert.equal(invalid.status, 400);

  const projects = await api('GET', '/api/projects', { token: ownerToken });
  assert.equal(projects.data.projects[0].task_count, 1);

  const deleted = await api('DELETE', `/api/tasks/${taskId}`, { token: ownerToken });
  assert.equal(deleted.status, 200);
  list = await api('GET', `/api/projects/${projectId}/tasks`, { token: ownerToken });
  assert.equal(list.data.tasks.length, 0);
});

test('a second user can join via invite code and shares the workspace', async () => {
  const joined = await api('POST', '/api/join', { body: { ...mate, inviteCode: ownerOrg.invite_code } });
  assert.equal(joined.status, 201);
  assert.equal(joined.data.org.id, ownerOrg.id);
  mate.token = joined.data.token;

  const list = await api('GET', '/api/projects', { token: mate.token });
  assert.equal(list.status, 200);
  assert.equal(list.data.projects.length, 1);
  assert.equal(list.data.projects[0].name, 'Launch');
});

test('joining with a bad invite code fails', async () => {
  const res = await api('POST', '/api/join', { body: { ...mate, email: 'other@example.com', inviteCode: 'bogus' } });
  assert.equal(res.status, 404);
});

test('cross-tenant access is blocked (IDOR)', async () => {
  const created = await api('POST', `/api/projects/${projectId}/tasks`, { token: ownerToken, body: { title: 'Secret task' } });
  taskId = created.data.id;

  const outsider = await api('POST', '/api/signup', {
    body: { name: 'Nadia Out', email: 'nadia@example.com', password: 'password-789', orgName: 'OtherCo' },
  });
  assert.equal(outsider.status, 201);
  const outsiderToken = outsider.data.token;
  assert.notEqual(outsider.data.org.id, ownerOrg.id);

  const ownList = await api('GET', '/api/projects', { token: outsiderToken });
  assert.equal(ownList.data.projects.length, 0);

  const read = await api('GET', `/api/projects/${projectId}/tasks`, { token: outsiderToken });
  assert.equal(read.status, 404);

  const patch = await api('PATCH', `/api/tasks/${taskId}`, { token: outsiderToken, body: { status: 'done' } });
  assert.equal(patch.status, 404);

  const del = await api('DELETE', `/api/projects/${projectId}`, { token: outsiderToken });
  assert.equal(del.status, 404);

  const stillThere = await api('GET', `/api/projects/${projectId}/tasks`, { token: ownerToken });
  assert.equal(stillThere.data.tasks.length, 1);
  assert.equal(stillThere.data.tasks[0].status, 'todo');
});

test('logout invalidates the session token', async () => {
  const res = await api('POST', '/api/logout', { token: mate.token });
  assert.equal(res.status, 200);
  const me = await api('GET', '/api/me', { token: mate.token });
  assert.equal(me.status, 401);
});

test('unknown API route returns 404 JSON', async () => {
  const res = await api('GET', '/api/nope', { token: ownerToken });
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'not found');
});
