(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const courseCode = (params.get('curso') || 'PEA5004').toUpperCase();
  const requestedRole = params.get('role');
  const adminToken = sessionStorage.getItem('rota-admin-token');
  const studentTokenKey = `rota-token-${courseCode}`;
  const studentToken = sessionStorage.getItem(studentTokenKey);
  const role = requestedRole === 'teacher' || (!requestedRole && adminToken) ? 'teacher' : 'student';
  const $ = (selector) => document.querySelector(selector);
  let profile;
  let toastTimer;

  async function apiRequest(path, options = {}) {
    const token = role === 'teacher' ? adminToken : studentToken;
    const response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}`, ...(options.headers || {}) }
    });
    let payload = {};
    try { payload = await response.json(); } catch (error) { payload = {}; }
    if (!response.ok) throw new Error(payload.error || 'Não foi possível concluir esta ação.');
    return payload;
  }

  function showToast(message) {
    $('#toast').textContent = message;
    $('#toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3200);
  }

  function initials(name = '') {
    return name.replace(/Profa?\.?/i, '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '—';
  }

  function revealWorkspace(name, label, scope) {
    $('#profileGate').hidden = true;
    $('#profileWorkspace').hidden = false;
    $('#profileInitials').textContent = initials(name);
    $('#profileDisplayName').textContent = name;
    $('#profileRoleLabel').textContent = label;
    $('#profileScope').textContent = scope;
  }

  function showGate() {
    $('#profileWorkspace').hidden = true;
    $('#profileGate').hidden = false;
    if (role === 'teacher') {
      $('#profileGateCopy').textContent = 'Entre novamente no painel docente para editar a conta da professora.';
      $('#profileLoginLink').href = `admin.html?curso=${encodeURIComponent(courseCode)}#visao`;
      $('#profileLoginLink').textContent = 'Ir para o painel docente';
    } else {
      $('#profileGateCopy').textContent = `Acesse ${courseCode} com seu e-mail, Nº USP ou token para editar o perfil.`;
      $('#profileLoginLink').href = `index.html?curso=${encodeURIComponent(courseCode)}`;
      $('#profileLoginLink').textContent = 'Entrar na disciplina';
    }
  }

  async function loadProfile() {
    $('#profileBackLink').href = role === 'teacher' ? `admin.html?curso=${encodeURIComponent(courseCode)}#visao` : `index.html?curso=${encodeURIComponent(courseCode)}`;
    if ((role === 'teacher' && !adminToken) || (role === 'student' && !studentToken)) { showGate(); return; }
    try {
      if (role === 'teacher') {
        const result = await apiRequest('/api/admin/me');
        profile = result.teacher;
        $('#profileRoleKicker').textContent = 'Conta da professora';
        revealWorkspace(profile.name, 'Professora administradora', 'PEA · Escola Politécnica da USP');
        $('#teacherProfilePanel').hidden = false;
        $('#teacherPasswordPanel').hidden = false;
        const form = $('#teacherProfileForm');
        form.elements.name.value = profile.name || '';
        form.elements.username.value = profile.username || '';
        form.elements.email.value = profile.email || '';
      } else {
        const result = await apiRequest('/api/me');
        profile = result.student;
        $('#profileRoleKicker').textContent = 'Conta do aluno';
        revealWorkspace(profile.name, 'Aluno cadastrado', `${profile.course_code || courseCode} · Nº USP ${profile.nusp}`);
        $('#studentProfilePanel').hidden = false;
        $('#studentCredentialPanel').hidden = false;
        $('#studentCourseLabel').textContent = profile.course_code || courseCode;
        const form = $('#studentProfileForm');
        ['name', 'email', 'nusp', 'group_name'].forEach((field) => { form.elements[field].value = profile[field] || ''; });
      }
    } catch (error) { showGate(); }
  }

  $('#teacherProfileForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    $('#teacherProfileMessage').textContent = '';
    try {
      const result = await apiRequest('/api/admin/profile', { method: 'PUT', body: JSON.stringify(values) });
      profile = result.teacher;
      revealWorkspace(profile.name, 'Professora administradora', 'PEA · Escola Politécnica da USP');
      $('#teacherProfileMessage').textContent = 'Dados atualizados.';
      showToast('Perfil docente atualizado.');
    } catch (error) { $('#teacherProfileMessage').textContent = error.message; }
  });

  $('#teacherPasswordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const message = $('#teacherPasswordMessage');
    message.textContent = '';
    if (values.new_password !== values.confirm_password) { message.textContent = 'As novas senhas não coincidem.'; return; }
    try {
      await apiRequest('/api/admin/password', { method: 'PUT', body: JSON.stringify(values) });
      event.currentTarget.reset();
      message.textContent = 'Senha atualizada com sucesso.';
      showToast('Nova senha docente salva.');
    } catch (error) { message.textContent = error.message; }
  });

  $('#studentProfileForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const message = $('#studentProfileMessage');
    message.textContent = '';
    try {
      const result = await apiRequest('/api/student/profile', { method: 'PUT', body: JSON.stringify(values) });
      profile = result.student;
      sessionStorage.setItem(`rota-access-${courseCode}-name`, profile.name);
      revealWorkspace(profile.name, 'Aluno cadastrado', `${profile.course_code || courseCode} · Nº USP ${profile.nusp}`);
      message.textContent = 'Dados atualizados.';
      showToast('Perfil do aluno atualizado.');
    } catch (error) { message.textContent = error.message; }
  });

  $('#rotateStudentToken').addEventListener('click', async () => {
    $('#studentTokenMessage').textContent = '';
    try {
      const result = await apiRequest('/api/student/token', { method: 'POST', body: '{}' });
      $('#studentTokenValue').textContent = result.access_token;
      $('#studentTokenReveal').hidden = false;
      showToast('Novo token criado. Copie antes de sair.');
    } catch (error) { $('#studentTokenMessage').textContent = error.message; }
  });

  $('#copyStudentToken').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#studentTokenValue').textContent);
    showToast('Token copiado.');
  });

  loadProfile();
}());
