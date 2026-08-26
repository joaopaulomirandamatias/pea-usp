(function () {
  'use strict';
  const tokenKey = 'rota-specialist-token';
  let specialist = null;
  let room = null;
  let toastTimer;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const token = sessionStorage.getItem(tokenKey);
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(path, { ...options, headers });
    let payload = {};
    try { payload = await response.json(); } catch (error) { payload = {}; }
    if (!response.ok) throw new Error(payload.error || `Falha na requisição (${response.status}).`);
    return payload;
  }

  function toast(message) {
    $('#toast').textContent = message;
    $('#toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3500);
  }

  function render() {
    document.body.classList.remove('specialist-locked');
    $('#specialistHeaderName').textContent = specialist.name;
    $('#specialistCourseCode').textContent = specialist.course_code;
    $('#specialistSessionTitle').textContent = specialist.session_title;
    const form = $('#specialistProfileForm');
    ['name', 'role', 'email', 'linkedin', 'whatsapp', 'website'].forEach((field) => { form.elements[field].value = specialist[field] || ''; });
    const meet = $('#specialistMeet');
    if (room.session.meet_url) { meet.href = room.session.meet_url; meet.hidden = false; } else meet.hidden = true;
    $('#specialistResourceCount').textContent = `${room.resources.length} ${room.resources.length === 1 ? 'item' : 'itens'}`;
    $('#specialistResourceList').innerHTML = room.resources.map((item) => `<article class="room-resource"><span>${item.resource_type === 'slide' ? '▱' : '↗'}</span><div><small>${esc(item.author_name)} · ${esc(item.visibility)}</small><strong>${esc(item.title)}</strong>${item.content_html ? `<div>${item.content_html}</div>` : ''}</div>${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Abrir ↗</a>` : ''}</article>`).join('') || '<p class="room-empty">Nenhum material publicado.</p>';
    $('#specialistCommentList').innerHTML = room.comments.map((item) => `<article class="room-comment"><div><strong>${esc(item.author_name)}</strong><span>${esc(item.author_role)}</span></div><div>${item.content_html}</div></article>`).join('') || '<p class="room-empty">O mural ainda está vazio.</p>';
  }

  async function load() {
    try {
      const result = await api('/api/specialist/me');
      specialist = result.specialist;
      room = result.room;
      render();
      if ($('#specialistLoginDialog').open) $('#specialistLoginDialog').close();
    } catch (error) {
      sessionStorage.removeItem(tokenKey);
      document.body.classList.add('specialist-locked');
      if (!$('#specialistLoginDialog').open) $('#specialistLoginDialog').showModal();
    }
  }

  $('#specialistLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    $('#specialistLoginError').textContent = '';
    try {
      const result = await api('/api/specialist/login', { method: 'POST', body: JSON.stringify({ token: form.elements.token.value.trim() }) });
      sessionStorage.setItem(tokenKey, result.token);
      form.reset();
      await load();
    } catch (error) { $('#specialistLoginError').textContent = error.message; }
  });

  $('#specialistProfileForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try { await api('/api/specialist/profile', { method: 'PUT', body: JSON.stringify(values) }); toast('Contatos atualizados.'); await load(); } catch (error) { toast(error.message); }
  });

  $('#specialistResourceForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    values.visibility = event.currentTarget.elements.public.checked ? 'public' : 'class';
    try { await api(`/api/sessions/${specialist.session_id}/resources`, { method: 'POST', body: JSON.stringify(values) }); event.currentTarget.reset(); toast('Material publicado para a aula.'); await load(); } catch (error) { toast(error.message); }
  });

  $$('[data-command]').forEach((button) => button.addEventListener('click', () => { $('#specialistCommentEditor').focus(); document.execCommand(button.dataset.command, false); }));
  $('#specialistCommentForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const editor = $('#specialistCommentEditor');
    if (!editor.textContent.trim()) return;
    try { await api(`/api/sessions/${specialist.session_id}/comments`, { method: 'POST', body: JSON.stringify({ content_html: editor.innerHTML }) }); editor.innerHTML = ''; await load(); } catch (error) { toast(error.message); }
  });

  $('#specialistLogout').addEventListener('click', () => { sessionStorage.removeItem(tokenKey); specialist = null; room = null; load(); });

  const hashToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (hashToken) {
    window.history.replaceState({}, '', window.location.pathname);
    $('#specialistLoginForm').elements.token.value = hashToken;
    $('#specialistLoginForm').requestSubmit();
  } else {
    load();
  }
}());
