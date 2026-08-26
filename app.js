(function () {
  'use strict';

  let state = window.CourseStore.load();
  let publishedCourseCodes = new Set(
    state.courses.filter((item) => item.status === 'Publicada').map((item) => item.code)
  );
  const params = new URLSearchParams(window.location.search);
  const requestedCode = (params.get('curso') || 'PEA5004').toUpperCase();
  let course = window.CourseStore.getCourse(state, requestedCode);
  let remoteCourse = null;
  let currentStudent = null;
  let activeRoomSessionId = null;
  let toastTimer;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const authKey = () => `rota-access-${course.code}`;
  const tokenKey = () => `rota-token-${course.code}`;
  const isAuthenticated = () => Boolean(sessionStorage.getItem(tokenKey()) || sessionStorage.getItem(authKey()) === 'true');

  async function apiRequest(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const token = sessionStorage.getItem(tokenKey());
    if (token) headers.Authorization = `Bearer ${token}`;
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
  const formatDatePart = (value, options) => new Intl.DateTimeFormat('pt-BR', options).format(dateFromISO(value));
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

  function setText(selector, value) {
    const element = $(selector);
    if (element) element.textContent = value;
  }

  function statusLabel(status) {
    if (status === 'done') return 'Concluída';
    if (status === 'current') return 'Em curso';
    return 'A seguir';
  }

  function countdownLabel(sessionDate) {
    const today = todayInCourseTimezone();
    const target = dateFromISO(sessionDate);
    target.setHours(0, 0, 0, 0);
    const days = Math.round((target - today) / 86400000);
    if (days === 0) return 'Hoje';
    if (days === 1) return 'Amanhã';
    if (days > 1) return `Em ${days} dias`;
    return 'Aula realizada';
  }

  function renderNextClass() {
    const next = remoteCourse?.next_class;
    const card = $('#nextClassCard');
    const empty = $('#nextClassEmpty');
    if (!next) {
      card.hidden = true;
      empty.hidden = false;
      $('#meetingGate').hidden = true;
      setText('#nextClass', 'A definir');
      return;
    }
    card.hidden = false;
    empty.hidden = true;
    setText('#nextClassWeekday', formatDatePart(next.session_date, { weekday: 'long' }));
    setText('#nextClassDay', formatDatePart(next.session_date, { day: '2-digit' }));
    setText('#nextClassMonth', formatDatePart(next.session_date, { month: 'long', year: 'numeric' }));
    setText('#nextClassTime', next.start_time);
    setText('#nextClassTheme', next.theme || 'Tema da aula');
    setText('#nextClassName', next.title);
    setText('#nextClassLocation', next.location || 'Local a definir');
    setText('#specialistName', next.specialist_name || 'Profissional a confirmar');
    setText('#specialistRole', next.specialist_role || 'Especialista convidado');
    setText('#specialistTopic', next.specialist_topic || 'A temática da aula será apresentada pelo profissional convidado.');
    setText('#classCountdown', countdownLabel(next.session_date));
    setText('#nextClass', formatDatePart(next.session_date, { day: '2-digit', month: 'short' }).replace('.', ''));
    const articles = next.articles || [];
    $('#nextArticleList').innerHTML = articles.length ? articles.map((article) => {
      const presenters = (article.presenters || []).map((presenter) => presenter.name).join(', ');
      const stateLabel = article.chosen_by_me ? 'Sua escolha' : article.available_for_choice ? 'Disponível' : `Escolhido por ${article.reservation?.student_name || presenters || 'outro aluno'}`;
      return `<article class="next-article">
        <span>${esc(article.code || 'ART')}</span>
        <div><strong>${esc(article.title)}</strong><small>${esc(article.author || 'Autoria a confirmar')}</small><small class="presenter-line ${article.chosen_by_me ? 'mine' : ''}">${esc(stateLabel)}</small></div>
      </article>`;
    }).join('') : '<p class="next-article-empty">Os artigos e apresentadores desta aula ainda serão cadastrados.</p>';
    renderMeetingGate();
    if (!activeRoomSessionId) activeRoomSessionId = next.id;
  }

  function renderMeetingGate() {
    const gate = $('#meetingGate');
    const locked = $('#meetingLockedButton');
    const link = $('#meetingLink');
    const next = remoteCourse?.next_class;
    gate.hidden = !next;
    link.hidden = true;
    link.removeAttribute('href');
    locked.hidden = false;
    locked.disabled = false;
    locked.classList.toggle('not-published', Boolean(next && !next.meeting_available));
    if (!next) return;
    if (!next.meeting_available) {
      setText('#meetingStatus', 'A professora ainda não publicou o endereço');
    } else if (isAuthenticated()) {
      setText('#meetingStatus', 'Validando sua credencial temporária…');
    } else {
      setText('#meetingStatus', 'Entre para revelar o link protegido');
    }
  }

  async function loadMeetingAccess({ focus = false } = {}) {
    renderMeetingGate();
    if (!isAuthenticated() || !remoteCourse?.next_class) return false;
    try {
      const result = await apiRequest(`/api/courses/${encodeURIComponent(course.code)}/meeting`);
      const link = $('#meetingLink');
      link.href = result.meeting.meet_url;
      link.hidden = false;
      $('#meetingLockedButton').hidden = true;
      if (focus) {
        link.focus();
        showToast('Link da aula liberado com sua credencial temporária.');
      }
      return true;
    } catch (error) {
      if (error.status === 401) {
        sessionStorage.removeItem(tokenKey());
        sessionStorage.removeItem(authKey());
        currentStudent = null;
        updateAuthUI();
        setText('#meetingStatus', 'Sua sessão expirou. Entre novamente para acessar.');
      } else {
        setText('#meetingStatus', error.message);
        if (focus) showToast(error.message);
      }
      return false;
    }
  }

  function renderUploadOptions() {
    const sessions = remoteCourse?.sessions || [];
    const select = $('#uploadSessionSelect');
    select.innerHTML = sessions.map((session) => `<option value="${session.id}" ${session.id === remoteCourse?.next_class?.id ? 'selected' : ''} ${session.submission_open === false ? 'disabled' : ''}>${esc(formatDatePart(session.session_date, { day: '2-digit', month: 'short' }))} · ${esc(session.title)}${session.submission_open === false ? ' · prazo encerrado' : ''}</option>`).join('');
    const syncArticles = () => {
      const selected = sessions.find((session) => session.id === Number(select.value));
      const articleSelect = $('#uploadArticleSelect');
      const ownArticles = (selected?.articles || []).filter((article) => article.chosen_by_me);
      articleSelect.innerHTML = '<option value="">Material geral da aula</option>' + ownArticles.map((article) => `<option value="${article.id}">${esc(article.code || 'Artigo')} · ${esc(article.title)} · sua escolha</option>`).join('');
    };
    select.onchange = syncArticles;
    syncArticles();
    const deliverableSelect = $('#uploadDeliverableSelect');
    const deliverableTypes = remoteCourse?.deliverable_types || [];
    deliverableSelect.innerHTML = deliverableTypes.length
      ? deliverableTypes.map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join('')
      : '<option value="">Nenhum tipo de entrega cadastrado</option>';
  }

  function formatDeadline(value) {
    if (!value) return 'Prazo ainda não definido';
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  }

  function renderAssignments() {
    const panel = $('#studentAssignmentPanel');
    const assignments = remoteCourse?.my_assignments || [];
    const activities = remoteCourse?.my_activities || [];
    const authenticated = Boolean(isAuthenticated() && remoteCourse?.access?.authenticated);
    $('#studentWorkspaceGate').hidden = authenticated;
    $('#studentWorkspaceDashboard').hidden = !authenticated;
    if (!authenticated) {
      panel.innerHTML = '<p>Entre com seu token para consultar sua escolha e as entregas obrigatórias.</p>';
      $('#studentActivityList').innerHTML = '';
      return;
    }
    if (!assignments.length) {
      panel.innerHTML = '<div class="assignment-empty"><strong>Nenhum artigo escolhido.</strong><span>Abra “Escolher meu artigo” quando a professora liberar as reservas.</span></div>';
    } else {
      panel.innerHTML = assignments.map((assignment) => {
        const uploaded = new Set((assignment.uploads || []).map((item) => item.deliverable_type));
        return `<article class="assignment-card">
          <span class="assignment-code">${esc(assignment.article_code || 'ART')}</span>
          <div><small>Sua escolha · ${esc(assignment.session_title)}</small><strong>${esc(assignment.article_title)}</strong>
            <p>Enviar até <b>${esc(formatDeadline(assignment.submission_deadline))}</b></p>
            <div class="required-deliverables">${(assignment.required_deliverables || []).map((name) => `<span class="${uploaded.has(name) ? 'done' : ''}">${uploaded.has(name) ? '✓' : '○'} ${esc(name)}</span>`).join('')}</div>
          </div>
          <a class="secondary-button" href="#atividades">Abrir entregas</a>
        </article>`;
      }).join('');
    }

    const tasks = activities.flatMap((activity) => activity.tasks || []);
    const complete = tasks.filter((task) => task.complete).length;
    const progress = tasks.length ? Math.round((complete / tasks.length) * 100) : 0;
    setText('#activityProgress', `${complete}/${tasks.length}`);
    setText('#activityProgressLabel', tasks.length === 1 ? 'entrega concluída' : 'entregas concluídas');
    $('#activityProgressBar').style.width = `${progress}%`;
    const futureDeadlines = activities
      .filter((activity) => activity.due_at && (activity.tasks || []).some((task) => !task.complete))
      .map((activity) => activity.due_at).sort();
    setText('#activityNextDeadline', futureDeadlines.length ? `Próximo prazo · ${formatDeadline(futureDeadlines[0])}` : tasks.length ? 'Nenhuma pendência com prazo definido' : 'Nenhuma atividade liberada');

    $('#studentActivityList').innerHTML = activities.map((activity, index) => {
      const overdue = Boolean(activity.due_at && new Date(activity.due_at) <= new Date());
      const taskRows = (activity.tasks || []).map((task) => {
        const uploads = task.uploads || [];
        const latest = uploads.at(-1);
        const canUpload = Boolean(task.deliverable_type_id && !overdue);
        return `<form class="activity-delivery ${task.complete ? 'complete' : ''}" data-direct-upload>
          <input type="hidden" name="deliverable_type_id" value="${task.deliverable_type_id || ''}">
          ${activity.session_id ? `<input type="hidden" name="session_id" value="${activity.session_id}">` : ''}
          ${activity.article_id ? `<input type="hidden" name="article_id" value="${activity.article_id}">` : ''}
          ${activity.assessment_id ? `<input type="hidden" name="assessment_id" value="${activity.assessment_id}">` : ''}
          <div class="activity-delivery-state"><span>${task.complete ? '✓' : '○'}</span><div><strong>${esc(task.name)}</strong><small>${latest ? `${esc(latest.filename)} · enviado em ${esc(formatDeadline(latest.created_at))}` : canUpload ? 'Arquivo ainda não enviado' : overdue ? 'Prazo encerrado' : 'Tipo de entrega ainda não configurado'}</small></div></div>
          <label class="activity-file-picker ${canUpload ? '' : 'disabled'}"><input name="file" type="file" required ${canUpload ? '' : 'disabled'} accept=".pdf,.ppt,.pptx,.doc,.docx,.odt,.odp,.xls,.xlsx,.csv,.zip"><span>${task.complete ? 'Escolher nova versão' : 'Escolher arquivo'}</span></label>
          <button class="secondary-button" type="submit" ${canUpload ? '' : 'disabled'}>${task.complete ? 'Enviar nova versão' : 'Enviar entrega'}</button>
          <p class="activity-upload-message" role="status"></p>
        </form>`;
      }).join('');
      return `<article class="student-activity-card ${overdue ? 'overdue' : ''}" style="--activity-index:${index}">
        <header><span>${String(index + 1).padStart(2, '0')}</span><div><small>${esc(activity.label)}</small><h3>${esc(activity.title)}</h3><p>${esc(activity.context || '')}</p></div><time>${esc(activity.due_at ? formatDeadline(activity.due_at) : 'Sem prazo definido')}</time></header>
        <div class="activity-instructions">${esc(activity.instructions || 'Consulte as orientações da professora.')}</div>
        <div class="activity-deliveries">${taskRows}</div>
      </article>`;
    }).join('') || '<div class="student-activity-empty"><strong>Nenhuma atividade liberada.</strong><p>Quando você escolher um artigo ou a professora abrir uma entrega, ela aparecerá aqui.</p></div>';

    $$('[data-direct-upload]').forEach((form) => form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = form.querySelector('.activity-upload-message');
      const submit = form.querySelector('button[type="submit"]');
      const file = form.elements.file.files?.[0];
      if (!file) { message.textContent = 'Escolha um arquivo antes de enviar.'; return; }
      message.textContent = 'Enviando…';
      submit.disabled = true;
      try {
        const payload = new FormData(form);
        payload.append('description', 'Envio direto pela central de atividades');
        await apiRequest('/api/uploads', { method: 'POST', body: payload });
        await loadRemoteCourse();
        showToast('Entrega recebida. A professora já pode consultar o arquivo.');
      } catch (error) {
        message.textContent = error.message;
        submit.disabled = false;
      }
    }));
  }

  function renderGrades() {
    const authenticated = Boolean(isAuthenticated() && remoteCourse?.access?.authenticated);
    $('#gradesLocked').hidden = authenticated;
    $('#gradesDashboard').hidden = !authenticated;
    if (!authenticated) return;
    const grades = remoteCourse?.grades || [];
    const summary = remoteCourse?.grade_summary || {};
    const total = Number(summary.total_count || 0);
    const graded = Number(summary.graded_count || 0);
    const progress = total ? Math.round((graded / total) * 100) : 0;
    const gradeKindLabels = { review: 'Resenha', presentation: 'Apresentação', participation: 'Participação', article: 'Artigo', final_work: 'Trabalho final', other: 'Avaliação' };
    const concept = summary.concept || '…';
    setText('#finalConcept', concept);
    $('#finalConcept').className = `final-concept ${summary.concept ? `grade-${String(summary.concept).toLowerCase()}` : 'pending'}`;
    setText('#finalScore', summary.score == null ? 'Sem notas lançadas' : `${Number(summary.score).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} / 10`);
    setText('#finalGradeDetail', summary.complete && summary.published
      ? `Conceito final ${summary.concept} · publicado pela professora.`
      : summary.complete
        ? 'Todas as correções foram concluídas. O emblema aguarda a publicação da professora.'
        : `${graded} de ${total} avaliações corrigidas. O conceito será liberado pela professora ao final.`);
    $('#gradeProgressBar').style.width = `${progress}%`;
    $('#studentGradeCards').innerHTML = grades.map((grade, index) => {
      const corrected = grade.score != null;
      const normalized = corrected ? Math.max(0, Math.min(100, (Number(grade.score) / Number(grade.max_score || 10)) * 100)) : 0;
      const due = grade.due_at ? formatDeadline(grade.due_at) : 'Sem prazo definido';
      return `<article class="student-grade-card ${corrected ? 'graded' : 'pending'}" style="--grade-index:${index};--grade-fill:${normalized}%">
        <div class="student-grade-top"><span>${String(index + 1).padStart(2, '0')} · ${esc(gradeKindLabels[grade.kind] || grade.kind)}</span><strong>${Number(grade.weight).toLocaleString('pt-BR')}% do resultado</strong></div>
        <h3>${esc(grade.name)}</h3>
        <div class="student-grade-score"><strong>${corrected ? Number(grade.score).toLocaleString('pt-BR') : '—'}</strong><span>/ ${Number(grade.max_score).toLocaleString('pt-BR')}</span></div>
        <div class="student-grade-meter"><span></span></div>
        <p>${corrected ? esc(grade.feedback || 'Nota lançada. A professora ainda não registrou uma devolutiva.') : `Aguardando correção · ${esc(due)}`}</p>
      </article>`;
    }).join('') || '<div class="grades-empty"><strong>Nenhuma avaliação publicada.</strong><p>Assim que a professora criar o diário da disciplina, seus cartões aparecerão aqui.</p></div>';
  }

  async function loadClassRoom(sessionId = activeRoomSessionId || remoteCourse?.next_class?.id) {
    if (!sessionId) return;
    activeRoomSessionId = Number(sessionId);
    try {
      const room = await apiRequest(`/api/courses/${encodeURIComponent(course.code)}/sessions/${activeRoomSessionId}/room`);
      setText('#classRoomTitle', room.session.title);
      setText('#classRoomSubtitle', `${formatDatePart(room.session.session_date, { weekday: 'long', day: '2-digit', month: 'long' })} · ${room.session.start_time}`);
      setText('#roomAccessState', room.actor ? `${room.actor.name} · ${room.actor.role === 'student' ? 'aluno' : room.actor.role}` : 'Conteúdo público');
      const canView = room.permissions.can_view_resources || room.permissions.can_view_chat;
      $('#roomLocked').hidden = canView;
      $('#roomGrid').hidden = !canView;
      $('#roomResourceForm').hidden = !room.permissions.can_post;
      $('#roomCommentForm').hidden = !room.permissions.can_post;
      setText('#resourceCount', `${room.resources.length} ${room.resources.length === 1 ? 'item' : 'itens'}`);
      $('#roomResourceList').innerHTML = room.resources.map((resource) => `<article class="room-resource"><span>${resource.resource_type === 'slide' ? '▱' : resource.resource_type === 'link' ? '↗' : '□'}</span><div><small>${esc(resource.author_name)} · ${esc(resource.visibility === 'public' ? 'público' : 'turma')}</small><strong>${esc(resource.title)}</strong>${resource.content_html ? `<div>${resource.content_html}</div>` : ''}</div>${resource.url ? `<a href="${esc(resource.url)}" target="_blank" rel="noopener noreferrer">Abrir ↗</a>` : ''}</article>`).join('') || '<p class="room-empty">Nenhum material adicionado a esta aula.</p>';
      $('#roomCommentList').innerHTML = room.comments.map((comment) => `<article class="room-comment"><div><strong>${esc(comment.author_name)}</strong><span>${esc(comment.author_role === 'student' ? 'aluno' : comment.author_role)}</span><time>${esc(new Date(comment.created_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR'))}</time></div><div>${comment.content_html}</div></article>`).join('') || '<p class="room-empty">O mural ainda está vazio. Inicie a conversa.</p>';
    } catch (error) {
      $('#roomLocked').hidden = false;
      $('#roomGrid').hidden = true;
      setText('#classRoomSubtitle', error.message);
    }
  }

  async function loadRemoteCourse() {
    try {
      remoteCourse = await apiRequest(`/api/courses/${encodeURIComponent(course.code)}`);
      const canSeeOverview = remoteCourse.access?.authenticated || remoteCourse.access?.public_overview !== false;
      Object.assign(course, {
        title: remoteCourse.title || course.title,
        shortTitle: remoteCourse.short_title || course.shortTitle,
        semester: remoteCourse.semester || course.semester,
        description: canSeeOverview ? (remoteCourse.description || course.description) : 'A apresentação completa desta disciplina está disponível para a turma autenticada.',
        ementa: canSeeOverview ? (remoteCourse.ementa || course.ementa) : 'Entre com seu token para consultar a ementa, os objetivos e os materiais desta disciplina.',
        classDay: remoteCourse.class_day || course.classDay,
        room: remoteCourse.room || course.room,
        professor: remoteCourse.professor_name || course.professor,
        cover: remoteCourse.cover || course.cover,
        credits: remoteCourse.credits || course.credits,
        workload: remoteCourse.workload || course.workload,
        catalogUrl: remoteCourse.catalog_url || course.catalogUrl,
      });
      course.driveUrl = remoteCourse.drive_url || course.driveUrl;
      course.driveConnected = Boolean(remoteCourse.drive_connected);
      setText('#heroTitle', course.title);
      setText('#heroDescription', course.description);
      setText('#heroSemester', course.semester.replace('semestre de', 'sem.'));
      setText('#syllabusText', course.ementa);
      setText('#professorName', course.professor);
      $('#heroMedia').style.backgroundImage = `url('${course.cover}')`;
      $('#briefingPhoto').style.backgroundImage = `url('${course.cover}')`;
      $('#objectiveList').hidden = !canSeeOverview;
      if (!remoteCourse.access?.authenticated && remoteCourse.access?.public_schedule === false) {
        $('#nextClassEmpty h3').textContent = 'A agenda está protegida para a turma.';
        $('#nextClassEmpty p').textContent = 'Entre com seu token para consultar datas, artigos e convidados.';
      }
      setText('#heroDriveStatus', course.driveConnected ? 'Sincronizado' : 'Aguardando');
      $('#heroDriveDot').classList.toggle('pending', !course.driveConnected);
      setText('#syncTime', remoteCourse.drive_last_synced_at ? formatDeadline(remoteCourse.drive_last_synced_at) : 'Sincronização pendente');
      renderNextClass();
      renderUploadOptions();
      renderPresentationOptions();
      renderAssignments();
      renderGrades();
      renderModules();
      renderFolders();
      renderReadings();
      if (activeRoomSessionId || remoteCourse.next_class) await loadClassRoom();
      if (isAuthenticated()) await loadMeetingAccess();
    } catch (error) {
      remoteCourse = null;
      $('#nextClassCard').hidden = true;
      $('#nextClassEmpty').hidden = false;
      console.warn('Agenda SQLite indisponível; usando o conteúdo local.', error);
    }
  }

  async function bootstrapRemoteCourse() {
    try {
      const catalog = await apiRequest('/api/courses');
      publishedCourseCodes = new Set(catalog.map((item) => item.code));
      catalog.forEach((item) => {
        const existing = state.courses.find((local) => local.code === item.code);
        if (existing) {
          Object.assign(existing, {
            title: item.title, shortTitle: item.short_title, semester: item.semester,
            status: item.status, visibility: item.visibility, updatedAt: item.updated_at,
            cover: item.cover || existing.cover, driveUrl: item.drive_url,
            driveConnected: Boolean(item.drive_connected), credits: item.credits || existing.credits,
            workload: item.workload || existing.workload, catalogUrl: item.catalog_url || existing.catalogUrl
          });
          return;
        }
        state.courses.push({
          code: item.code, title: item.title, shortTitle: item.short_title, semester: item.semester,
          status: item.status, visibility: item.visibility, progress: 0, credits: item.credits || 8, workload: item.workload || '120 h',
          classDay: 'A definir', room: 'A definir', professor: 'Profa. Dra. Lídia Rebello Dias',
          updatedAt: item.updated_at, cover: item.cover || 'assets/course-pea5004.webp', accent: '#56d6ca',
          driveUrl: item.drive_url, driveConnected: Boolean(item.drive_connected),
          catalogUrl: item.catalog_url || '', description: item.description || 'Uma nova rota de aprendizagem.', ementa: item.ementa || 'Cadastre a ementa desta disciplina.',
          objectives: ['Cadastrar o primeiro objetivo.'], folders: [], modules: [], readings: [],
          presentationTips: ['Abra com o problema.'], students: [], submissions: []
        });
      });
      window.CourseStore.save(state);
      const publicFallback = state.courses.find((item) => publishedCourseCodes.has(item.code))?.code || 'PEA5004';
      course = window.CourseStore.getCourse(
        state, publishedCourseCodes.has(requestedCode) ? requestedCode : publicFallback
      );
      renderCourse();
    } catch (error) {
      console.warn('Catálogo SQLite indisponível; usando as disciplinas locais.', error);
    }
    await loadRemoteCourse();
  }

  function renderCourseSwitcher() {
    const publicCourses = state.courses.filter((item) => publishedCourseCodes.has(item.code));
    $('#switcherGrid').innerHTML = publicCourses.map((item) => `
      <button class="course-option ${item.code === course.code ? 'active' : ''}"
        style="background-image:url('${esc(item.cover)}');--course-accent:${esc(item.accent)}"
        data-course="${esc(item.code)}" aria-label="Abrir ${esc(item.code)}: ${esc(item.shortTitle)}">
        <span class="option-top"><span>${esc(item.status)}</span><i aria-hidden="true"></i></span>
        <small>${esc(item.code)} · ${esc(item.semester)}</small>
        <strong>${esc(item.shortTitle)}</strong>
      </button>
    `).join('');
    $$('.course-option').forEach((button) => button.addEventListener('click', () => {
      const url = new URL(window.location.href);
      url.searchParams.set('curso', button.dataset.course);
      window.location.href = url.toString();
    }));
  }

  function renderModules() {
    const today = todayInCourseTimezone();
    const modules = remoteCourse?.sessions?.length ? remoteCourse.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      kicker: session.theme || 'Aula do semestre',
      summary: session.specialist_topic || session.notes || 'Materiais, artigos e conversa desta camada.',
      date: formatDatePart(session.session_date, { day: '2-digit', month: 'short' }),
      articles: session.articles?.length || 0,
      status: session.id === remoteCourse.next_class?.id ? 'current' : dateFromISO(session.session_date) < today ? 'done' : 'next',
      sessionId: session.id,
    })) : course.modules;
    $('#moduleGrid').innerHTML = modules.map((module, index) => `
      <article class="module-card ${esc(module.status)} reveal" style="--layer-index:${index};transition-delay:${Math.min(index * 45, 240)}ms">
        <span class="module-node" aria-hidden="true"></span>
        <div class="module-top"><span>Camada ${String(index + 1).padStart(2, '0')} · ${esc(module.kicker)}</span><span class="module-number">${module.status === 'done' ? '✓' : String(index + 1).padStart(2, '0')}</span></div>
        <h3>${esc(module.title)}</h3>
        <p>${esc(module.summary)}</p>
        <div class="module-meta"><span>${esc(module.date)}</span><span>${module.articles} ${module.articles === 1 ? 'artigo' : 'artigos'}</span></div>
        <button class="module-action" data-module="${module.id}" ${module.sessionId ? `data-room-session="${module.sessionId}"` : ''} aria-label="Abrir etapa ${index + 1}: ${esc(module.title)}">Abrir sala da etapa</button>
      </article>
    `).join('');

    $$('.module-action').forEach((button) => button.addEventListener('click', () => {
      const module = modules.find((item) => item.id === Number(button.dataset.module));
      if (!module) return;
      if (button.dataset.roomSession) {
        loadClassRoom(Number(button.dataset.roomSession));
        document.querySelector('#sala-aula').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        showToast(`${module.title} · ${statusLabel(module.status)}.`);
      }
    }));
  }

  function renderFolders() {
    const materials = remoteCourse?.drive_materials || [];
    const canSeeMaterials = Boolean(remoteCourse?.access?.authenticated || remoteCourse?.access?.public_resources);
    if (materials.length) {
      $('#folderList').innerHTML = materials.map((item) => {
        const size = item.size_bytes < 1024 * 1024 ? `${Math.max(1, Math.round(item.size_bytes / 1024))} KB` : `${(item.size_bytes / 1024 / 1024).toFixed(1)} MB`;
        return `<article class="synced-drive-file">
          <span class="drive-file-icon" aria-hidden="true">${item.mime_type.includes('pdf') ? 'PDF' : item.mime_type.includes('presentation') ? 'PPT' : 'ARQ'}</span>
          <div><strong>${esc(item.name)}</strong><small>${esc(item.relative_path || 'Pasta principal')} · ${esc(size)}</small></div>
          <button type="button" data-drive-download="${item.id}">Baixar <span aria-hidden="true">↓</span></button>
        </article>`;
      }).join('');
      $$('[data-drive-download]').forEach((button) => button.addEventListener('click', async () => {
        const item = materials.find((entry) => entry.id === Number(button.dataset.driveDownload));
        if (!item) return;
        button.disabled = true;
        try {
          const headers = {};
          const token = sessionStorage.getItem(tokenKey());
          if (token) headers.Authorization = `Bearer ${token}`;
          const response = await fetch(item.download_url, { headers });
          if (!response.ok) {
            let message = 'Não foi possível baixar este material.';
            try { message = (await response.json()).error || message; } catch (error) { /* resposta binária */ }
            throw new Error(message);
          }
          const href = URL.createObjectURL(await response.blob());
          const anchor = document.createElement('a');
          anchor.href = href;
          anchor.download = item.name;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(href), 1000);
        } catch (error) { showToast(error.message); }
        finally { button.disabled = false; }
      }));
      return;
    }
    if (remoteCourse) {
      $('#folderList').innerHTML = canSeeMaterials
        ? '<div class="drive-material-empty"><span>↻</span><div><strong>O acervo ainda não foi sincronizado.</strong><p>A professora precisa validar a pasta no painel docente.</p></div></div>'
        : '<div class="drive-material-empty"><span>◇</span><div><strong>Acervo protegido para a turma.</strong><p>Entre com seu token para consultar os arquivos sincronizados.</p></div></div>';
      return;
    }
    $('#folderList').innerHTML = (course.folders || []).map((folder) => `
      <div class="folder-row">
        <span class="folder-icon" aria-hidden="true"></span>
        <div><strong>${esc(folder.name)}</strong><small>${esc(folder.detail)}</small></div>
        <span class="folder-count">${folder.count} itens</span>
      </div>
    `).join('');
  }

  function renderReadings() {
    const readings = remoteCourse?.sessions?.flatMap((session, index) => (session.articles || []).map((article) => ({ ...article, module: index + 1 }))) || course.readings || [];
    setText('#readingCount', `${readings.length} ${readings.length === 1 ? 'artigo' : 'artigos'}`);
    $('#readingList').innerHTML = readings.slice(0, 4).map((reading) => `
      <article class="reading-row">
        <small><span>${esc(reading.code)}</span><span>Etapa ${esc(reading.module)}</span></small>
        <strong>${esc(reading.title)}</strong>
        <p>${esc(reading.author)}</p>
      </article>
    `).join('') || '<p class="empty-copy">As leituras aparecerão aqui quando forem cadastradas.</p>';
  }

  function renderPresentation() {
    $('#tipList').innerHTML = (course.presentationTips || []).map((tip) => `<li>${esc(tip)}</li>`).join('');
    renderPresentationOptions();
  }

  function renderPresentationOptions() {
    const kindSelect = $('#presentationKind');
    const targetSelect = $('#presentationTargetSelect');
    if (!kindSelect || !targetSelect) return;
    const sessions = remoteCourse?.sessions || [];
    const articleMode = kindSelect.value === 'article';
    $('#finalPresentationFields').hidden = articleMode;
    $$('input, textarea', $('#finalPresentationFields')).forEach((input) => { input.required = !articleMode && input.name !== 'slides'; });
    const options = articleMode
      ? sessions.filter((session) => session.choice_open).flatMap((session) => (session.articles || []).map((article) => ({
        id: article.id,
        label: `${article.code || 'ART'} · ${article.title}${article.available_for_choice ? '' : article.chosen_by_me ? ' · sua escolha' : ' · indisponível'}`,
        disabled: !article.available_for_choice,
      })))
      : sessions.map((session) => ({
        id: session.id,
        label: `${formatDatePart(session.session_date, { day: '2-digit', month: 'short' })} · ${session.title}`
      }));
    targetSelect.innerHTML = options.length
      ? options.map((item) => `<option value="${item.id}" ${item.disabled ? 'disabled' : ''}>${esc(item.label)}</option>`).join('')
      : `<option value="">${kindSelect.value === 'article' ? 'Nenhum artigo cadastrado' : 'Nenhuma aula cadastrada'}</option>`;
  }

  function updateAuthUI() {
    const logged = isAuthenticated();
    document.body.classList.toggle('is-authenticated', logged);
    const studentName = currentStudent?.name || sessionStorage.getItem(`${authKey()}-name`);
    setText('#accessLabel', logged ? (studentName || 'Aluno conectado') : 'Acessar a turma');
    $('#accessButton').setAttribute('aria-label', logged ? 'Sessão de aluno ativa' : 'Entrar com token da disciplina');
    $('#studentProfileLink').hidden = !logged;
    $('#studentProfileLink').href = `profile.html?role=student&curso=${encodeURIComponent(course.code)}`;
    setText('#accessCourseCode', course.code);
    setText('#accessScope', course.code);
    if ($('#gradesLocked')) renderGrades();
  }

  function renderCourse() {
    remoteCourse = null;
    $('#nextClassCard').hidden = true;
    $('#nextClassEmpty').hidden = true;
    document.documentElement.style.setProperty('--course-accent', course.accent || '#56d6ca');
    document.title = `${course.code} · Rota da Disciplina`;
    setText('#headerCourseCode', course.code);
    setText('#heroCode', course.code);
    setText('#heroTitle', course.title);
    setText('#heroDescription', course.description);
    setText('#heroSemester', course.semester.replace('semestre de', 'sem.'));
    setText('#heroProgress', `${course.progress}%`);
    setText('#heroDriveStatus', course.driveConnected ? 'Sincronizado' : 'Aguardando');
    $('#heroDriveDot').classList.toggle('pending', !course.driveConnected);
    setText('#nextClass', course.modules.find((module) => module.status === 'current')?.date || course.modules.find((module) => module.status === 'next')?.date || 'Concluído');
    setText('#factWorkload', course.workload);
    setText('#factCredits', course.credits);
    setText('#factMeetings', `${course.modules.length} etapas`);
    setText('#syllabusText', course.ementa);
    setText('#professorName', course.professor);
    setText('#drivePath', `${course.code}_${course.semester.includes('2027') ? '2027' : '2026'}`);
    setText('#syncTime', course.driveConnected ? course.updatedAt : 'Vínculo pendente');
    $('#heroMedia').style.backgroundImage = `url('${course.cover}')`;
    $('#briefingPhoto').style.backgroundImage = `url('${course.cover}')`;
    $('#objectiveList').innerHTML = course.objectives.map((objective) => `<div class="objective-item">${esc(objective)}</div>`).join('');
    $('#courseDescriptionLong').textContent = `Nesta rota, ${course.description.charAt(0).toLowerCase()}${course.description.slice(1)} Cada etapa conecta conceitos, evidências e uma decisão de engenharia.`;
    renderCourseSwitcher();
    renderModules();
    renderFolders();
    renderReadings();
    renderPresentation();
    updateAuthUI();
    renderGrades();
  }

  function toggleSwitcher(force) {
    const switcher = $('#courseSwitcher');
    const scrim = $('#switcherScrim');
    const shouldOpen = typeof force === 'boolean' ? force : switcher.hidden;
    switcher.hidden = !shouldOpen;
    scrim.hidden = !shouldOpen;
    $('#courseTrigger').setAttribute('aria-expanded', String(shouldOpen));
    document.body.classList.toggle('switcher-open', shouldOpen);
    if (shouldOpen) $('#closeSwitcher').focus();
  }

  function openAccess() {
    if (isAuthenticated()) {
      window.location.href = `profile.html?role=student&curso=${encodeURIComponent(course.code)}`;
      return;
    }
    $('#accessError').textContent = '';
    $('#accessDialog').showModal();
    setTimeout(() => $('#accessDialog input[name="identifier"]').focus(), 0);
  }

  function requireAccess(action) {
    if (!isAuthenticated()) {
      sessionStorage.setItem('rota-pending-action', action);
      openAccess();
      return false;
    }
    return true;
  }

  function runProtectedAction(action) {
    if (!requireAccess(action)) return;
    if (action === 'presentation') {
      $('#presentationDialog').showModal();
      return;
    }
    if (action === 'upload') {
      if (!remoteCourse?.sessions?.length) {
        showToast('A agenda da disciplina ainda não possui aulas para vincular o material.');
        return;
      }
      $('#uploadError').textContent = '';
      $('#uploadDialog').showModal();
      return;
    }
    if (action === 'drive') {
      if (remoteCourse?.drive_materials?.length) {
        document.querySelector('#materiais').scrollIntoView({ behavior: 'smooth' });
      } else {
        showToast(`O acervo de ${course.code} ainda aguarda uma sincronização válida da professora.`);
      }
      return;
    }
    if (action === 'meeting') {
      loadMeetingAccess({ focus: true });
    }
  }

  function setupAccess() {
    $('#accessButton').addEventListener('click', openAccess);
    $('#roomLoginButton').addEventListener('click', openAccess);
    $('#workspaceLoginButton').addEventListener('click', openAccess);
    $('#gradesLoginButton').addEventListener('click', openAccess);
    $('#openAccessFromHero').addEventListener('click', () => runProtectedAction('drive'));
    $$('.protected-action').forEach((button) => button.addEventListener('click', () => runProtectedAction(button.dataset.action)));

    $('#accessForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const identifier = String(form.get('identifier')).trim();
      const submit = formElement.querySelector('button[type="submit"]');
      let student;
      $('#accessError').textContent = '';
      submit.disabled = true;
      submit.classList.add('is-loading');
      try {
        const result = await apiRequest('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ course_code: course.code, identifier })
        });
        student = result.student;
        currentStudent = student;
        sessionStorage.setItem(tokenKey(), result.token);
      } catch (error) {
        if (error.status && error.status !== 404) {
          $('#accessError').textContent = error.message;
          submit.disabled = false;
          submit.classList.remove('is-loading');
          return;
        }
        student = course.students.find((item) => item.access && (item.nusp === identifier || item.email.toLowerCase() === identifier.toLowerCase()));
        if (!student) {
          $('#accessError').textContent = 'Os dados não correspondem à lista desta disciplina. Confira com a professora.';
          submit.disabled = false;
          submit.classList.remove('is-loading');
          return;
        }
        sessionStorage.setItem(authKey(), 'true');
      }
      currentStudent = student;
      sessionStorage.setItem(`${authKey()}-name`, student.name);
      submit.disabled = false;
      submit.classList.remove('is-loading');
      $('#accessDialog').close();
      formElement.reset();
      updateAuthUI();
      await loadRemoteCourse();
      await loadMeetingAccess();
      showToast(`Credencial gerada para ${student.name}. Acesso válido por 12 horas.`);
      const pending = sessionStorage.getItem('rota-pending-action');
      sessionStorage.removeItem('rota-pending-action');
      if (pending) setTimeout(() => runProtectedAction(pending), 250);
    });

    $('#accessRecoveryButton').addEventListener('click', () => {
      $('#accessRecovery').hidden = !$('#accessRecovery').hidden;
      if (!$('#accessRecovery').hidden) $('#recoveryIdentifier').focus();
    });
    $('#requestAccessButton').addEventListener('click', async () => {
      const identifier = $('#recoveryIdentifier').value.trim();
      if (!identifier) { $('#accessError').textContent = 'Informe seu e-mail ou Nº USP.'; return; }
      try {
        const result = await apiRequest('/api/auth/request-access', { method: 'POST', body: JSON.stringify({ course_code: course.code, identifier }) });
        $('#accessError').textContent = result.message;
      } catch (error) { $('#accessError').textContent = error.message; }
    });
  }

  function setupPresentation() {
    $('#presentationKind').addEventListener('change', renderPresentationOptions);
    $('#presentationForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const submission = {
        id: Date.now(),
        kind: String(form.get('kind')),
        target_id: Number(form.get('target_id')),
        group: String(form.get('group') || '').trim(),
        topic: String(form.get('topic') || '').trim(),
        members: String(form.get('members') || '').trim(),
        slides: String(form.get('slides') || '').trim(),
        createdAt: new Date().toISOString()
      };
      const submit = formElement.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        if (submission.kind === 'article') {
          await apiRequest(`/api/articles/${submission.target_id}/choose`, { method: 'POST', body: '{}' });
        } else {
          await apiRequest('/api/presentations', {
            method: 'POST',
            body: JSON.stringify({
              kind: submission.kind, target_id: submission.target_id,
              group_name: submission.group, topic: submission.topic,
              members: submission.members, slides_url: submission.slides
            })
          });
        }
      } catch (error) {
        if (error.status === 401) {
          sessionStorage.removeItem(tokenKey());
          sessionStorage.removeItem(authKey());
          updateAuthUI();
        }
        if (error.status) {
          showToast(error.message);
          submit.disabled = false;
          return;
        }
        course.submissions = course.submissions || [];
        course.submissions.push(submission);
        window.CourseStore.save(state);
      }
      submit.disabled = false;
      $('#presentationDialog').close();
      formElement.reset();
      await loadRemoteCourse();
      renderPresentationOptions();
      showToast(submission.kind === 'article' ? 'Artigo confirmado. A resenha e a apresentação apareceram no seu painel.' : `Apresentação do ${submission.group} reservada.`);
    });
  }

  function setupUpload() {
    $$('[data-close]').forEach((button) => button.addEventListener('click', () => {
      const dialog = $(`#${button.dataset.close}`);
      if (dialog?.open) dialog.close();
    }));
    $('#uploadForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorElement = $('#uploadError');
      const progress = $('#uploadProgress');
      const submit = event.currentTarget.querySelector('button[type="submit"]');
      errorElement.textContent = '';
      progress.hidden = false;
      submit.disabled = true;
      try {
        const payload = new FormData(event.currentTarget);
        await apiRequest('/api/uploads', { method: 'POST', body: payload });
        $('#uploadDialog').close();
        event.currentTarget.reset();
        await loadRemoteCourse();
        renderUploadOptions();
        showToast('Material enviado. A professora já pode consultá-lo no painel docente.');
      } catch (error) {
        if (error.status === 401) {
          sessionStorage.removeItem(tokenKey());
          sessionStorage.removeItem(authKey());
          updateAuthUI();
        }
        errorElement.textContent = error.message;
      } finally {
        progress.hidden = true;
        submit.disabled = false;
      }
    });
  }

  function setupClassRoom() {
    let savedLinkRange = null;
    $('#roomResourceForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget).entries());
      try {
        await apiRequest(`/api/sessions/${activeRoomSessionId}/resources`, {
          method: 'POST', body: JSON.stringify(values)
        });
        event.currentTarget.reset();
        await loadClassRoom();
        showToast('Link adicionado aos materiais da aula.');
      } catch (error) { showToast(error.message); }
    });

    $$('[data-rich-command]').forEach((button) => button.addEventListener('click', () => {
      $('#roomCommentEditor').focus();
      document.execCommand(button.dataset.richCommand, false);
    }));
    $('[data-rich-link]').addEventListener('click', () => {
      const selection = window.getSelection();
      savedLinkRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      $('#roomRichLinkFields').hidden = false;
      $('#roomRichLink').focus();
    });
    $('#applyRoomRichLink').addEventListener('click', () => {
      const url = $('#roomRichLink').value.trim();
      if (!url) return;
      const selection = window.getSelection();
      if (savedLinkRange && selection) { selection.removeAllRanges(); selection.addRange(savedLinkRange); }
      $('#roomCommentEditor').focus();
      document.execCommand('createLink', false, url);
      $('#roomRichLink').value = '';
      $('#roomRichLinkFields').hidden = true;
    });
    $('#roomCommentForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const editor = $('#roomCommentEditor');
      if (!editor.textContent.trim()) { showToast('Escreva um comentário antes de publicar.'); return; }
      try {
        await apiRequest(`/api/sessions/${activeRoomSessionId}/comments`, {
          method: 'POST', body: JSON.stringify({ content_html: editor.innerHTML })
        });
        editor.innerHTML = '';
        await loadClassRoom();
      } catch (error) { showToast(error.message); }
    });
  }

  function setupMotion() {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const root = document.documentElement;
    const hero = $('.cinematic-hero');
    const route = $('.course-map');
    const routeGlow = $('.route-glow');
    const briefing = $('.briefing-section');
    const presentation = $('.presentation-section');
    const scenes = $$('[data-cinematic-scene]');
    const chapterLinks = $$('[data-cinematic-link]');
    const observed = new WeakSet();

    const revealObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in-view');
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: .12, rootMargin: '0px 0px -7% 0px' }) : null;

    function registerReveals(scope = document) {
      const candidates = [];
      if (scope.matches?.('.reveal')) candidates.push(scope);
      candidates.push(...(scope.querySelectorAll?.('.reveal') || []));
      candidates.forEach((item) => {
        if (observed.has(item)) return;
        observed.add(item);
        if (reduced || !revealObserver) item.classList.add('in-view');
        else revealObserver.observe(item);
      });
    }

    registerReveals();
    const revealMutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) registerReveals(node);
      }));
    });
    revealMutationObserver.observe($('#conteudo'), { childList: true, subtree: true });

    let routeLength = 0;
    if (routeGlow) {
      routeLength = routeGlow.getTotalLength();
      routeGlow.style.strokeDasharray = `${routeLength}`;
      routeGlow.style.strokeDashoffset = `${routeLength}`;
    }

    function sectionProgress(element, start = .82, end = .18) {
      if (!element) return 0;
      const rect = element.getBoundingClientRect();
      const travel = window.innerHeight * (start - end) + rect.height;
      return Math.min(1, Math.max(0, (window.innerHeight * start - rect.top) / travel));
    }

    let ticking = false;
    function updateScroll() {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const progress = max > 0 ? window.scrollY / max : 0;
      $('#scrollProgress').style.width = `${Math.min(100, progress * 100)}%`;
      $('#siteHeader').classList.toggle('compact', window.scrollY > 40);
      root.style.setProperty('--cine-progress', progress.toFixed(4));

      if (!reduced) {
        const heroExit = Math.min(1, window.scrollY / Math.max(1, hero.offsetHeight * .82));
        root.style.setProperty('--hero-exit', heroExit.toFixed(4));
        root.style.setProperty('--hero-shift', Math.min(135, window.scrollY * .13).toFixed(2));
        root.style.setProperty('--hero-zoom', (heroExit * .1).toFixed(4));

        const briefingProgress = sectionProgress(briefing, .95, .05);
        root.style.setProperty('--briefing-shift', ((briefingProgress - .5) * 92).toFixed(2));

        const presentationProgress = sectionProgress(presentation, .9, .1);
        root.style.setProperty('--orbit-turn', `${(presentationProgress * 48).toFixed(2)}deg`);

        if (routeGlow && routeLength) {
          const routeProgress = sectionProgress(route, .82, .34);
          routeGlow.style.strokeDashoffset = `${routeLength * (1 - routeProgress)}`;
        }
      }

      const focusLine = window.innerHeight * .43;
      let activeScene = scenes[0];
      let activeDistance = Number.POSITIVE_INFINITY;
      scenes.forEach((scene) => {
        const rect = scene.getBoundingClientRect();
        const containsFocus = rect.top <= focusLine && rect.bottom >= focusLine;
        const distance = containsFocus ? 0 : Math.min(Math.abs(rect.top - focusLine), Math.abs(rect.bottom - focusLine));
        scene.style.setProperty('--scene-proximity', String(Math.max(0, 1 - distance / window.innerHeight)));
        scene.classList.toggle('scene-active', containsFocus);
        if (distance < activeDistance) {
          activeDistance = distance;
          activeScene = scene;
        }
      });
      chapterLinks.forEach((link) => {
        link.classList.toggle('active', link.dataset.cinematicLink === activeScene?.id);
      });
      ticking = false;
    }

    function scheduleScrollUpdate() {
      if (!ticking) {
        window.requestAnimationFrame(updateScroll);
        ticking = true;
      }
    }

    window.addEventListener('scroll', scheduleScrollUpdate, { passive: true });
    window.addEventListener('resize', scheduleScrollUpdate, { passive: true });
    if (!reduced && hero) {
      hero.addEventListener('pointermove', (event) => {
        const bounds = hero.getBoundingClientRect();
        root.style.setProperty('--pointer-x', (((event.clientX - bounds.left) / bounds.width) * 2 - 1).toFixed(3));
        root.style.setProperty('--pointer-y', (((event.clientY - bounds.top) / bounds.height) * 2 - 1).toFixed(3));
      }, { passive: true });
      hero.addEventListener('pointerleave', () => {
        root.style.setProperty('--pointer-x', '0');
        root.style.setProperty('--pointer-y', '0');
      }, { passive: true });
    }
    document.body.classList.add('cinematic-ready');
    updateScroll();
  }

  $('#courseTrigger').addEventListener('click', () => toggleSwitcher());
  $('#closeSwitcher').addEventListener('click', () => toggleSwitcher(false));
  $('#switcherScrim').addEventListener('click', () => toggleSwitcher(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#courseSwitcher').hidden) toggleSwitcher(false);
  });

  renderCourse();
  setupAccess();
  setupPresentation();
  setupUpload();
  setupClassRoom();
  setupMotion();
  bootstrapRemoteCourse();
}());
