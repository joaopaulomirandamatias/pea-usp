(function () {
  'use strict';

  let state = window.CourseStore.load();
  const params = new URLSearchParams(window.location.search);
  let currentCode = (params.get('curso') || 'PEA5004').toUpperCase();
  let course = window.CourseStore.getCourse(state, currentCode);
  currentCode = course.code;
  let remoteCourse = null;
  let editingSessionId = null;
  let currentTeacher = null;
  let toastTimer;
  const adminTokenKey = 'rota-admin-token';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

  async function apiRequest(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const adminToken = sessionStorage.getItem(adminTokenKey);
    if (adminToken && path.startsWith('/api/')) headers.Authorization = `Bearer ${adminToken}`;
    const response = await fetch(path, { ...options, headers });
    let payload = {};
    try { payload = await response.json(); } catch (error) { payload = {}; }
    if (!response.ok) {
      const requestError = new Error(payload.error || `Falha na requisição (${response.status}).`);
      requestError.status = response.status;
      if (response.status === 401 && path !== '/api/admin/login') openAdminLogin();
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

  function openAdminLogin() {
    const dialog = $('#adminLoginDialog');
    document.body.classList.add('admin-locked');
    $('#adminLoginError').textContent = '';
    if (!dialog.open) dialog.showModal();
    setTimeout(() => dialog.querySelector('input[name="password"]').focus(), 0);
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

  function revealSecret({ eyebrow = 'Token criado', title = 'Copie agora.', copy = 'Este segredo só será exibido uma vez.', value }) {
    setText('#secretRevealEyebrow', eyebrow);
    setText('#secretRevealTitle', title);
    setText('#secretRevealCopy', copy);
    setText('#secretRevealValue', value);
    $('#secretRevealDialog').showModal();
  }

  function setAdminView(view) {
    const allowed = ['visao', 'disciplinas', 'aulas', 'pessoas', 'conteudo', 'configuracoes'];
    const activeView = allowed.includes(view) ? view : 'visao';
    document.body.dataset.adminActiveView = activeView;
    $$('[data-admin-view]').forEach((element) => {
      element.hidden = !element.dataset.adminView.split(/\s+/).includes(activeView);
    });
    $$('[data-admin-route]').forEach((link) => link.classList.toggle('active', link.dataset.adminRoute === activeView));
    renderCourseTabs();
    if (activeView === 'aulas' && String(course.status).toLowerCase() !== 'publicada') {
      const publishedCourse = state.courses.find((item) => String(item.status).toLowerCase() === 'publicada');
      if (publishedCourse && publishedCourse.code !== course.code) void selectCourse(publishedCourse.code);
    }
    if (window.location.hash !== `#${activeView}`) window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}#${activeView}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderCourseTabs() {
    const scheduleView = document.body.dataset.adminActiveView === 'aulas';
    $('#courseTabs').innerHTML = state.courses.map((item) => {
      const inactive = scheduleView && String(item.status).toLowerCase() !== 'publicada';
      return `
      <button class="admin-course-tab ${item.code === course.code ? 'active' : ''} ${inactive ? 'course-inactive' : ''}" data-course="${esc(item.code)}" style="background-image:url('${esc(item.cover)}')" ${inactive ? 'disabled aria-disabled="true" title="Ative esta disciplina na seção Disciplinas para gerenciar aulas e artigos"' : ''}>
        <span class="course-card-code">${esc(item.code)} · ${esc(item.semester)}</span>
        <strong>${esc(item.shortTitle)}</strong>
        <span class="course-card-state">${esc(item.status)}</span>
        <span class="course-card-action">${inactive ? 'Ative em Disciplinas' : item.code === course.code ? 'Em gestão agora' : 'Gerenciar disciplina'} <b aria-hidden="true">${inactive ? '⊘' : '→'}</b></span>
      </button>
    `; }).join('');
    $$('.admin-course-tab:not(:disabled)').forEach((button) => button.addEventListener('click', () => selectCourse(button.dataset.course)));
  }

  function mergeCourseCatalog(catalog) {
    catalog.forEach((item) => {
      const existing = state.courses.find((local) => local.code === item.code);
      const serverFields = {
        code: item.code, title: item.title, shortTitle: item.short_title, semester: item.semester,
        status: item.status, visibility: item.visibility, updatedAt: item.updated_at,
        cover: item.cover || existing?.cover || 'assets/course-pea5004.webp',
        coverMediaType: item.cover_media_type || existing?.coverMediaType || 'image',
        coverVideo: item.cover_video ?? existing?.coverVideo ?? '',
        driveUrl: item.drive_url ?? existing?.driveUrl ?? '', driveConnected: Boolean(item.drive_connected)
      };
      if (existing) {
        Object.assign(existing, serverFields);
        return;
      }
      state.courses.push({
        ...serverFields, progress: 0, credits: 4, workload: '60 h', classDay: 'A definir', room: 'A definir',
        professor: 'Profa. Dra. Lídia Rebello Dias', accent: '#56d6ca', driveEmail: 'lidia.rebello.dias@usp.br',
        description: 'Uma nova rota de aprendizagem.', ementa: 'Cadastre a ementa desta disciplina.',
        objectives: ['Cadastrar o primeiro objetivo.'],
        folders: [{ name: '01. Sobre o curso', detail: 'Ementa e cronograma', count: 0 }],
        modules: [], readings: [], presentationTips: ['Abra com o problema.'], students: [], submissions: []
      });
    });
    window.CourseStore.save(state);
  }

  async function syncAdminCatalog() {
    const authenticated = Boolean(sessionStorage.getItem(adminTokenKey));
    const catalog = await apiRequest(authenticated ? '/api/admin/courses' : '/api/courses');
    mergeCourseCatalog(catalog);
    return catalog;
  }

  function renderMetrics() {
    const remoteStudents = remoteCourse?.students || [];
    const activeStudents = remoteCourse ? remoteStudents.filter((student) => student.active).length : course.students.filter((student) => student.access).length;
    const driveItems = remoteCourse?.stats?.drive_items ?? course.folders.reduce((sum, folder) => sum + Number(folder.count || 0), 0);
    const submissions = course.submissions || [];
    setText('#studentMetric', activeStudents);
    setText('#studentMetricDetail', `${remoteCourse ? remoteStudents.length : course.students.length} na lista atual`);
    setText('#moduleMetric', remoteCourse?.stats?.classes ?? course.modules.length);
    setText('#moduleMetricDetail', remoteCourse?.next_class ? `${formatClassDate(remoteCourse.next_class.session_date, { day: '2-digit', month: 'short' })} · próxima aula` : 'nenhuma aula futura');
    setText('#driveMetric', driveItems);
    setText('#driveMetricDetail', remoteCourse?.drive_sync_status === 'syncing' ? 'sincronizando agora' : course.driveConnected ? 'itens sincronizados' : 'sincronização pendente');
    setText('#submissionMetric', remoteCourse?.stats?.uploads ?? submissions.length);
    setText('#submissionMetricDetail', remoteCourse ? 'materiais recebidos' : (submissions.length === 1 ? 'grupo reservado' : 'grupos reservados'));
  }

  function renderOverviewAgenda() {
    const board = $('#overviewAgendaBoard');
    if (!board) return;
    const session = remoteCourse?.next_class;

    if (!session) {
      setText('#overviewAgendaKicker', 'Agenda operacional');
      setText('#overviewAgendaHeading', 'Próxima aula');
      setText('#overviewAgendaSummary', remoteCourse ? `${course.code} não possui outra aula futura cadastrada.` : 'A agenda será atualizada assim que os dados da disciplina forem carregados.');
      board.innerHTML = `<div class="overview-agenda-empty">
        <span aria-hidden="true">＋</span>
        <div><strong>${remoteCourse ? 'O calendário está livre daqui em diante.' : 'Conectando ao calendário da disciplina…'}</strong><p>${remoteCourse ? 'Cadastre a próxima data para ativar o roteiro automático da aula.' : 'Se a conexão não estiver disponível, os demais dados locais continuam preservados.'}</p></div>
        ${remoteCourse ? '<button class="admin-button primary" type="button" data-overview-new-class>+ Agendar aula</button>' : ''}
      </div>`;
      $('[data-overview-new-class]')?.addEventListener('click', () => openClassDialog());
      return;
    }

    const today = todayInCourseTimezone();
    const classDate = dateFromISO(session.session_date);
    const dayDifference = Math.round((classDate - today) / 86400000);
    const temporalLabel = dayDifference === 0 ? 'Acontece hoje' : dayDifference === 1 ? 'Acontece amanhã' : `Em ${dayDifference} dias`;
    const heading = dayDifference === 0 ? 'Agenda de hoje' : 'Próxima aula';
    const articles = session.articles || [];
    const articleAssignments = articles.map((article) => {
      const names = [...new Set([
        ...(article.presenters || []).map((student) => student.name),
        article.reservation?.student_name
      ].filter(Boolean))];
      return { ...article, presenterNames: names };
    });
    const presenterNames = [...new Set(articleAssignments.flatMap((article) => article.presenterNames))];
    const assignedArticles = articleAssignments.filter((article) => article.presenterNames.length).length;
    const articleRows = articleAssignments.slice(0, 3).map((article) => `<li>
      <span>${esc(article.code || 'ART')}</span>
      <div><strong>${esc(article.title)}</strong><small>${article.presenterNames.length ? esc(article.presenterNames.join(', ')) : 'Ainda sem apresentador'}</small></div>
    </li>`).join('');
    const additionalArticles = Math.max(0, articleAssignments.length - 3);
    const time = String(session.start_time || '').slice(0, 5) || 'Horário a definir';
    const location = session.location || course.room || 'Local a definir';
    const month = formatClassDate(session.session_date, { month: 'short' }).replace('.', '').toUpperCase();
    const weekday = formatClassDate(session.session_date, { weekday: 'long' });

    setText('#overviewAgendaKicker', temporalLabel);
    setText('#overviewAgendaHeading', heading);
    setText('#overviewAgendaSummary', `${course.code} · ${weekday}, ${formatClassDate(session.session_date, { day: '2-digit', month: 'long' })} às ${time}.`);
    board.innerHTML = `
      <div class="overview-agenda-date" aria-label="${esc(formatClassDate(session.session_date, { dateStyle: 'full' }))}">
        <small>${esc(month)}</small>
        <strong>${esc(formatClassDate(session.session_date, { day: '2-digit' }))}</strong>
        <span>${esc(formatClassDate(session.session_date, { year: 'numeric' }))}</span>
        <i></i>
        <time datetime="${esc(session.session_date)}T${esc(time)}">${esc(time)}</time>
      </div>
      <div class="overview-agenda-content">
        <span class="overview-theme">${esc(session.theme || 'Tema a definir')}</span>
        <h3>${esc(session.title)}</h3>
        <p class="overview-agenda-meta"><span>◷ ${esc(time)}</span><span>⌖ ${esc(location)}</span><span>${session.meet_url ? '● Meet configurado' : '○ Meet pendente'}</span></p>
        <div class="overview-moments">
          <article>
            <span>01 / Conversa com especialista</span>
            <strong>${esc(session.specialist_name || 'Especialista a confirmar')}</strong>
            <p>${esc(session.specialist_topic || session.specialist_role || 'Tema e informações profissionais ainda não cadastrados.')}</p>
          </article>
          <article>
            <span>02 / Apresentação dos alunos</span>
            <strong>${articles.length ? `${articles.length} artigo${articles.length === 1 ? '' : 's'} · ${assignedArticles} com responsável` : 'Artigos a definir'}</strong>
            ${articleRows ? `<ul class="overview-article-roster">${articleRows}</ul>${additionalArticles ? `<small class="overview-more-articles">+ ${additionalArticles} artigo${additionalArticles === 1 ? '' : 's'} na pauta</small>` : ''}` : '<p>Nenhum artigo foi vinculado a esta aula.</p>'}
          </article>
        </div>
      </div>
      <aside class="overview-agenda-actions">
        <div class="overview-agenda-status"><span></span><small>Roteiro ativo</small><strong>${esc(temporalLabel)}</strong></div>
        <dl><div><dt>Apresentadores</dt><dd>${presenterNames.length || '—'}</dd></div><div><dt>Artigos</dt><dd>${articles.length || '—'}</dd></div></dl>
        <button class="admin-button primary" type="button" data-overview-edit-class="${session.id}">Editar esta aula</button>
        <button class="admin-button" type="button" data-overview-open-schedule>Ver agenda completa</button>
      </aside>`;

    $('[data-overview-edit-class]')?.addEventListener('click', () => openClassDialog(session.id));
    $('[data-overview-open-schedule]')?.addEventListener('click', () => setAdminView('aulas'));
  }

  function renderCoverPreview() {
    const editor = $('#courseCoverEditor');
    const video = $('#courseCoverVideo');
    editor.style.backgroundImage = `url('${course.cover}')`;
    const useVideo = course.coverMediaType === 'video' && Boolean(course.coverVideo);
    video.hidden = !useVideo;
    if (useVideo) {
      if (video.getAttribute('src') !== course.coverVideo) video.src = course.coverVideo;
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) void video.play().catch(() => {});
    } else {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  function populateForm() {
    const form = $('#courseForm');
    ['code', 'semester', 'title', 'shortTitle', 'description', 'ementa', 'classDay', 'room', 'cover', 'coverMediaType', 'coverVideo', 'status', 'visibility'].forEach((field) => {
      if (form.elements[field]) form.elements[field].value = course[field] || '';
    });
    renderCoverPreview();
    setText('#coverCode', course.code);
    setText('#coverTitle', course.shortTitle);
    setText('#courseStatusLabel', course.status);
    const catalogLink = $('#catalogSourceLink');
    catalogLink.hidden = !course.catalogUrl;
    if (course.catalogUrl) catalogLink.href = course.catalogUrl;
    if (remoteCourse) {
      $('#publicOverview').checked = Boolean(remoteCourse.public_overview);
      $('#publicSchedule').checked = Boolean(remoteCourse.public_schedule);
      $('#publicArticles').checked = Boolean(remoteCourse.public_articles);
      $('#publicResources').checked = Boolean(remoteCourse.public_resources);
      $('#publicChat').checked = Boolean(remoteCourse.public_chat);
      const scale = Object.fromEntries((remoteCourse.grade_scale || []).map((item) => [item.letter, item.min]));
      ['A', 'B', 'C'].forEach((letter) => {
        if ($('#gradeScaleForm').elements[letter]) $('#gradeScaleForm').elements[letter].value = scale[letter] ?? { A: 8.5, B: 7, C: 5 }[letter];
      });
    }
  }

  function renderDrive() {
    const status = remoteCourse?.drive_sync_status || (course.driveConnected ? 'synced' : 'pending');
    const connected = status === 'synced' && Boolean(course.driveUrl);
    const syncing = status === 'syncing';
    const materials = remoteCourse?.drive_materials || [];
    const statusLabels = { synced: 'Sincronizado', syncing: 'Sincronizando', error: 'Falha no vínculo', credentials_required: 'Credencial necessária', pending: 'Aguardando vínculo' };
    setText('#driveStatusLabel', statusLabels[status] || 'Aguardando vínculo');
    setText('#driveStateTitle', connected ? `${materials.length} arquivo${materials.length === 1 ? '' : 's'} no sistema` : syncing ? 'Copiando materiais do Drive' : course.driveUrl ? 'Pasta cadastrada, ainda não sincronizada' : 'Pasta não vinculada');
    const serviceEmail = remoteCourse?.drive_service_account_email;
    setText('#driveStateDetail', serviceEmail ? `Compartilhe a pasta com ${serviceEmail}` : remoteCourse?.drive_sync_configured ? 'Acesso Google configurado no servidor' : 'Configure a conta de serviço no Railway');
    $('#driveUrlInput').value = course.driveUrl || '';
    $('#driveFolderList').innerHTML = materials.slice(0, 8).map((item) => `<div class="drive-folder"><span>${esc(item.relative_path ? `${item.relative_path} / ${item.name}` : item.name)}</span><span>✓</span></div>`).join('') || course.folders.map((folder) => `<div class="drive-folder"><span>${esc(folder.name)}</span><span>—</span></div>`).join('');
    const message = remoteCourse?.drive_sync_error
      || (remoteCourse?.drive_last_synced_at ? `Última sincronização: ${new Date(`${remoteCourse.drive_last_synced_at}Z`).toLocaleString('pt-BR')}. Os arquivos ficam no armazenamento persistente da plataforma.`
        : serviceEmail ? `Compartilhe a pasta com ${serviceEmail} e clique em sincronizar.` : 'A sincronização exige GOOGLE_SERVICE_ACCOUNT_JSON no Railway. O link sozinho não libera uma pasta privada.');
    setText('#driveSyncMessage', message);
    $('#driveSyncMessage').classList.toggle('error', status === 'error' || status === 'credentials_required');
    $('#syncDriveButton').textContent = syncing ? 'Sincronizando…' : connected ? 'Sincronizar alterações' : 'Validar e sincronizar';
    $('#syncDriveButton').disabled = syncing;
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
        <div><strong>${esc(session.title)}</strong><small>${esc(session.theme || 'Tema a definir')} · ${session.articles.length} artigo${session.articles.length === 1 ? '' : 's'}${presenters.length ? ` · ${esc(presenters.join(', '))}` : ''}</small><span class="meet-admin-pill ${session.meet_url ? 'ready' : ''}">${session.meet_url ? 'Meet protegido configurado' : 'Meet não informado'}</span><span class="choice-admin-pill ${session.student_choice_enabled ? 'ready' : ''}">${session.student_choice_enabled ? `Escolha aberta${session.submission_deadline ? ` · até ${new Date(session.submission_deadline).toLocaleString('pt-BR')}` : ''}` : 'Escolha fechada'}</span></div>
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
      const reservation = article.reservation?.student_name || presenters;
      return `<article class="managed-article"><span>${esc(article.code || 'ART')}</span><div><strong>${esc(article.title)}</strong><small>${esc(article.author || 'Autoria a definir')} · ${reservation ? `Escolhido por ${esc(reservation)}` : 'Disponível para escolha'}</small></div><button class="row-action" data-remove-article="${article.id}" aria-label="Remover ${esc(article.title)}">×</button></article>`;
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
    $('#specialistInviteManager').hidden = !session;
    $('#adminRoomManager').hidden = !session;
    if (session) {
      ['session_date', 'start_time', 'title', 'theme', 'location', 'meet_url', 'specialist_name', 'specialist_role', 'specialist_topic', 'notes', 'submission_deadline'].forEach((field) => {
        form.elements[field].value = session[field] || '';
      });
      form.elements.student_choice_enabled.checked = Boolean(session.student_choice_enabled);
      const specialist = session.specialist || {};
      form.elements.specialist_email.value = specialist.email || '';
      form.elements.specialist_linkedin.value = specialist.linkedin || '';
      form.elements.specialist_whatsapp.value = specialist.whatsapp || '';
      form.elements.specialist_website.value = specialist.website || '';
      form.elements.session_id.value = session.id;
      renderManagedArticles(session);
      renderPresenterChecks();
      loadAdminRoom(session.id);
    }
    $('#classDialog').showModal();
  }

  async function loadAdminRoom(sessionId = editingSessionId) {
    if (!sessionId) return;
    try {
      const room = await apiRequest(`/api/courses/${encodeURIComponent(course.code)}/sessions/${sessionId}/room`);
      setText('#adminRoomResourceCount', `${room.resources.length} ${room.resources.length === 1 ? 'item' : 'itens'}`);
      $('#adminRoomResourceList').innerHTML = room.resources.map((item) => `<article class="room-resource"><span>${item.resource_type === 'slide' ? '▱' : '↗'}</span><div><small>${esc(item.author_name)} · ${esc(item.visibility)}</small><strong>${esc(item.title)}</strong>${item.content_html ? `<div>${item.content_html}</div>` : ''}</div>${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Abrir ↗</a>` : ''}</article>`).join('') || '<p class="room-empty">Nenhum material cadastrado.</p>';
      $('#adminRoomCommentList').innerHTML = room.comments.map((item) => `<article class="room-comment"><div><strong>${esc(item.author_name)}</strong><span>${esc(item.author_role)}</span></div><div>${item.content_html}</div></article>`).join('') || '<p class="room-empty">O mural ainda está vazio.</p>';
    } catch (error) { showToast(error.message); }
  }

  function renderUploads() {
    const uploads = remoteCourse?.uploads || [];
    setText('#uploadCountLabel', `${uploads.length} ${uploads.length === 1 ? 'arquivo' : 'arquivos'}`);
    $('#uploadAdminList').innerHTML = uploads.map((upload) => {
      const extension = upload.filename.includes('.') ? upload.filename.split('.').pop() : 'arq';
      const size = upload.size_bytes < 1024 * 1024 ? `${Math.max(1, Math.round(upload.size_bytes / 1024))} KB` : `${(upload.size_bytes / 1024 / 1024).toFixed(1)} MB`;
      return `<div class="admin-list-row upload-admin-row"><span class="file-badge">${esc(extension)}</span><div><strong>${esc(upload.filename)}</strong><small>${esc(upload.student_name)} · ${esc(upload.deliverable_type_name || 'Tipo não informado')} · ${esc(upload.description || 'Sem descrição')}</small></div><div class="upload-context"><strong>${esc(upload.assessment_title || upload.session_title || 'Material geral')}</strong><br>${esc(upload.article_title || (upload.assessment_title ? 'Entrega de atividade' : 'Sem artigo específico'))}</div><div class="upload-file-actions"><span class="file-size">${size}</span><button class="row-action" type="button" data-download-upload="${upload.id}">Baixar</button></div></div>`;
    }).join('') || '<div class="admin-list-row"><span class="row-index">—</span><div><strong>Nenhum material recebido</strong><small>Os arquivos enviados pelos alunos aparecerão aqui.</small></div><span></span><span></span></div>';
    $$('[data-download-upload]').forEach((button) => button.addEventListener('click', async () => {
      const upload = uploads.find((item) => item.id === Number(button.dataset.downloadUpload));
      if (!upload) return;
      button.disabled = true;
      try {
        const response = await fetch(`/api/admin/uploads/${upload.id}/download`, {
          headers: { Authorization: `Bearer ${sessionStorage.getItem(adminTokenKey) || ''}` }
        });
        if (!response.ok) {
          let message = 'Não foi possível baixar este material.';
          try { message = (await response.json()).error || message; } catch (error) { /* arquivo não JSON */ }
          throw new Error(message);
        }
        const href = URL.createObjectURL(await response.blob());
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = upload.filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      } catch (error) { showToast(error.message); }
      finally { button.disabled = false; }
    }));
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
        <td><button class="token-reset-button" data-reset-token="${student.id}">${student.access_token_hint ? `••••${esc(student.access_token_hint)}` : 'Gerar token'}</button></td>
        <td><button class="access-pill ${student.active ? '' : 'off'}" data-toggle-student="${student.id}">${student.active ? 'Liberado' : 'Bloqueado'}</button></td>
        <td><button class="row-action" data-remove-student="${student.id}" aria-label="Remover ${esc(student.name)}">×</button></td>
      </tr>
    `).join('') || '<tr><td colspan="6">Nenhum aluno cadastrado nesta disciplina.</td></tr>';

    $$('[data-reset-token]').forEach((button) => button.addEventListener('click', async () => {
      const student = students.find((item) => item.id === Number(button.dataset.resetToken));
      if (!student) return;
      if (student.access_token_hint && !window.confirm(`Gerar um novo token para ${student.name}? O token anterior deixará de funcionar.`)) return;
      try {
        const result = await apiRequest(`/api/admin/students/${student.id}/token`, { method: 'POST', body: '{}' });
        revealSecret({
          eyebrow: 'Token do aluno', title: `Acesso de ${student.name}`,
          copy: 'Envie este token ao aluno por um canal seguro. Ele não será mostrado novamente.',
          value: result.access_token
        });
        await loadRemoteAdmin();
      } catch (error) { showToast(error.message); }
    }));

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
    const submissions = remoteCourse?.presentations || course.submissions || [];
    $('#submissionList').innerHTML = submissions.map((submission, index) => {
      const target = remoteCourse
        ? (submission.article_title ? `${submission.article_code || 'ART'} · ${submission.article_title}` : submission.session_title || 'Trabalho final')
        : course.modules.find((item) => item.id === Number(submission.module))?.title || 'Etapa removida';
      const groupName = submission.group_name || submission.group;
      const slides = submission.slides_url || submission.slides;
      return `<div class="admin-list-row">
        <span class="row-index">${String(index + 1).padStart(2, '0')}</span>
        <div><strong>${esc(groupName)}</strong><small>${esc(target)} · ${esc(submission.members)}${submission.topic ? ` · ${esc(submission.topic)}` : ''}</small></div>
        <span class="row-meta">${slides ? 'Slides vinculados' : 'Slides pendentes'}</span>
        <button class="row-action" data-remove-submission="${submission.id}" aria-label="Remover reserva do ${esc(groupName)}">×</button>
      </div>`;
    }).join('') || '<div class="admin-list-row"><span class="row-index">—</span><div><strong>Nenhuma reserva ainda</strong><small>As apresentações cadastradas pelos alunos aparecem aqui.</small></div><span></span><span></span></div>';
    $$('[data-remove-submission]').forEach((button) => button.addEventListener('click', async () => {
      if (remoteCourse) {
        try {
          await apiRequest(`/api/admin/presentations/${button.dataset.removeSubmission}`, { method: 'DELETE' });
          await loadRemoteAdmin();
          showToast('Reserva removida.');
        } catch (error) { showToast(error.message); }
        return;
      }
      course.submissions = submissions.filter((item) => item.id !== Number(button.dataset.removeSubmission));
      saveState('Reserva removida.');
      renderSubmissions();
      renderMetrics();
    }));
  }

  function renderDeliverableTypes() {
    const types = remoteCourse?.deliverable_types || [];
    const assessmentType = $('#assessmentDeliverableType');
    const selectedType = assessmentType.value;
    assessmentType.innerHTML = '<option value="">Selecione um tipo</option>' + types.map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
    if (types.some((item) => String(item.id) === selectedType)) assessmentType.value = selectedType;
    $('#deliverableTypeList').innerHTML = types.map((item) => `<div class="deliverable-type-chip"><span>${esc(item.name)}</span><button type="button" data-remove-deliverable="${item.id}" aria-label="Remover ${esc(item.name)}">×</button></div>`).join('') || '<p class="next-article-empty">Nenhum tipo de entrega cadastrado.</p>';
    $$('[data-remove-deliverable]').forEach((button) => button.addEventListener('click', async () => {
      try {
        await apiRequest(`/api/admin/deliverables/${button.dataset.removeDeliverable}`, { method: 'DELETE' });
        await loadRemoteAdmin();
        showToast('Tipo de entrega removido. Materiais antigos foram preservados.');
      } catch (error) { showToast(error.message); }
    }));
  }

  const assessmentKinds = {
    review: 'Resenha', presentation: 'Apresentação', participation: 'Participação e perguntas',
    article: 'Artigo', final_work: 'Trabalho final', other: 'Outra'
  };

  function conceptBadge(summary) {
    const concept = summary?.concept;
    if (!concept) return `<span class="grade-letter pending" title="${summary?.graded_count || 0} de ${summary?.total_count || 0} avaliações corrigidas">…</span>`;
    return `<span class="grade-letter grade-${esc(concept.toLowerCase())}" title="Resultado final ${Number(summary.score).toFixed(1)}">${esc(concept)}</span>`;
  }

  function renderAssessments() {
    const assessments = remoteCourse?.assessments || [];
    const students = (remoteCourse?.students || []).filter((student) => student.active);
    const summaries = remoteCourse?.student_grade_summaries || {};
    const totalWeight = assessments.filter((item) => item.active).reduce((sum, item) => sum + Number(item.weight || 0), 0);
    const activeSummaries = students.map((student) => summaries[String(student.id)]).filter(Boolean);
    const readyToPublish = Boolean(assessments.some((item) => item.active) && students.length && activeSummaries.length === students.length && activeSummaries.every((summary) => summary.complete));
    const resultsPublished = Boolean(remoteCourse?.grade_results_published);
    setText('#assessmentWeightLabel', `${totalWeight.toLocaleString('pt-BR')}% configurado${Math.abs(totalWeight - 100) < .01 ? ' · completo' : ''}`);
    $('#assessmentWeightLabel').classList.toggle('weight-warning', Boolean(assessments.length && Math.abs(totalWeight - 100) >= .01));
    setText('#publishGradeResults', resultsPublished ? 'Resultados publicados' : readyToPublish ? 'Publicar resultados' : 'Corrija todas as notas');
    $('#publishGradeResults').disabled = !resultsPublished && !readyToPublish;
    $('#publishGradeResults').classList.toggle('published', resultsPublished);
    $('#assessmentList').innerHTML = assessments.map((assessment, index) => {
      const grades = new Map((assessment.grades || []).map((grade) => [Number(grade.student_id), grade]));
      const kindOptions = Object.entries(assessmentKinds).map(([value, label]) => `<option value="${value}" ${assessment.kind === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
      const deliverableOptions = '<option value="">Sem arquivo obrigatório</option>' + (remoteCourse?.deliverable_types || []).map((item) => `<option value="${item.id}" ${Number(assessment.deliverable_type_id) === Number(item.id) ? 'selected' : ''}>${esc(item.name)}</option>`).join('');
      const roster = students.map((student) => {
        const grade = grades.get(Number(student.id));
        const summary = summaries[String(student.id)];
        return `<form class="grade-row" data-assessment-id="${assessment.id}" data-student-id="${student.id}">
          <div class="grade-student">${conceptBadge(summary)}<span><strong>${esc(student.name)}</strong><small>Nº USP ${esc(student.nusp)}</small></span></div>
          <label>Nota<input name="score" type="number" min="0" max="${assessment.max_score}" step="0.01" value="${grade?.score ?? ''}" placeholder="—"></label>
          <label>Devolutiva<input name="feedback" maxlength="4000" value="${esc(grade?.feedback || '')}" placeholder="Comentário para o aluno"></label>
          <button class="admin-button" type="submit">${grade ? 'Atualizar' : 'Lançar nota'}</button>
        </form>`;
      }).join('') || '<p class="assessment-empty">Cadastre alunos para lançar as notas.</p>';
      return `<article class="assessment-card ${assessment.active ? '' : 'inactive'}">
        <header class="assessment-card-head"><span class="assessment-index">${String(index + 1).padStart(2, '0')}</span><div><small>${esc(assessmentKinds[assessment.kind] || 'Avaliação')}</small><h3>${esc(assessment.name)}</h3></div><div class="assessment-weight"><strong>${Number(assessment.weight).toLocaleString('pt-BR')}%</strong><small>peso · máx. ${Number(assessment.max_score).toLocaleString('pt-BR')}</small></div></header>
        <form class="assessment-settings" data-assessment-settings="${assessment.id}">
          <label>Nome<input name="name" value="${esc(assessment.name)}" required maxlength="120"></label>
          <label>Tipo<select name="kind">${kindOptions}</select></label>
          <label>Máxima<input name="max_score" type="number" min="0.1" max="1000" step="0.1" value="${assessment.max_score}" required></label>
          <label>Peso<input name="weight" type="number" min="0" max="100" step="0.1" value="${assessment.weight}" required></label>
          <label>Prazo<input name="due_at" type="datetime-local" value="${esc(assessment.due_at || '')}"></label>
          <label class="assessment-settings-upload"><input name="requires_upload" type="checkbox" ${assessment.requires_upload ? 'checked' : ''}> Exigir arquivo</label>
          <label>Tipo de entrega<select name="deliverable_type_id">${deliverableOptions}</select></label>
          <label class="assessment-settings-instructions">Orientações<textarea name="instructions" rows="2" placeholder="Instruções mostradas ao aluno">${esc(assessment.instructions || '')}</textarea></label>
          <label class="assessment-active"><input name="active" type="checkbox" ${assessment.active ? 'checked' : ''}> Ativa</label>
          <button class="admin-button" type="submit">Salvar</button><button class="row-action" type="button" data-remove-assessment="${assessment.id}">Excluir</button>
        </form>
        <div class="grade-roster"><div class="grade-roster-head"><span>Diário de notas</span><small>${(assessment.grades || []).length} de ${students.length} lançadas</small></div>${roster}</div>
      </article>`;
    }).join('') || '<div class="assessment-empty large"><strong>O diário de avaliação está pronto.</strong><p>Crie a primeira avaliação acima. Os alunos cadastrados aparecerão automaticamente para o lançamento das notas.</p></div>';

    $$('[data-assessment-settings]').forEach((form) => form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      values.active = form.elements.active.checked;
      values.requires_upload = form.elements.requires_upload.checked;
      if (!values.requires_upload) values.deliverable_type_id = '';
      try {
        await apiRequest(`/api/admin/assessments/${form.dataset.assessmentSettings}`, { method: 'PUT', body: JSON.stringify(values) });
        await loadRemoteAdmin();
        showToast('Configuração da avaliação atualizada.');
      } catch (error) { showToast(error.message); }
    }));
    $$('.grade-row').forEach((form) => form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      try {
        await apiRequest(`/api/admin/assessments/${form.dataset.assessmentId}/grades/${form.dataset.studentId}`, { method: 'PUT', body: JSON.stringify(values) });
        await loadRemoteAdmin();
        showToast('Nota salva e cartão do aluno atualizado.');
      } catch (error) { showToast(error.message); }
    }));
    $$('[data-remove-assessment]').forEach((button) => button.addEventListener('click', async () => {
      const assessment = assessments.find((item) => item.id === Number(button.dataset.removeAssessment));
      if (!assessment || !window.confirm(`Excluir “${assessment.name}” e todas as notas lançadas nela?`)) return;
      try {
        await apiRequest(`/api/admin/assessments/${assessment.id}`, { method: 'DELETE' });
        await loadRemoteAdmin();
        showToast('Avaliação e suas notas foram removidas.');
      } catch (error) { showToast(error.message); }
    }));
  }

  function renderPublication() {
    setText('#publishState', course.status === 'Publicada' ? 'Disciplina publicada' : course.status === 'Arquivada' ? 'Disciplina arquivada' : 'Rascunho privado');
    setText('#publishDetail', course.status === 'Arquivada' ? 'Somente a professora pode acessar' : course.visibility);
    setText('#togglePublishButton', course.status === 'Publicada' ? 'Voltar para rascunho' : course.status === 'Arquivada' ? 'Reabrir como rascunho' : 'Publicar disciplina');
    $('#archiveCourseButton').disabled = course.status === 'Arquivada';
    $('#archiveCourseButton').textContent = course.status === 'Arquivada' ? 'Disciplina já arquivada' : 'Arquivar disciplina finalizada';
  }

  async function loadRemoteAdmin() {
    try {
      const [courseResult, meResult, openaiResult] = await Promise.all([
        apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}`),
        apiRequest('/api/admin/me'),
        apiRequest('/api/admin/openai/status')
      ]);
      remoteCourse = courseResult;
      currentTeacher = meResult.teacher || currentTeacher;
      document.body.classList.remove('admin-locked');
      Object.assign(course, {
        title: remoteCourse.title,
        shortTitle: remoteCourse.short_title,
        semester: remoteCourse.semester,
        status: remoteCourse.status,
        visibility: remoteCourse.visibility,
        description: remoteCourse.description || course.description,
        ementa: remoteCourse.ementa || course.ementa,
        classDay: remoteCourse.class_day || course.classDay,
        room: remoteCourse.room || course.room,
        professor: remoteCourse.professor_name || course.professor,
        cover: remoteCourse.cover || course.cover,
        coverMediaType: remoteCourse.cover_media_type || course.coverMediaType || 'image',
        coverVideo: remoteCourse.cover_video ?? course.coverVideo ?? '',
        credits: remoteCourse.credits || course.credits,
        workload: remoteCourse.workload || course.workload,
        catalogUrl: remoteCourse.catalog_url || course.catalogUrl,
        updatedAt: remoteCourse.updated_at
      });
      course.driveUrl = remoteCourse.drive_url || '';
      course.driveConnected = Boolean(remoteCourse.drive_connected);
      if (currentTeacher?.name) {
        setText('#teacherName', currentTeacher.name);
        setText('#teacherInitials', currentTeacher.name.replace(/Profa?\.?/i, '').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase());
      }
      setText('#openaiStatus', openaiResult.configured ? `Ativa · ${openaiResult.model}` : 'Desativada');
      window.CourseStore.save(state);
      renderCourseTabs();
      populateForm();
      renderPublication();
      renderMetrics();
      renderOverviewAgenda();
      renderDrive();
      renderClasses();
      renderStudents();
      renderUploads();
      renderSubmissions();
      renderDeliverableTypes();
      renderAssessments();
      if ($('#classDialog').open && editingSessionId) {
        const updatedSession = remoteCourse.sessions.find((item) => item.id === editingSessionId);
        renderManagedArticles(updatedSession);
        renderPresenterChecks();
      }
      if (currentTeacher?.must_reset_password && !$('#passwordDialog').open) {
        $('#passwordDialog').classList.add('password-required');
        $('#passwordDialog .optional-close').hidden = true;
        $('#passwordDialog').showModal();
      }
    } catch (error) {
      remoteCourse = null;
      renderOverviewAgenda();
      renderClasses();
      renderUploads();
      renderDeliverableTypes();
      renderAssessments();
      console.warn('Banco SQLite indisponível; painel em modo local.', error);
    }
  }

  function renderAll() {
    setText('#breadcrumbCode', course.code);
    $('#studentViewLink').href = `index.html?curso=${encodeURIComponent(course.code)}`;
    $('#teacherProfileLink').href = `profile.html?role=teacher&curso=${encodeURIComponent(course.code)}`;
    renderCourseTabs();
    renderMetrics();
    renderOverviewAgenda();
    populateForm();
    renderDrive();
    renderClasses();
    renderModules();
    renderStudents();
    renderSubmissions();
    renderUploads();
    renderDeliverableTypes();
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
          cover: course.cover, coverMediaType: course.coverMediaType, coverVideo: course.coverVideo,
          driveUrl: course.driveUrl, status: course.status,
          visibility: course.visibility, description: course.description, ementa: course.ementa,
          classDay: course.classDay, room: course.room, professorName: course.professor,
          publicOverview: $('#publicOverview').checked,
          publicSchedule: $('#publicSchedule').checked,
          publicArticles: $('#publicArticles').checked,
          publicResources: $('#publicResources').checked,
          publicChat: $('#publicChat').checked
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

  $('#uploadCoverButton').addEventListener('click', async () => {
    const file = $('#coverFileInput').files?.[0];
    if (!file) { showToast('Selecione uma imagem para enviar.'); return; }
    const payload = new FormData();
    payload.append('cover', file);
    try {
      const result = await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}/cover`, { method: 'POST', body: payload });
      course.cover = result.cover;
      course.coverMediaType = 'image';
      $('#coverFileInput').value = '';
      await loadRemoteAdmin();
      showToast('Nova capa publicada para a disciplina.');
    } catch (error) { showToast(error.message); }
  });

  $('#uploadCoverVideoButton').addEventListener('click', async () => {
    const file = $('#coverVideoFileInput').files?.[0];
    if (!file) { showToast('Selecione um vídeo WebM ou MP4 para enviar.'); return; }
    const payload = new FormData();
    payload.append('video', file);
    try {
      const result = await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}/cover-video`, { method: 'POST', body: payload });
      course.coverVideo = result.cover_video;
      course.coverMediaType = 'video';
      $('#coverVideoFileInput').value = '';
      await loadRemoteAdmin();
      showToast('Vídeo de capa publicado em loop, com a imagem preservada como fallback.');
    } catch (error) { showToast(error.message); }
  });

  $('#courseForm').elements.coverMediaType.addEventListener('change', (event) => {
    course.coverMediaType = event.currentTarget.value;
    course.cover = $('#courseForm').elements.cover.value.trim() || course.cover;
    course.coverVideo = $('#courseForm').elements.coverVideo.value.trim();
    renderCoverPreview();
  });
  $('#courseForm').elements.coverVideo.addEventListener('change', (event) => {
    course.coverVideo = event.currentTarget.value.trim();
    if (course.coverMediaType === 'video') renderCoverPreview();
  });

  async function fillWithAI(kind, form, fieldNames) {
    const fields = Object.fromEntries(fieldNames.map((name) => [name, form.elements[name]?.value || '']));
    try {
      const result = await apiRequest('/api/admin/ai/fill', { method: 'POST', body: JSON.stringify({ kind, fields }) });
      Object.entries(result.fields || {}).forEach(([name, value]) => {
        if (form.elements[name]) form.elements[name].value = value;
      });
      showToast(`Sugestão gerada com ${result.model}. Revise antes de salvar.`);
    } catch (error) { showToast(error.message); }
  }

  $('#aiCourseButton').addEventListener('click', () => fillWithAI('course', $('#courseForm'), ['title', 'shortTitle', 'description', 'ementa']));
  $('#aiClassButton').addEventListener('click', () => fillWithAI('session', $('#classForm'), ['title', 'theme', 'specialist_topic', 'notes']));

  $('#openaiKeyForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const apiKey = String(new FormData(event.currentTarget).get('api_key') || '').trim();
    try {
      const result = await apiRequest('/api/admin/openai/key', { method: 'POST', body: JSON.stringify({ api_key: apiKey }) });
      event.currentTarget.reset();
      setText('#openaiStatus', result.configured ? `Ativa · ${result.model}` : 'Desativada');
      showToast('Assistente OpenAI ativado na memória do servidor.');
    } catch (error) { showToast(error.message); }
  });

  $('#clearOpenaiKey').addEventListener('click', async () => {
    try {
      await apiRequest('/api/admin/openai/key', { method: 'POST', body: JSON.stringify({ api_key: '' }) });
      setText('#openaiStatus', 'Desativada');
      showToast('Chave esquecida pelo servidor.');
    } catch (error) { showToast(error.message); }
  });

  $('#changePasswordButton').addEventListener('click', () => {
    $('#passwordDialog').classList.remove('password-required');
    $('#passwordDialog .optional-close').hidden = false;
    $('#passwordDialog').showModal();
  });

  $('#passwordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    $('#passwordError').textContent = '';
    if (values.new_password !== values.confirm_password) {
      $('#passwordError').textContent = 'A confirmação não corresponde à nova senha.';
      return;
    }
    try {
      await apiRequest('/api/admin/password', { method: 'PUT', body: JSON.stringify(values) });
      if (currentTeacher) currentTeacher.must_reset_password = false;
      $('#passwordDialog').classList.remove('password-required');
      $('#passwordDialog').close();
      form.reset();
      showToast('Senha da professora atualizada.');
    } catch (error) { $('#passwordError').textContent = error.message; }
  });

  $('#copySecretButton').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#secretRevealValue').textContent);
      showToast('Copiado para a área de transferência.');
    } catch (error) { showToast('Selecione e copie o valor exibido.'); }
  });

  $('#adminLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const values = Object.fromEntries(new FormData(formElement).entries());
    const submit = formElement.querySelector('button[type="submit"]');
    $('#adminLoginError').textContent = '';
    submit.disabled = true;
    submit.classList.add('is-loading');
    try {
      const result = await apiRequest('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ username: values.username, password: values.password })
      });
      sessionStorage.setItem(adminTokenKey, result.token);
      currentTeacher = result.teacher || null;
      $('#adminLoginDialog').close();
      formElement.elements.password.value = '';
      await syncAdminCatalog();
      course = state.courses.find((item) => item.code === currentCode) || state.courses[0];
      await loadRemoteAdmin();
      showToast('Painel docente liberado por 12 horas.');
    } catch (error) {
      $('#adminLoginError').textContent = error.message;
    } finally {
      submit.disabled = false;
      submit.classList.remove('is-loading');
    }
  });

  $('#adminLogoutButton').addEventListener('click', () => {
    sessionStorage.removeItem(adminTokenKey);
    remoteCourse = null;
    currentTeacher = null;
    openAdminLogin();
    showToast('Sessão docente encerrada.');
  });

  $('#syncDriveButton').addEventListener('click', async () => {
    const url = $('#driveUrlInput').value.trim();
    if (!url || !url.startsWith('https://drive.google.com/')) {
      showToast('Cole um link válido de pasta do Google Drive para conectar.');
      $('#driveUrlInput').focus();
      return;
    }
    const button = $('#syncDriveButton');
    button.disabled = true;
    button.textContent = 'Sincronizando…';
    try {
      if (url !== course.driveUrl || !remoteCourse?.drive_url) {
        await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}`, { method: 'PUT', body: JSON.stringify({ driveUrl: url }) });
      }
      course.driveUrl = url;
      saveState();
      const result = await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}/drive/sync`, { method: 'POST', body: '{}' });
      await loadRemoteAdmin();
      showToast(`${result.count} arquivo${result.count === 1 ? '' : 's'} sincronizado${result.count === 1 ? '' : 's'} no armazenamento da plataforma.`);
    } catch (error) {
      await loadRemoteAdmin();
      showToast(error.message);
    } finally {
      button.disabled = false;
      renderDrive();
    }
  });

  $('#togglePublishButton').addEventListener('click', async () => {
    const nextStatus = course.status === 'Publicada' || course.status === 'Arquivada' ? 'Rascunho' : 'Publicada';
    try {
      await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}`, { method: 'PUT', body: JSON.stringify({ status: nextStatus }) });
      course.status = nextStatus;
      saveState();
      await loadRemoteAdmin();
      showToast(nextStatus === 'Publicada' ? 'Disciplina publicada para a turma.' : 'Disciplina movida para rascunho privado.');
    } catch (error) { showToast(error.message); }
    renderAll();
  });

  $('#cloneCurrentCourseButton').addEventListener('click', () => prepareNewCourseDialog(course.code));
  $('#archiveCourseButton').addEventListener('click', async () => {
    if (course.status === 'Arquivada') return;
    if (!window.confirm(`Arquivar ${course.code}? Ela sairá do site e as sessões dos alunos e especialistas serão encerradas.`)) return;
    try {
      await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}`, { method: 'PUT', body: JSON.stringify({ status: 'Arquivada' }) });
      course.status = 'Arquivada';
      saveState();
      await loadRemoteAdmin();
      showToast(`${course.code} foi arquivada. O conteúdo permanece disponível somente no painel docente.`);
    } catch (error) { showToast(error.message); }
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
  $('#classForm').elements.session_date.addEventListener('change', (event) => {
    const form = event.currentTarget.form;
    if (!event.currentTarget.value || form.elements.submission_deadline.value) return;
    const date = new Date(`${event.currentTarget.value}T${form.elements.start_time.value || '14:00'}:00`);
    date.setDate(date.getDate() - 1);
    const pad = (value) => String(value).padStart(2, '0');
    form.elements.submission_deadline.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  });
  $('#classForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    values.student_choice_enabled = event.currentTarget.elements.student_choice_enabled.checked;
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
      $('#specialistInviteManager').hidden = false;
      $('#adminRoomManager').hidden = false;
      renderManagedArticles(updated);
      renderPresenterChecks();
      await loadAdminRoom(editingSessionId);
      showToast(sessionId ? 'Aula atualizada. O destaque dos alunos foi recalculado.' : 'Aula criada. Agora vincule os artigos e apresentadores.');
    } catch (error) { showToast(error.message); }
  });

  $('#generateSpecialistInvite').addEventListener('click', async () => {
    if (!editingSessionId) return;
    const form = $('#classForm');
    const name = form.elements.specialist_name.value.trim();
    if (!name) { showToast('Informe e salve o nome do especialista primeiro.'); return; }
    try {
      const result = await apiRequest(`/api/admin/sessions/${editingSessionId}/specialist-invite`, {
        method: 'POST',
        body: JSON.stringify({
          name, role: form.elements.specialist_role.value.trim(),
          email: form.elements.specialist_email.value.trim(),
          linkedin: form.elements.specialist_linkedin.value.trim(),
          whatsapp: form.elements.specialist_whatsapp.value.trim(),
          website: form.elements.specialist_website.value.trim(),
          duration_hours: Number($('#specialistInviteDuration').value)
        })
      });
      revealSecret({
        eyebrow: 'Convite temporário', title: `Acesso de ${name}`,
        copy: `Válido até ${new Date(result.expires_at).toLocaleString('pt-BR')}. Gerar outro convite invalida o anterior.`,
        value: result.invite_url
      });
      await loadRemoteAdmin();
    } catch (error) { showToast(error.message); }
  });

  $('#adminRoomResourceForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    values.visibility = event.currentTarget.elements.public.checked ? 'public' : 'class';
    try {
      await apiRequest(`/api/sessions/${editingSessionId}/resources`, { method: 'POST', body: JSON.stringify(values) });
      event.currentTarget.reset();
      await loadAdminRoom();
      showToast('Material adicionado à sala da aula.');
    } catch (error) { showToast(error.message); }
  });

  $$('[data-admin-rich]').forEach((button) => button.addEventListener('click', () => {
    $('#adminRoomCommentEditor').focus();
    document.execCommand(button.dataset.adminRich, false);
  }));
  $('#adminRoomCommentForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const editor = $('#adminRoomCommentEditor');
    if (!editor.textContent.trim()) { showToast('Escreva uma mensagem antes de publicar.'); return; }
    try {
      await apiRequest(`/api/sessions/${editingSessionId}/comments`, { method: 'POST', body: JSON.stringify({ content_html: editor.innerHTML }) });
      editor.innerHTML = '';
      await loadAdminRoom();
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
        const result = await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}/students`, {
          method: 'POST', body: JSON.stringify({ name: values.name, email: values.email, nusp: values.nusp, group_name: '—' })
        });
        event.currentTarget.reset();
        revealSecret({
          eyebrow: 'Novo aluno', title: `Token de ${values.name}`,
          copy: 'Copie e envie ao aluno. A recuperação por e-mail será conectada ao Resend futuramente.',
          value: result.access_token
        });
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

  $('#deliverableTypeForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') || '').trim();
    if (!name) return;
    try {
      await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}/deliverables`, {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      event.currentTarget.reset();
      await loadRemoteAdmin();
      showToast(`${name} adicionado aos tipos de entrega.`);
    } catch (error) { showToast(error.message); }
  });

  const assessmentUploadToggle = $('#assessmentForm').elements.requires_upload;
  const assessmentDeliverableSelect = $('#assessmentForm').elements.deliverable_type_id;
  const syncAssessmentUploadControls = () => {
    assessmentDeliverableSelect.disabled = !assessmentUploadToggle.checked;
    assessmentDeliverableSelect.required = assessmentUploadToggle.checked;
    if (!assessmentUploadToggle.checked) assessmentDeliverableSelect.value = '';
  };
  assessmentUploadToggle.addEventListener('change', syncAssessmentUploadControls);
  syncAssessmentUploadControls();

  $('#assessmentForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    values.requires_upload = event.currentTarget.elements.requires_upload.checked;
    if (values.requires_upload && !values.deliverable_type_id) {
      showToast('Escolha o tipo de arquivo que o aluno deverá entregar.');
      event.currentTarget.elements.deliverable_type_id.focus();
      return;
    }
    if (!values.requires_upload) values.deliverable_type_id = '';
    try {
      await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}/assessments`, {
        method: 'POST', body: JSON.stringify(values)
      });
      event.currentTarget.reset();
      event.currentTarget.elements.max_score.value = '10';
      event.currentTarget.elements.weight.value = '25';
      await loadRemoteAdmin();
      showToast('Avaliação criada e adicionada ao diário da turma.');
    } catch (error) { showToast(error.message); }
  });

  $('#gradeScaleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const gradeScale = [
      { letter: 'A', min: Number(values.A) },
      { letter: 'B', min: Number(values.B) },
      { letter: 'C', min: Number(values.C) },
      { letter: 'R', min: 0 }
    ];
    if (!(gradeScale[0].min > gradeScale[1].min && gradeScale[1].min > gradeScale[2].min && gradeScale[2].min > 0)) {
      showToast('Use faixas decrescentes: A maior que B, B maior que C e C maior que zero.');
      return;
    }
    try {
      await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}`, {
        method: 'PUT', body: JSON.stringify({ gradeScale })
      });
      await loadRemoteAdmin();
      showToast('Faixas dos emblemas A, B, C e R atualizadas.');
    } catch (error) { showToast(error.message); }
  });

  $('#publishGradeResults').addEventListener('click', async () => {
    const publish = !Boolean(remoteCourse?.grade_results_published);
    if (publish && !window.confirm('Publicar agora os conceitos finais para os alunos?')) return;
    try {
      await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}`, {
        method: 'PUT', body: JSON.stringify({ gradeResultsPublished: publish })
      });
      await loadRemoteAdmin();
      showToast(publish ? 'Resultados publicados. Os emblemas já aparecem para os alunos.' : 'Resultados recolhidos para rascunho.');
    } catch (error) { showToast(error.message); }
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
      const generatedTokens = [];
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
            const result = await apiRequest(`/api/admin/courses/${encodeURIComponent(course.code)}/students`, {
              method: 'POST', body: JSON.stringify({ ...candidate, group_name: candidate.group })
            });
            generatedTokens.push(`${candidate.name};${candidate.email};${result.access_token}`);
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
        if (generatedTokens.length) revealSecret({
          eyebrow: 'Tokens da importação', title: 'Copie a lista agora.',
          copy: 'Formato: nome; e-mail; token. Os tokens não serão exibidos novamente.',
          value: generatedTokens.join('\n')
        });
        renderStudents();
        renderMetrics();
      } else {
        showToast('Nenhum aluno novo encontrado. Use colunas: nome, e-mail, Nº USP e grupo.');
      }
    });
    input.click();
  });

  function prepareNewCourseDialog(templateCode = '') {
    const templateSelect = $('#templateCourseSelect');
    templateSelect.innerHTML = '<option value="">Começar em branco</option>' + state.courses.map((item) => `<option value="${esc(item.code)}">${esc(item.code)} · ${esc(item.shortTitle)}</option>`).join('');
    templateSelect.value = state.courses.some((item) => item.code === templateCode) ? templateCode : '';
    $('#firstClassDate').required = Boolean(templateSelect.value);
    $('#newCourseDialog').showModal();
    if (templateSelect.value) $('#firstClassDate').focus();
  }

  $('#templateCourseSelect').addEventListener('change', (event) => {
    const cloning = Boolean(event.currentTarget.value);
    $('#firstClassDate').required = cloning;
    if (cloning && !$('#firstClassDate').value) $('#firstClassDate').focus();
  });

  $('#newCourseButton').addEventListener('click', () => prepareNewCourseDialog());
  $('#newCourseForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const code = values.code.trim().toUpperCase();
    if (state.courses.some((item) => item.code === code)) {
      showToast(`${code} já está cadastrada.`);
      return;
    }
    const template = state.courses.find((item) => item.code === values.template_code);
    const templateCopy = template ? structuredClone(template) : {};
    const newCourse = {
      ...templateCopy,
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
      professor: 'Profa. Maria Lídia',
      updatedAt: 'Agora',
      cover: templateCopy.cover || 'assets/course-pea5004.webp',
      coverMediaType: templateCopy.coverMediaType || 'image',
      coverVideo: templateCopy.coverVideo || '',
      accent: '#56d6ca',
      driveUrl: values.driveUrl.trim(),
      driveConnected: false,
      driveEmail: 'lidia.rebello.dias@usp.br',
      description: templateCopy.description || 'Uma nova rota de aprendizagem está sendo preparada.',
      ementa: templateCopy.ementa || 'Cadastre a ementa desta disciplina.',
      objectives: templateCopy.objectives || ['Cadastrar o primeiro objetivo de aprendizagem.'],
      folders: templateCopy.folders || [
        { name: '01. Sobre o curso', detail: 'Ementa e cronograma', count: 0 },
        { name: '02. Textos', detail: 'Leituras de apoio', count: 0 },
        { name: '03. Entregas', detail: 'Trabalhos da turma', count: 0 }
      ],
      modules: templateCopy.modules || [],
      readings: templateCopy.readings || [],
      presentationTips: templateCopy.presentationTips || ['Abra com o problema.'],
      students: [],
      submissions: []
    };
    let cloned = { sessions: 0, articles: 0 };
    try {
      const result = await apiRequest('/api/admin/courses', {
        method: 'POST',
        body: JSON.stringify({
          code,
          title: newCourse.title,
          short_title: newCourse.shortTitle,
          semester: newCourse.semester,
          cover: newCourse.cover,
          cover_media_type: newCourse.coverMediaType,
          cover_video: newCourse.coverVideo,
          drive_url: newCourse.driveUrl,
          template_code: values.template_code,
          first_class_date: values.first_class_date
        })
      });
      cloned = result.cloned || cloned;
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
    showToast(template ? `${code} criada com ${cloned.sessions} aulas e ${cloned.articles} artigos clonados.` : `${code} criada como rascunho.`);
  });

  $$('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
  $('#passwordDialog').addEventListener('cancel', (event) => {
    if ($('#passwordDialog').classList.contains('password-required')) event.preventDefault();
  });

  $('#resetButton').addEventListener('click', async () => {
    if (!window.confirm('Recarregar o conteúdo editorial inicial? A agenda, os alunos e os materiais do SQLite serão preservados.')) return;
    state = window.CourseStore.reset();
    course = window.CourseStore.getCourse(state, 'PEA5004');
    currentCode = course.code;
    renderAll();
    await loadRemoteAdmin();
    showToast('Conteúdo editorial recarregado. Os dados do SQLite foram preservados.');
  });

  $$('[data-admin-route]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    setAdminView(link.dataset.adminRoute);
  }));

  async function bootstrap() {
    try {
      await syncAdminCatalog();
      const requestedCode = (params.get('curso') || currentCode).toUpperCase();
      course = state.courses.find((item) => item.code === requestedCode) || state.courses[0];
      currentCode = course.code;
    } catch (error) {
      console.warn('Catálogo SQLite indisponível.', error);
    }
    renderAll();
    setAdminView(window.location.hash.slice(1) || 'visao');
    await loadRemoteAdmin();
  }

  bootstrap();
}());
