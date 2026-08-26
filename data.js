(function () {
  const STORAGE_KEY = 'rota-disciplinas-v1';

  const seed = {
    version: 2,
    courses: [
      {
        code: 'PEA5004',
        title: 'Sistemas de Automação para Monitoramento e Segurança Pública, Privada e Ambiental para Área Portuária',
        shortTitle: 'Monitoramento e segurança portuária',
        semester: '2º semestre de 2026',
        status: 'Publicada',
        visibility: 'Somente alunos cadastrados',
        progress: 38,
        credits: 8,
        workload: '120 h',
        catalogUrl: 'https://uspdigital.usp.br/janus/componente/catalogoDisciplinasInicial.jsf?action=3&sgldis=PEA5004',
        classDay: 'Quartas · 14h',
        room: 'PEA · Sala A2-06',
        professor: 'Profa. Dra. Lídia Rebello Dias',
        updatedAt: '25 ago. 2026 · 18:42',
        cover: 'assets/course-pea5004.webp',
        coverMediaType: 'video',
        coverVideo: 'assets/pea5004-hero.webm',
        accent: '#56d6ca',
        driveUrl: '',
        driveConnected: false,
        driveEmail: 'lidia.rebello.dias@usp.br',
        description: 'Apresentar os sistemas de segurança e monitoramento para as áreas ambiental e operacional dos portos sob os enfoques público e privado, conectando automação, competitividade e inovação portuária.',
        ementa: '[1] Metodologia científica e publicação em artigo.\n[2] Atividades de inovação no setor portuário.\n[3] Gestão e modelagem de processos, PMBOK e metodologias ágeis.\n[4] Equipamentos e sistemas de mobilidade aplicados à segurança.\n[5] Sistema Portuário Brasileiro e Port Community System (PCS).\n[6] Proteção e transferência de dados na Administração Pública, LAI e LGPD.\n[7] Sistemas de gestão e gerenciamento de riscos em portos e instalações portuárias.\n[8] Automação de sistemas de transporte, logísticos, ambientais e portuários.\n[9] Sistemas de gestão de terminais de contêineres.\n[10] ISPS Code e sua aplicação.',
        objectives: [
          'Compreender os sistemas de segurança e monitoramento ambiental e operacional dos portos.',
          'Relacionar automação, inovação e competitividade do sistema portuário.',
          'Analisar aplicações públicas e privadas de gestão de riscos, dados e segurança.',
          'Desenvolver e comunicar pesquisa científica aplicada ao setor.'
        ],
        folders: [
          { name: '01. Sobre o curso', detail: 'Ementa, critérios e cronograma', count: 4 },
          { name: '02. Textos', detail: 'Leituras de apoio por encontro', count: 12 },
          { name: '03. Resenhas', detail: 'Entregas individuais', count: 8 },
          { name: '04. Artigos e mapas', detail: 'Artigos e mapas conceituais', count: 18 },
          { name: '05. Modelos', detail: 'Modelos de resenha e artigo', count: 5 },
          { name: '06. Aulas', detail: 'Slides dos grupos e convidados', count: 22 }
        ],
        modules: [
          { id: 1, title: 'O porto como sistema vivo', kicker: 'Fundamentos', summary: 'Riscos, atores e camadas de monitoramento em uma operação portuária.', date: '19 ago.', duration: '35 min', articles: 2, status: 'done' },
          { id: 2, title: 'Risco público, privado e ambiental', kicker: 'Cenários', summary: 'Matriz de risco e resposta integrada para terminais de uso misto.', date: '26 ago.', duration: '50 min', articles: 2, status: 'done' },
          { id: 3, title: 'Sensores na linha d\'\u00e1gua', kicker: 'Percepção', summary: 'IoT, qualidade do ar, água, ruído e detecção perimetral.', date: '02 set.', duration: '45 min', articles: 2, status: 'current' },
          { id: 4, title: 'Visão computacional', kicker: 'Vigilância', summary: 'CFTV inteligente, rastreamento e limites do reconhecimento automatizado.', date: '09 set.', duration: '55 min', articles: 2, status: 'next' },
          { id: 5, title: 'Identidade e acesso', kicker: 'Proteção', summary: 'Credenciais, biometria e integração com o ISPS Code.', date: '16 set.', duration: '40 min', articles: 2, status: 'next' },
          { id: 6, title: 'Redes que não podem parar', kicker: 'Comunicação', summary: '5G privativo, LPWAN, redundância e comunicação crítica.', date: '23 set.', duration: '50 min', articles: 2, status: 'next' },
          { id: 7, title: 'Centro de controle integrado', kicker: 'Orquestração', summary: 'Da telemetria à decisão: alarmes, contexto e resposta operacional.', date: '30 set.', duration: '55 min', articles: 2, status: 'next' },
          { id: 8, title: 'Projeto: porto seguro', kicker: 'Entrega final', summary: 'Proposta em grupo conectando problema, evidência e arquitetura.', date: '18 nov.', duration: 'Projeto', articles: 4, status: 'next' }
        ],
        readings: [
          { code: 'A01', author: 'Yau et al.', title: 'Towards Smart Port Infrastructures: Enhancing Port Activities using ICT', module: 1 },
          { code: 'A02', author: 'Giovannetti et al.', title: 'Assessing Port Facility Safety: A Comparative Analysis of Global Accident and Injury Databases', module: 2 },
          { code: 'A03', author: 'El Idrissi et al.', title: 'Deployment Strategies of Mobile Networks for IoT in Smart Maritime Ports', module: 3 },
          { code: 'A05', author: 'Wang, Hu & Zhang', title: 'Multi-Source Transfer Network for Cross Domain Person Re-Identification', module: 4 }
        ],
        presentationTips: [
          'Abra com o problema, não com o sumário do artigo.',
          'Mostre uma figura que sustente a tese central.',
          'Separe evidência do artigo e interpretação do grupo.',
          'Feche com uma pergunta que conecte o estudo ao porto real.'
        ],
        students: [
          { name: 'Ana Souza', email: 'ana.souza@usp.br', nusp: '12345678', group: 'Grupo Farol', access: true },
          { name: 'Bruno Lima', email: 'bruno.lima@usp.br', nusp: '11223344', group: 'Grupo Maré', access: true },
          { name: 'Carla Nunes', email: 'carla.nunes@usp.br', nusp: '88776655', group: '—', access: true }
        ],
        submissions: []
      },
      {
        code: 'PEA5003',
        title: 'Componentes de Automação em ITS - Sistemas Inteligentes de Transportes',
        shortTitle: 'Componentes de automação em ITS',
        semester: '1º semestre de 2027',
        status: 'Rascunho',
        visibility: 'Somente alunos cadastrados',
        progress: 0,
        credits: 8,
        workload: '120 h',
        catalogUrl: 'https://uspdigital.usp.br/janus/componente/catalogoDisciplinasInicial.jsf?action=3&sgldis=PEA5003',
        classDay: 'Terças · 14h',
        room: 'PEA · Sala B1-02',
        professor: 'Profa. Dra. Lídia Rebello Dias',
        updatedAt: '20 ago. 2026 · 09:15',
        cover: 'assets/course-pea5003.webp',
        coverMediaType: 'video',
        coverVideo: 'assets/pea5003-hero.webm',
        accent: '#65b8ff',
        driveUrl: 'https://drive.google.com/drive/folders/1Z6EvnGAYkvGZZKKyOVzmxDa0AjveNKFz',
        driveConnected: true,
        driveEmail: 'lidia.rebello.dias@usp.br',
        description: 'Apresentar os principais componentes de automação envolvidos nos processos da cadeia logística: infraestrutura tecnológica, componentes embarcados e de comunicação, normatizações e estudos de caso do Gaesi/EPUSP.',
        ementa: '[1] Metodologia científica.\n[2] Cidades inteligentes e componentes tecnológicos.\n[3] Integração de informação para a mobilidade urbana.\n[4] Gestão por processos de negócios para centros integrados de mobilidade.\n[5] Transporte sustentável.\n[6] Análise de risco.\n[7] Casos de rastreabilidade de combustível, SAT e zeladoria urbana.',
        objectives: ['Compreender a infraestrutura tecnológica da cadeia logística.', 'Analisar componentes embarcados e de comunicação.', 'Relacionar automação, normatização, segurança, custo e desempenho operacional.'],
        folders: [
          { name: '01. Plano de ensino', detail: 'Ementa e cronograma', count: 3 },
          { name: '02. Componentes', detail: 'Datasheets e guias', count: 14 },
          { name: '03. Estudos de caso', detail: 'Corredores e cruzamentos', count: 7 },
          { name: '04. Entregas', detail: 'Projetos da turma', count: 0 }
        ],
        modules: [
          { id: 1, title: 'Anatomia de um ITS', kicker: 'Arquitetura', summary: 'Campo, comunicação, controle e informação ao usuário.', date: 'A definir', duration: '45 min', articles: 1, status: 'next' },
          { id: 2, title: 'Detectar o movimento', kicker: 'Sensores', summary: 'Laços, radar, lidar, vídeo e fusão de dados.', date: 'A definir', duration: '50 min', articles: 2, status: 'next' },
          { id: 3, title: 'Controlar o cruzamento', kicker: 'Controle', summary: 'Controladores semafóricos e estratégias adaptativas.', date: 'A definir', duration: '50 min', articles: 2, status: 'next' },
          { id: 4, title: 'Veículo conectado', kicker: 'V2X', summary: 'Comunicação cooperativa e infraestrutura conectada.', date: 'A definir', duration: '45 min', articles: 2, status: 'next' },
          { id: 5, title: 'Centro de mobilidade', kicker: 'Supervisão', summary: 'Operação, alarmes e indicadores de desempenho.', date: 'A definir', duration: '55 min', articles: 1, status: 'next' },
          { id: 6, title: 'Projeto de corredor', kicker: 'Entrega final', summary: 'Arquitetura ITS para um corredor urbano real.', date: 'A definir', duration: 'Projeto', articles: 3, status: 'next' }
        ],
        readings: [
          { code: 'ITS-01', author: 'Leitura a cadastrar', title: 'Fundamentos e arquitetura de Sistemas Inteligentes de Transporte', module: 1 }
        ],
        presentationTips: ['Defina o cenário operacional.', 'Use diagrama de blocos.', 'Explicite interfaces e falhas.'],
        students: [],
        submissions: []
      },
      {
        code: 'PEA5714',
        title: 'Automação Sistemas Industriais e Portuários',
        shortTitle: 'Automação industrial e portuária',
        semester: '1º semestre de 2026',
        status: 'Arquivada',
        visibility: 'Somente alunos cadastrados',
        progress: 100,
        credits: 8,
        workload: '120 h',
        catalogUrl: 'https://uspdigital.usp.br/janus/componente/catalogoDisciplinasInicial.jsf?action=3&sgldis=PEA5714',
        classDay: 'Quintas · 16h',
        room: 'PEA · Sala A1-04',
        professor: 'Profa. Dra. Lídia Rebello Dias',
        updatedAt: '02 jul. 2026 · 17:30',
        cover: 'assets/course-pea5714.webp',
        accent: '#ffb15c',
        driveUrl: 'https://drive.google.com/drive/folders/11BmJQxhewM4_X3u4yks6lKbxnWUIb7BG',
        driveConnected: true,
        driveEmail: 'lidia.rebello.dias@usp.br',
        description: 'Apresentar os setores portuário e industrial brasileiros, seus atores, desafios e oportunidades com foco em automação de processos, ambiente regulatório, tecnologias emergentes e legadas e gestão de riscos.',
        ementa: '[1] Conceitos da pesquisa científica.\n[2] Ferramentas de automação no comércio exterior via portos.\n[3] Operador Econômico Autorizado (OEA).\n[4] Meio ambiente, saúde e segurança em ambientes portuários.\n[5] Modelo de logística portuária.\n[6] Análise e gestão de risco na automação industrial e portuária.\n[7] Tecnologias legadas e emergentes.\n[8] Estudos de caso.',
        objectives: ['Compreender o funcionamento dos setores industrial e portuário brasileiros.', 'Analisar modelos e tecnologias viabilizadoras de automação.', 'Comparar padrões, regulações e estratégias de gestão de riscos.'],
        folders: [
          { name: '01. Curso', detail: 'Plano e cronograma', count: 4 },
          { name: '02. Aulas', detail: 'Slides e laboratórios', count: 24 },
          { name: '03. Projetos', detail: 'Entregas finais', count: 11 },
          { name: '04. Referências', detail: 'Normas e artigos', count: 18 }
        ],
        modules: [
          { id: 1, title: 'Arquiteturas industriais', kicker: 'Fundamentos', summary: 'Pirâmide de automação e integração vertical.', date: 'Concluído', duration: '45 min', articles: 2, status: 'done' },
          { id: 2, title: 'PLC e controle discreto', kicker: 'Controle', summary: 'Lógica, estados e intertravamentos.', date: 'Concluído', duration: '50 min', articles: 2, status: 'done' },
          { id: 3, title: 'SCADA e operação', kicker: 'Supervisão', summary: 'Telas, alarmes e contexto para decisão.', date: 'Concluído', duration: '50 min', articles: 2, status: 'done' },
          { id: 4, title: 'Movimentação de cargas', kicker: 'Portos', summary: 'Guindastes, transportadores e pátios automatizados.', date: 'Concluído', duration: '55 min', articles: 2, status: 'done' },
          { id: 5, title: 'Disponibilidade e falhas', kicker: 'Confiabilidade', summary: 'Redundância, diagnóstico e manutenção.', date: 'Concluído', duration: '45 min', articles: 2, status: 'done' },
          { id: 6, title: 'Terminal automatizado', kicker: 'Projeto final', summary: 'Integração de um fluxo portuário ponta a ponta.', date: 'Concluído', duration: 'Projeto', articles: 3, status: 'done' }
        ],
        readings: [
          { code: 'IND-01', author: 'Acervo da disciplina', title: 'Arquiteturas de automação para terminais de contêineres', module: 1 }
        ],
        presentationTips: ['Mostre o fluxo antes da tecnologia.', 'Nomeie os intertravamentos.', 'Inclua um cenário de falha.'],
        students: [
          { name: 'Turma arquivada', email: 'turma.5714@usp.br', nusp: '57140001', group: '—', access: false }
        ],
        submissions: []
      }
    ]
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));

  function load() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (stored && Array.isArray(stored.courses)) {
        const catalogFields = ['title', 'shortTitle', 'description', 'ementa', 'objectives', 'credits', 'workload', 'catalogUrl'];
        stored.courses.forEach((localCourse) => {
          const catalogCourse = seed.courses.find((item) => item.code === localCourse.code);
          if (catalogCourse) catalogFields.forEach((field) => { localCourse[field] = clone(catalogCourse[field]); });
        });
        seed.courses.forEach((catalogCourse) => {
          if (!stored.courses.some((item) => item.code === catalogCourse.code)) stored.courses.push(clone(catalogCourse));
        });
        stored.version = seed.version;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
        return stored;
      }
    } catch (error) {
      console.warn('Não foi possível carregar os dados locais.', error);
    }
    const fresh = clone(seed);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    return fresh;
  }

  function save(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state;
  }

  function reset() {
    localStorage.removeItem(STORAGE_KEY);
    return load();
  }

  function getCourse(state, code) {
    return state.courses.find((course) => course.code === code) || state.courses[0];
  }

  window.CourseStore = { STORAGE_KEY, seed, load, save, reset, getCourse, clone };
}());
