(function () {
  'use strict';

  let state = window.CourseStore.load();
  const params = new URLSearchParams(window.location.search);
  const requestedCode = (params.get('curso') || 'PEA5004').toUpperCase();
  let course = window.CourseStore.getCourse(state, requestedCode);
  let remoteCourse = null;
  let currentStudent = null;
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
      return `<article class="next-article">
        <span>${esc(article.code || 'ART')}</span>
        <div><strong>${esc(article.title)}</strong><small>${esc(article.author || 'Autoria a confirmar')}</small><small class="presenter-line">${presenters ? `Apresentação: ${esc(presenters)}` : 'Apresentadores a definir'}</small></div>
      </article>`;
    }).join('') : '<p class="next-article-empty">Os artigos e apresentadores desta aula ainda serão cadastrados.</p>';
    renderMeetingGate();
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
    select.innerHTML = sessions.map((session) => `<option value="${session.id}" ${session.id === remoteCourse?.next_class?.id ? 'selected' : ''}>${esc(formatDatePart(session.session_date, { day: '2-digit', month: 'short' }))} · ${esc(session.title)}</option>`).join('');
    const syncArticles = () => {
      const selected = sessions.find((session) => session.id === Number(select.value));
      const articleSelect = $('#uploadArticleSelect');
      articleSelect.innerHTML = '<option value="">Material geral da aula</option>' + (selected?.articles || []).map((article) => `<option value="${article.id}">${esc(article.code || 'Artigo')} · ${esc(article.title)}</option>`).join('');
    };
    select.onchange = syncArticles;
    syncArticles();
    const deliverableSelect = $('#uploadDeliverableSelect');
    const deliverableTypes = remoteCourse?.deliverable_types || [];
    deliverableSelect.innerHTML = deliverableTypes.length
      ? deliverableTypes.map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join('')
      : '<option value="">Nenhum tipo de entrega cadastrado</option>';
  }

  async function loadRemoteCourse() {
    try {
      remoteCourse = await apiRequest(`/api/courses/${encodeURIComponent(course.code)}`);
      course.driveUrl = remoteCourse.drive_url || course.driveUrl;
      course.driveConnected = Boolean(remoteCourse.drive_connected);
      setText('#heroDriveStatus', course.driveConnected ? 'Sincronizado' : 'Aguardando');
      $('#heroDriveDot').classList.toggle('pending', !course.driveConnected);
      setText('#syncTime', course.driveConnected ? course.updatedAt : 'Vínculo pendente');
      renderNextClass();
      renderUploadOptions();
      renderPresentationOptions();
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
      catalog.forEach((item) => {
        const existing = state.courses.find((local) => local.code === item.code);
        if (existing) {
          Object.assign(existing, {
            title: item.title, shortTitle: item.short_title, semester: item.semester,
            status: item.status, visibility: item.visibility, updatedAt: item.updated_at,
            cover: item.cover || existing.cover, driveUrl: item.drive_url,
            driveConnected: Boolean(item.drive_connected)
          });
          return;
        }
        state.courses.push({
          code: item.code, title: item.title, shortTitle: item.short_title, semester: item.semester,
          status: item.status, visibility: item.visibility, progress: 0, credits: 4, workload: '60 h',
          classDay: 'A definir', room: 'A definir', professor: 'Profa. Dra. Lídia Rebello Dias',
          updatedAt: item.updated_at, cover: item.cover || 'assets/course-pea5004.webp', accent: '#56d6ca',
          driveUrl: item.drive_url, driveConnected: Boolean(item.drive_connected),
          description: 'Uma nova rota de aprendizagem.', ementa: 'Cadastre a ementa desta disciplina.',
          objectives: ['Cadastrar o primeiro objetivo.'], folders: [], modules: [], readings: [],
          presentationTips: ['Abra com o problema.'], students: [], submissions: []
        });
      });
      window.CourseStore.save(state);
      course = window.CourseStore.getCourse(state, requestedCode);
      renderCourse();
    } catch (error) {
      console.warn('Catálogo SQLite indisponível; usando as disciplinas locais.', error);
    }
    await loadRemoteCourse();
  }

  function renderCourseSwitcher() {
    $('#switcherGrid').innerHTML = state.courses.map((item) => `
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
    $('#moduleGrid').innerHTML = course.modules.map((module, index) => `
      <article class="module-card ${esc(module.status)} reveal" style="transition-delay:${Math.min(index * 45, 240)}ms">
        <span class="module-node" aria-hidden="true"></span>
        <div class="module-top"><span>${esc(module.kicker)}</span><span class="module-number">${String(index + 1).padStart(2, '0')}</span></div>
        <h3>${esc(module.title)}</h3>
        <p>${esc(module.summary)}</p>
        <div class="module-meta"><span>${esc(module.date)}</span><span>${module.articles} ${module.articles === 1 ? 'artigo' : 'artigos'}</span></div>
        <button class="module-action" data-module="${module.id}" aria-label="Abrir etapa ${index + 1}: ${esc(module.title)}">Abrir etapa</button>
      </article>
    `).join('');

    $$('.module-action').forEach((button) => button.addEventListener('click', () => {
      const module = course.modules.find((item) => item.id === Number(button.dataset.module));
      if (!module) return;
      showToast(`${module.title} · ${statusLabel(module.status)}. Os materiais estão no acervo abaixo.`);
      document.querySelector('#materiais').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }

  function renderFolders() {
    $('#folderList').innerHTML = course.folders.map((folder) => `
      <div class="folder-row">
        <span class="folder-icon" aria-hidden="true"></span>
        <div><strong>${esc(folder.name)}</strong><small>${esc(folder.detail)}</small></div>
        <span class="folder-count">${folder.count} itens</span>
      </div>
    `).join('');
  }

  function renderReadings() {
    const readings = course.readings || [];
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
    const options = kindSelect.value === 'article'
      ? sessions.flatMap((session) => (session.articles || []).map((article) => ({
        id: article.id,
        label: `${article.code || 'ART'} · ${article.title}`
      })))
      : sessions.map((session) => ({
        id: session.id,
        label: `${formatDatePart(session.session_date, { day: '2-digit', month: 'short' })} · ${session.title}`
      }));
    targetSelect.innerHTML = options.length
      ? options.map((item) => `<option value="${item.id}">${esc(item.label)}</option>`).join('')
      : `<option value="">${kindSelect.value === 'article' ? 'Nenhum artigo cadastrado' : 'Nenhuma aula cadastrada'}</option>`;
  }

  function updateAuthUI() {
    const logged = isAuthenticated();
    document.body.classList.toggle('is-authenticated', logged);
    const studentName = currentStudent?.name || sessionStorage.getItem(`${authKey()}-name`);
    setText('#accessLabel', logged ? (studentName || 'Aluno conectado') : 'Acessar a turma');
    $('#accessButton').setAttribute('aria-label', logged ? 'Sessão de aluno ativa' : 'Entrar com e-mail ou Nº USP');
    setText('#accessCourseCode', course.code);
    setText('#accessScope', course.code);
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
      showToast(`Credencial ativa em ${course.code} por até 12 horas.`);
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
      if (course.driveConnected && course.driveUrl) {
        window.open(course.driveUrl, '_blank', 'noopener,noreferrer');
      } else {
        showToast(`O Drive de ${course.code} ainda aguarda o vínculo da professora.`);
      }
      return;
    }
    if (action === 'meeting') {
      loadMeetingAccess({ focus: true });
    }
  }

  function setupAccess() {
    $('#accessButton').addEventListener('click', openAccess);
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
      await loadMeetingAccess();
      showToast(`Credencial gerada para ${student.name}. Acesso válido por 12 horas.`);
      const pending = sessionStorage.getItem('rota-pending-action');
      sessionStorage.removeItem('rota-pending-action');
      if (pending) setTimeout(() => runProtectedAction(pending), 250);
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
        group: String(form.get('group')).trim(),
        topic: String(form.get('topic')).trim(),
        members: String(form.get('members')).trim(),
        slides: String(form.get('slides')).trim(),
        createdAt: new Date().toISOString()
      };
      const submit = formElement.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await apiRequest('/api/presentations', {
          method: 'POST',
          body: JSON.stringify({
            kind: submission.kind,
            target_id: submission.target_id,
            group_name: submission.group,
            topic: submission.topic,
            members: submission.members,
            slides_url: submission.slides
          })
        });
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
      renderPresentationOptions();
      showToast(`Apresentação do ${submission.group} reservada. A professora já pode consultá-la.`);
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
  setupMotion();
  bootstrapRemoteCourse();
}());
