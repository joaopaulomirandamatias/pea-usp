(function () {
  'use strict';

  let state = window.CourseStore.load();
  const params = new URLSearchParams(window.location.search);
  let currentCode = (params.get('curso') || 'PEA5004').toUpperCase();
  let course = window.CourseStore.getCourse(state, currentCode);
  currentCode = course.code;
  let remoteCourse = null;
  let editingSessionId = null;
  let toastTimer;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

  async function apiRequest(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers });
    let payload = {};
    try { payload = await response.json(); } catch (error) { payload = {}; }
    if (!response.ok) {
      const requestError = new Error(payload.error || `Falha na requisição (${response.status}).`);
      requestError.status = response.status;
      throw requestError;
    }
    return payload;
  }

  const dateFromISO = (value) => new Date(`${value}T12:00:00`);
  const formatClassDate = (value, options) => new Intl.DateTimeFormat('pt-BR', options).format(dateFromISO(value));
  const todayInCourseTimezone = () => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Belem', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    return dateFromISO(`${parts.year}-${parts.month}-${parts.day}`);
  };

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
  }

  function saveState(message) {
    course.updatedAt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date()).replace(',', ' ·');
    window.CourseStore.save(state);
    if (message) showToast(message);
  }

  function setText(selector, value) {
    const element = $(selector);
    if (element) element.textContent = value;
  }

  function renderCourseTabs() {
    $('#courseTabs').innerHTML = state.courses.map((item) => `
      <button class="admin-course-tab ${item.code === course.code ? 'active' : ''}" data-course="${esc(item.code)}" style="background-image:url('${esc(item.cover)}')">
        <small>${esc(item.code)} · ${esc(item.semester)}</small>
        <strong>${esc(item.shortTitle)}</strong>
        <span>${esc(item.status)}</span>
      </button>
    `).join('');
    $$('.admin-course-tab').forEach((button) => button.addEventListener('click', () => selectCourse(button.dataset.course)));
  }

  function renderMetrics() {
    const remoteStudents = remoteCourse?.students || [];
    const activeStudents = remoteCourse ? remoteStudents.filter((student) => student.active).length : course.students.filter((student) => student.access).length;
    const driveItems = course.folders.reduce((sum, folder) => sum + Number(folder.count || 0), 0);
    const submissions = course.submissions || [];
    setText('#studentMetric', activeStudents);
    setText('#studentMetricDetail', `${remoteCourse ? remoteStudents.length : course.students.length} na lista atual`);
    setText('#moduleMetric', remoteCourse?.stats?.classes ?? course.modules.length);
    setText('#moduleMetricDetail', remoteCourse?.next_class ? `${formatClassDate(remoteCourse.next_class.session_date, { day: '2-digit', month: 'short' })} · próxima aula` : 'nenhuma aula futura');
    setText('#driveMetric', driveItems);
    setText('#driveMetricDetail', course.driveConnected ? 'itens sincronizados' : 'vínculo pendente');
    setText('#submissionMetric', remoteCourse?.stats?.uploads ?? submissions.length);
    setText('#submissionMetricDetail', remoteCourse ? 'materiais recebidos' : (submissions.length === 1 ? 'grupo reservado' : 'grupos reservados'));
  }

  function populateForm() {
    const form = $('#courseForm');
    ['code', 'semester', 'title', 'shortTitle', 'description', 'ementa', 'classDay', 'room', 'cover', 'status', 'visibility'].forEach((field) => {
      if (form.elements[field]) form.elements[field].value = course[field] || '';
    });
    $('#courseCoverEditor').style.backgroundImage = `url('${course.cover}')`;
    setText('#coverCode', course.code);
    setText('#coverTitle', course.shortTitle);
    setText('#courseStatusLabel', course.status);
  }

  function renderDrive() {
    const connected = Boolean(course.driveConnected && course.driveUrl);
    setText('#driveStatusLabel', connected ? 'Conectado' : 'Aguardando vínculo');
    setText('#driveStateTitle', connected ? 'Pasta sincronizada' : 'Pasta não vinculada');
    setText('#driveStateDetail', connected ? course.driveEmail : 'Cole o link da pasta principal');
    $('#driveUrlInput').value = course.driveUrl || '';
    $('#driveFolderList').innerHTML = course.folders.map((folder) => `<div class="drive-folder"><span>${esc(folder.name)}</span><span>${connected ? '✓ ' + folder.count : '—'}</span></div>`).join('');
    $('#syncDriveButton').textContent = connected ? 'Sincronizar agora' : 'Conectar pasta';
  }

  function renderClasses() {
    const sessions = remoteCourse?.sessions || [];
    const nextId = remoteCourse?.next_class?.id;
    const today = todayInCourseTimezone();
    $('#classAdminList').innerHTML = sessions.map((session) => {
      const isPast = dateFromISO(session.session_date) < today;
      const dateClass = session.id === nextId ? 'next' : isPast ? 'past' : '';
      const presenters = session.articles.flatMap((article) => article.presenters || []).map((student) => student.name);
      return `<div class="admin-list-row class-admin-row">
        <span class="class-date-chip ${dateClass}"><strong>${esc(formatClassDate(session.session_date, { day: '2-digit' }))}</strong><small>${esc(formatClassDate(session.session_date, { month: 'short' }))} · ${esc(session.start_time)}</small></span>
        <div><strong>${esc(session.title)}</strong><small>${esc(session.theme || 'Tema a definir')} · ${session.articles.length} artigo${session.articles.length === 1 ? '' : 's'}${presenters.length ? ` · ${esc(presenters.join(', '))}` : ''}</small></div>
        <div class="class-specialist-summary"><span>1º momento</span><strong>${esc(session.specialist_name || 'Especialista a confirmar')}</strong><small>${esc(session.specialist_role || session.specialist_topic || '—')}</small></div>
        <div class="class-row-actions"><button class="row-action" data-edit-class="${session.id}">Editar</button><button class="row-action" data-remove-class="${session.id}" aria-label="Remover aula ${esc(session.title)}">×</button></div>
      </div>`;
    }).join('') || '<div class="admin-list-row"><span class="row-index">—</span><div><strong>Nenhuma aula agendada</strong><small>Cadastre a primeira data para ativar o destaque automático dos alunos.</small></div><span></span><span></span></div>';

    $$('[data-edit-class]').forEach((button) => button.addEventListener('click', () => openClassDialog(Number(button.dataset.editClass))));
    $$('[data-remove-class]').forEach((button) => button.addEventListener('click', async () => {
      const session = sessions.find((item) => item.id === Number(button.dataset.removeClass));
      if (!session || !window.confirm(`Remover a aula de ${formatClassDate(session.session_date, { day: '2-digit', month: 'short' })}: “${session.title}”?`)) return;
      try {
        await apiRequest(`/api/admin/sessions/${session.id}`, { method: 'DELETE' });
        showToast('Aula removida da agenda.');
        await loadRemoteAdmin();
      } catch (error) { showToast(error.message); }
    }));
  }

  function renderPresenterChecks() {
    const students = (remoteCourse?.students || []).filter((student) => student.active);
    $('#presenterChecks').innerHTML = students.map((student) => `<label><input type="checkbox" name="presenter_ids" value="${student.id}"><span>${esc(student.name)} <small>Nº USP ${esc(student.nusp)}</small></span></label>`).join('') || '<p>Nenhum aluno ativo. Cadastre a turma antes de vincular apresentadores.</p>';
  }

  function renderManagedArticles(session) {
    $('#managedArticleList').innerHTML = (session?.articles || []).map((article) => {
      const presenters = (article.presenters || []).map((student) => student.name).join(', ');
      return `<article class="managed-article"><span>${esc(article.code || 'ART')}</span><div><strong>${esc(article.title)}</strong><small>${esc(article.author || 'Autoria a definir')} · ${presenters ? `Apresentação: ${esc(presenters)}` : 'Sem apresentador'}</small></div><button class="row-action" data-remove-article="${article.id}" aria-label="Remover ${esc(article.title)}">×</button></article>`;
    }).join('') || '<p class="next-article-empty" style="color:#71898f">Nenhum artigo vinculado a esta aula.</p>';
    $$('[data-remove-article]').forEach((button) => button.addEventListener('click', async () => {
      try {
        await apiRequest(`/api/admin/articles/${button.dataset.removeArticle}`, { method: 'DELETE' });
        showToast('Artigo removido da aula.');
        await loadRemoteAdmin();
        const updated = remoteCourse.sessions.find((item) => item.id === editingSessionId);
        renderManagedArticles(updated);
      } catch (error) { showToast(error.message); }
    }));
  }

  function openClassDialog(sessionId = null) {
    editingSessionId = sessionId;
    const form = $('#classForm');
    form.reset();
    form.elements.start_time.value = '14:00';
    const session = remoteCourse?.sessions?.find((item) => item.id === sessionId);
    setText('#classDialogTitle', session ? 'Editar aula' : 'Nova aula');
    $('#articleManager').hidden = !session;
    if (session) {
      ['session_date', 'start_time', 'title', 'theme', 'location', 'specialist_name', 'specialist_role', 'specialist_topic', 'notes'].forEach((field) => {
        form.elements[field].value = session[field] || '';
      });
      form.elements.session_id.value = session.id;
      renderManagedArticles(session);
      renderPresenterChecks();
    }
    $('#classDialog').showModal();
  }

  function renderUploads() {
    const uploads = remoteCourse?.uploads || [];
    setText('#uploadCountLabel', `${uploads.length} ${uploads.length === 1 ? 'arquivo' : 'arquivos'}`);
    $('#uploadAdminList').innerHTML = uploads.map((upload) => {
      const extension = upload.filename.includes('.') ? upload.filename.split('.').pop() : 'arq';
      const size = upload.size_bytes < 1024 * 1024 ? `${Math.max(1, Math.round(upload.size_bytes / 1024))} KB` : `${(upload.size_bytes / 1024 / 1024).toFixed(1)} MB`;
      return `<div class="admin-list-row upload-admin-row"><span class="file-badge">${esc(extension)}</span><div><strong>${esc(upload.filename)}</strong><small>${esc(upload.student_name)} · ${esc(upload.description || 'Sem descrição')}</small></div><div class="upload-context"><strong>${esc(upload.session_title || 'Material geral')}</strong><br>${esc(upload.article_title || 'Sem artigo específico')}</div><div class="upload-file-actions"><span class="file-size">${size}</span><a class="row-action" href="/api/admin/uploads/${upload.id}/download">Baixar</a></div></div>`;
    }).join('') || '<div class="admin-list-row"><span class="row-index">—</span><div><strong>Nenhum material recebido</strong><small>Os arquivos enviados pelos alunos aparecerão aqui.</small></div><span></span><span></span></div>';
  }

  function renderModules() {
    $('#moduleAdminList').innerHTML = course.modules.map((module, index) => `
      <div class="admin-list-row">
        <span class="row-index">${String(index + 1).padStart(2, '0')}</span>
        <div><strong>${esc(module.title)}</strong><small>${esc(module.kicker)} · ${esc(module.summary)}</small></div>
        <span class="row-meta">${esc(module.date)} · ${module.articles} art.</span>
        <button class="row-action" data-remove-module="${module.id}" aria-label="Remover ${esc(module.title)}">×</button>
      </div>
    `).join('') || '<div class="admin-list-row"><div></div><div><strong>Nenhuma etapa criada</strong><small>Use “Nova etapa” para começar a trilha.</small></div></div>';

    $$('[data-remove-module]').forEach((button) => button.addEventListener('click', () => {
      const module = course.modules.find((item) => item.id === Number(button.dataset.removeModule));
      if (!module || !window.confirm(`Remover a etapa “${module.title}”?`)) return;
      course.modules = course.modules.filter((item) => item.id !== module.id);
      saveState('Etapa removida da trilha.');
      renderAll();
    }));
  }

  function renderStudents() {
    const students = remoteCourse?.students || course.students.map((student, index) => ({ ...student, id: index, active: student.access, group_name: student.group }));
    $('#studentRows').innerHTML = students.map((student) => `
      <tr>
        <td><strong>${esc(student.name)}</strong></td>
        <td>${esc(student.email)}</td>
        <td>${esc(student.nusp)}</td>
        <td>${esc(student.group_name || '—')}</td>
        <td><button class="access-pill ${student.active ? '' : 'off'}" data-toggle-student="${student.id}">${student.active ? 'Liberado' : 'Bloqueado'}</button></td>
        <td><button class="row-action" data-remove-student="${student.id}" aria-label="Remover ${esc(student.name)}">×</button></td>
      </tr>
    `).join('') || '<tr><td colspan="6">Nenhum aluno cadastrado nesta disciplina.</td></tr>';

    $$('[data-toggle-student]').forEach((button) => button.addEventListener('click', async () => {
      const student = students.find((item) => item.id === Number(button.dataset.toggleStudent));
      if (!student) return;
      if (remoteCourse) {
        try {
          await apiRequest(`/api/admin/students/${student.id}`, { method: 'PATCH', body: JSON.stringify({ active: !student.active }) });
          showToast(`Acesso de ${student.name} ${!student.active ? 'liberado' : 'bloqueado'}.`);
          await loadRemoteAdmin();
        } catch (error) { showToast(error.message); }
      } else {
        const localStudent = course.students[student.id];
        localStudent.access = !localStudent.access;
        saveState(`Acesso de ${localStudent.name} ${localStudent.access ? 'liberado' : 'bloqueado'}.`);
        renderStudents();
        renderMetrics();
      }
    }));
    $$('[data-remove-student]').forEach((button) => button.addEventListener('click', async () => {
      const student = students.find((item) => item.id === Number(button.dataset.removeStudent));
      if (!student || !window.confirm(`Remover ${student.name} da lista?`)) return;
      if (remoteCourse) {
        try {
          await apiRequest(`/api/admin/students/${student.id}`, { method: 'DELETE' });
          showToast('Aluno removido da disciplina.');
          await loadRemoteAdmin();
        } catch (error) { showToast(error.message); }
      } else {
        course.students.splice(student.id, 1);
        saveState('Aluno removido da disciplina.');
        renderStudents();
        renderMetrics();
      }
    }));
  }

  function renderSubmissions() {
    const submissions = course.submissions || [];
    $('#submissionList').innerHTML = submissions.map((submission, index) => {
      const module = course.modules.find((item) => item.id === Number(submission.module));
      return `<div class="admin-list-row">
        <span class="row-index">${String(index + 1).padStart(2, '0')}</span>
        <div><strong>${esc(submission.group)}</strong><small>${esc(module?.title || 'Etapa removida')} · ${esc(submission.members)}</small></div>
        <span class="row-meta">${submission.slides ? 'Slides vinculados' : 'Slides pendentes'}</span>
        <button class="row-action" data-remove-submission="${submission.id}" aria-label="Remover reserva do ${esc(submission.group)}">×</button>
      </div>`;
    }).join('') || '<div class="admin-list-row"><span class="row-index">—</span><div><strong>Nenhuma reserva ainda</strong><small>As apresentações cadastradas pelos alunos aparecem aqui.</small></div><span></span><span></span></div>';
    $$('[data-remove-submission]').forEach((button) => button.addEventListener('click', () => {
      course.submissions = submissions.filter((item) => item.id !== Number(button.dataset.removeSubmission));
      saveState('Reserva removida.');
      renderSubmissions();
      renderMetrics();
    }));
  }

  function renderPublication() {
    setText('#publishState', course.status === 'Publicada' ? 'Disciplina publicada' : course.status === 'Arquivada' ? 'Disciplina arquivada' : 'Rascunho privado');
    setText('#publishDetail', course.visibility);
    setText('#togglePublishButton', course.status === 'Publicada' ? 'Voltar para rascunho' : 'Publicar disciplina');
  }

  async function loadRemoteAdmin() {
    try {
      remoteCourse = await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}`);
      Object.assign(course, {
        title: remoteCourse.title,
        shortTitle: remoteCourse.short_title,
        semester: remoteCourse.semester,
        status: remoteCourse.status,
        visibility: remoteCourse.visibility,
        cover: remoteCourse.cover || course.cover,
        updatedAt: remoteCourse.updated_at
      });
      course.driveUrl = remoteCourse.drive_url || '';
      course.driveConnected = Boolean(remoteCourse.drive_connected);
      window.CourseStore.save(state);
      renderCourseTabs();
      populateForm();
      renderPublication();
      renderMetrics();
      renderDrive();
      renderClasses();
      renderStudents();
      renderUploads();
      if ($('#classDialog').open && editingSessionId) {
        const updatedSession = remoteCourse.sessions.find((item) => item.id === editingSessionId);
        renderManagedArticles(updatedSession);
        renderPresenterChecks();
      }
    } catch (error) {
      remoteCourse = null;
      renderClasses();
      renderUploads();
      console.warn('Banco SQLite indisponível; painel em modo local.', error);
    }
  }

  function renderAll() {
    setText('#breadcrumbCode', course.code);
    $('#studentViewLink').href = `index.html?curso=${encodeURIComponent(course.code)}`;
    renderCourseTabs();
    renderMetrics();
    populateForm();
    renderDrive();
    renderClasses();
    renderModules();
    renderStudents();
    renderSubmissions();
    renderUploads();
    renderPublication();
  }

  async function selectCourse(code) {
    course = window.CourseStore.getCourse(state, code);
    remoteCourse = null;
    currentCode = course.code;
    const url = new URL(window.location.href);
    url.searchParams.set('curso', currentCode);
    window.history.replaceState({}, '', url);
    renderAll();
    await loadRemoteAdmin();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveForm() {
    const form = $('#courseForm');
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form).entries());
    const nextCode = values.code.trim().toUpperCase();
    const duplicate = state.courses.some((item) => item !== course && item.code === nextCode);
    if (duplicate) {
      showToast(`Já existe uma disciplina com o código ${nextCode}.`);
      return;
    }
    Object.assign(course, values, { code: nextCode });
    course.driveUrl = $('#driveUrlInput').value.trim();
    course.driveConnected = Boolean(course.driveUrl);
    currentCode = course.code;
    saveState();
    try {
      await apiRequest(`/api/admin/courses/${encodeURIComponent(currentCode)}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: course.title, shortTitle: course.shortTitle, semester: course.semester,
          cover: course.cover, driveUrl: course.driveUrl, status: course.status,
          visibility: course.visibility
        })
      });
      await loadRemoteAdmin();
      showToast(`${course.code} salva no SQLite e atualizada para os alunos.`);
    } catch (error) {
      showToast(`Conteúdo salvo localmente. SQLite indisponível: ${error.message}`);
    }
    renderAll();
  }

  $('#saveButton').addEventListener('click', saveForm);
  $('#courseForm').addEventListener('submit', (event) => { event.preventDefault(); saveForm(); });
  $('#previewButton').addEventListener('click', () => window.open(`index.html?curso=${encodeURIComponent(course.code)}`, '_blank'));

  $('#syncDriveButton').addEventListener('click', async () => {
    const url = $('#driveUrlInput').value.trim();
    if (!url || !url.startsWith('https://drive.google.com/')) {
      showToast('Cole um link válido de pasta do Google Drive para conectar.');
      $('#driveUrlInput').focus();
      return;
    }
    course.driveUrl = url;
    course.driveConnected = true;
    saveState();
    try {
      await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}`, { method: 'PUT', body: JSON.stringify({ driveUrl: url }) });
      await loadRemoteAdmin();
      showToast('Drive conectado e salvo no SQLite.');
    } catch (error) { showToast(error.message); }
  });

  $('#togglePublishButton').addEventListener('click', async () => {
    course.status = course.status === 'Publicada' ? 'Rascunho' : 'Publicada';
    saveState();
    try {
      await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}`, { method: 'PUT', body: JSON.stringify({ status: course.status }) });
      await loadRemoteAdmin();
      showToast(course.status === 'Publicada' ? 'Disciplina publicada para a turma.' : 'Disciplina movida para rascunho.');
    } catch (error) { showToast(error.message); }
    renderAll();
  });

  $('#addModuleButton').addEventListener('click', () => $('#moduleDialog').showModal());
  $('#moduleForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    course.modules.push({
      id: Math.max(0, ...course.modules.map((item) => Number(item.id))) + 1,
      title: values.title.trim(),
      kicker: values.kicker.trim(),
      summary: values.summary.trim(),
      date: values.date.trim() || 'A definir',
      duration: '45 min',
      articles: Number(values.articles || 0),
      status: 'next'
    });
    saveState('Nova etapa criada na trilha.');
    $('#moduleDialog').close();
    event.currentTarget.reset();
    renderModules();
    renderMetrics();
  });

  $('#addClassButton').addEventListener('click', () => openClassDialog());
  $('#classForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const sessionId = Number(values.session_id || 0);
    delete values.session_id;
    try {
      const result = sessionId
        ? await apiRequest(`/api/admin/sessions/${sessionId}`, { method: 'PUT', body: JSON.stringify(values) })
        : await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}/sessions`, { method: 'POST', body: JSON.stringify(values) });
      editingSessionId = result.session.id;
      await loadRemoteAdmin();
      const updated = remoteCourse.sessions.find((item) => item.id === editingSessionId);
      event.currentTarget.elements.session_id.value = editingSessionId;
      $('#articleManager').hidden = false;
      renderManagedArticles(updated);
      renderPresenterChecks();
      showToast(sessionId ? 'Aula atualizada. O destaque dos alunos foi recalculado.' : 'Aula criada. Agora vincule os artigos e apresentadores.');
    } catch (error) { showToast(error.message); }
  });

  $('#articleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!editingSessionId) return;
    const formData = new FormData(event.currentTarget);
    const payload = {
      code: String(formData.get('code') || '').trim(),
      title: String(formData.get('title') || '').trim(),
      author: String(formData.get('author') || '').trim(),
      url: String(formData.get('url') || '').trim(),
      presenter_ids: formData.getAll('presenter_ids').map(Number)
    };
    try {
      await apiRequest(`/api/admin/sessions/${editingSessionId}/articles`, { method: 'POST', body: JSON.stringify(payload) });
      event.currentTarget.reset();
      await loadRemoteAdmin();
      const updated = remoteCourse.sessions.find((item) => item.id === editingSessionId);
      renderManagedArticles(updated);
      renderPresenterChecks();
      showToast('Artigo e apresentadores vinculados à aula.');
    } catch (error) { showToast(error.message); }
  });

  $('#studentForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (remoteCourse) {
      try {
        await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}/students`, {
          method: 'POST', body: JSON.stringify({ name: values.name, email: values.email, nusp: values.nusp, group_name: '—' })
        });
        event.currentTarget.reset();
        showToast(`${values.name} recebeu acesso a ${course.code}.`);
        await loadRemoteAdmin();
      } catch (error) { showToast(error.message); }
      return;
    }
    const duplicate = course.students.some((student) => student.nusp === values.nusp || student.email.toLowerCase() === values.email.toLowerCase());
    if (duplicate) { showToast('Esse e-mail ou Nº USP já está na lista.'); return; }
    course.students.push({ name: values.name.trim(), email: values.email.trim(), nusp: values.nusp.trim(), group: '—', access: true });
    saveState(`${values.name} recebeu acesso a ${course.code}.`);
    event.currentTarget.reset();
    renderStudents();
    renderMetrics();
  });

  $('#importStudentsButton').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.txt';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const rows = (await file.text()).split(/\r?\n/).filter(Boolean);
      const candidates = [];
      let imported = 0;
      rows.forEach((row, index) => {
        if (index === 0 && /nome|email|usp/i.test(row)) return;
        const columns = row.split(/[;,\t]/).map((column) => column.trim());
        if (columns.length < 3) return;
        const [name, email, nusp, group = '—'] = columns;
        if (!name || !email || !/^\d{7,10}$/.test(nusp)) return;
        candidates.push({ name, email, nusp, group });
      });
      if (remoteCourse) {
        for (const candidate of candidates) {
          try {
            await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}/students`, {
              method: 'POST', body: JSON.stringify({ ...candidate, group_name: candidate.group })
            });
            imported += 1;
          } catch (error) {
            if (error.status !== 409) console.warn('Falha ao importar aluno.', error);
          }
        }
        if (imported) await loadRemoteAdmin();
      } else {
        candidates.forEach(({ name, email, nusp, group }) => {
          if (course.students.some((student) => student.email.toLowerCase() === email.toLowerCase() || student.nusp === nusp)) return;
          course.students.push({ name, email, nusp, group, access: true });
          imported += 1;
        });
      }
      if (imported) {
        if (!remoteCourse) saveState();
        showToast(`${imported} aluno${imported === 1 ? '' : 's'} importado${imported === 1 ? '' : 's'} do CSV.`);
        renderStudents();
        renderMetrics();
      } else {
        showToast('Nenhum aluno novo encontrado. Use colunas: nome, e-mail, Nº USP e grupo.');
      }
    });
    input.click();
  });

  $('#newCourseButton').addEventListener('click', () => $('#newCourseDialog').showModal());
  $('#newCourseForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const code = values.code.trim().toUpperCase();
    if (state.courses.some((item) => item.code === code)) {
      showToast(`${code} já está cadastrada.`);
      return;
    }
    const newCourse = {
      code,
      title: values.title.trim(),
      shortTitle: values.title.trim(),
      semester: values.semester.trim(),
      status: 'Rascunho',
      visibility: 'Somente alunos cadastrados',
      progress: 0,
      credits: 4,
      workload: '60 h',
      classDay: 'A definir',
      room: 'A definir',
      professor: 'Profa. Dra. Lídia Rebello Dias',
      updatedAt: 'Agora',
      cover: 'assets/course-pea5004.webp',
      accent: '#56d6ca',
      driveUrl: values.driveUrl.trim(),
      driveConnected: Boolean(values.driveUrl.trim()),
      driveEmail: 'lidia.rebello.dias@usp.br',
      description: 'Uma nova rota de aprendizagem está sendo preparada.',
      ementa: 'Cadastre a ementa desta disciplina.',
      objectives: ['Cadastrar o primeiro objetivo de aprendizagem.'],
      folders: [
        { name: '01. Sobre o curso', detail: 'Ementa e cronograma', count: 0 },
        { name: '02. Textos', detail: 'Leituras de apoio', count: 0 },
        { name: '03. Entregas', detail: 'Trabalhos da turma', count: 0 }
      ],
      modules: [], readings: [], presentationTips: ['Abra com o problema.'], students: [], submissions: []
    };
    try {
      await apiRequest('/api/admin/courses', {
        method: 'POST',
        body: JSON.stringify({ code, title: newCourse.title, short_title: newCourse.shortTitle, semester: newCourse.semester, cover: newCourse.cover, drive_url: newCourse.driveUrl })
      });
    } catch (error) {
      if (error.status !== 404) { showToast(error.message); return; }
    }
    state.courses.push(newCourse);
    window.CourseStore.save(state);
    $('#newCourseDialog').close();
    event.currentTarget.reset();
    course = newCourse;
    currentCode = code;
    renderAll();
    await loadRemoteAdmin();
    showToast(`${code} criada como rascunho.`);
  });

  $$('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));

  $('#resetButton').addEventListener('click', async () => {
    if (!window.confirm('Recarregar o conteúdo editorial inicial? A agenda, os alunos e os materiais do SQLite serão preservados.')) return;
    state = window.CourseStore.reset();
    course = window.CourseStore.getCourse(state, 'PEA5004');
    currentCode = course.code;
    renderAll();
    await loadRemoteAdmin();
    showToast('Conteúdo editorial recarregado. Os dados do SQLite foram preservados.');
  });

  const navLinks = $$('.admin-nav a');
  const sections = navLinks.map((link) => document.querySelector(link.getAttribute('href'))).filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.find((entry) => entry.isIntersecting);
    if (!visible) return;
    navLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`));
  }, { rootMargin: '-20% 0px -70%', threshold: 0 });
  sections.forEach((section) => observer.observe(section));

  async function bootstrap() {
    try {
      const catalog = await apiRequest('/api/courses');
      catalog.forEach((item) => {
        if (state.courses.some((local) => local.code === item.code)) return;
        state.courses.push({
          code: item.code, title: item.title, shortTitle: item.short_title, semester: item.semester,
          status: item.status, visibility: item.visibility, progress: 0, credits: 4, workload: '60 h',
          classDay: 'A definir', room: 'A definir', professor: 'Profa. Dra. Lídia Rebello Dias',
          updatedAt: item.updated_at, cover: item.cover || 'assets/course-pea5004.webp', accent: '#56d6ca',
          driveUrl: item.drive_url, driveConnected: Boolean(item.drive_connected),
          driveEmail: 'lidia.rebello.dias@usp.br', description: 'Uma nova rota de aprendizagem.',
          ementa: 'Cadastre a ementa desta disciplina.', objectives: ['Cadastrar o primeiro objetivo.'],
          folders: [{ name: '01. Sobre o curso', detail: 'Ementa e cronograma', count: 0 }],
          modules: [], readings: [], presentationTips: ['Abra com o problema.'], students: [], submissions: []
        });
      });
      window.CourseStore.save(state);
      course = window.CourseStore.getCourse(state, (params.get('curso') || currentCode).toUpperCase());
      currentCode = course.code;
    } catch (error) {
      console.warn('Catálogo SQLite indisponível.', error);
    }
    renderAll();
    await loadRemoteAdmin();
  }

  bootstrap();
}());
