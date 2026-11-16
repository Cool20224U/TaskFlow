const $ = (sel) => document.querySelector(sel);

const state = { token: localStorage.getItem('tf_token') || null };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && state.token) {
    state.token = null;
    localStorage.removeItem('tf_token');
    showAuth();
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function showAuth() {
  $('#auth-view').hidden = false;
  $('#app-view').hidden = true;
  $('#logout-btn').hidden = true;
}

function showApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#logout-btn').hidden = false;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function boot() {
  if (!state.token) {
    showAuth();
    return;
  }
  try {
    await loadApp();
  } catch {
    showAuth();
  }
}

async function loadApp() {
  await api('GET', '/api/me');
  const org = await api('GET', '/api/org');
  $('#org-name').textContent = org.name;
  $('#invite-code').textContent = org.invite_code;
  showApp();
  await loadProjects();
}

async function loadProjects() {
  const { projects } = await api('GET', '/api/projects');
  const container = $('#projects');
  container.innerHTML = '';
  for (const project of projects) {
    const { tasks } = await api('GET', `/api/projects/${project.id}/tasks`);
    container.appendChild(renderProject(project, tasks));
  }
}

function renderProject(project, tasks) {
  const el = document.createElement('div');
  el.className = 'card project';
  el.innerHTML = `
    <h2>${escapeHtml(project.name)} <span class="meta">${project.done_count}/${project.task_count} done</span>
      <button class="small danger" data-action="delete-project" style="margin-left:auto">Delete</button>
    </h2>
    <ul class="task-list">
      ${tasks.map((task) => `
        <li class="${task.status === 'done' ? 'done' : ''}" data-task-id="${task.id}">
          <span class="title">${escapeHtml(task.title)}</span>
          <select data-action="status">
            ${['todo', 'in_progress', 'done'].map((s) => `<option value="${s}" ${s === task.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <button class="small danger" data-action="delete-task">✕</button>
        </li>`).join('')}
    </ul>
    <form class="task-form">
      <input type="text" placeholder="New task" required>
      <button type="submit">Add task</button>
    </form>
  `;

  el.querySelector('[data-action="delete-project"]').addEventListener('click', async () => {
    await api('DELETE', `/api/projects/${project.id}`);
    await loadProjects();
  });

  el.querySelector('.task-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = event.target.querySelector('input').value;
    await api('POST', `/api/projects/${project.id}/tasks`, { title });
    await loadProjects();
  });

  el.querySelector('.task-list').addEventListener('change', async (event) => {
    const li = event.target.closest('li');
    if (event.target.dataset.action === 'status' && li) {
      await api('PATCH', `/api/tasks/${li.dataset.taskId}`, { status: event.target.value });
      await loadProjects();
    }
  });

  el.querySelector('.task-list').addEventListener('click', async (event) => {
    const li = event.target.closest('li');
    if (event.target.dataset.action === 'delete-task' && li) {
      await api('DELETE', `/api/tasks/${li.dataset.taskId}`);
      await loadProjects();
    }
  });

  return el;
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#auth-error').textContent = '';
  try {
    const { token } = await api('POST', '/api/login', formData(event.target));
    state.token = token;
    localStorage.setItem('tf_token', token);
    await loadApp();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

$('#signup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#auth-error').textContent = '';
  try {
    const { token } = await api('POST', '/api/signup', formData(event.target));
    state.token = token;
    localStorage.setItem('tf_token', token);
    await loadApp();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

$('#join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#auth-error').textContent = '';
  try {
    const { token } = await api('POST', '/api/join', formData(event.target));
    state.token = token;
    localStorage.setItem('tf_token', token);
    await loadApp();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#login-form').hidden = tab.dataset.tab !== 'login';
    $('#signup-form').hidden = tab.dataset.tab !== 'signup';
    $('#join-form').hidden = tab.dataset.tab !== 'join';
    $('#auth-error').textContent = '';
  });
});

$('#project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#app-error').textContent = '';
  try {
    await api('POST', '/api/projects', { name: $('#project-name').value });
    $('#project-name').value = '';
    await loadProjects();
  } catch (err) {
    $('#app-error').textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try {
    await api('POST', '/api/logout');
  } catch { /* session may already be gone */ }
  state.token = null;
  localStorage.removeItem('tf_token');
  showAuth();
});

boot();
