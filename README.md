# Rota da Disciplina

Aplicação navegável para as disciplinas da Profa. Lídia Rebello Dias (PEA/EPUSP), com experiência cinematográfica para os alunos e painel docente de gestão.

## Executar

O projeto usa somente a biblioteca padrão do Python 3. Não é necessário instalar pacotes.

```bash
python3 server.py
```

Abra:

- `http://127.0.0.1:4173/index.html` — experiência do aluno;
- `http://127.0.0.1:4173/admin.html` — painel da professora;
- `http://127.0.0.1:4173/api/health` — diagnóstico da API e data usada pela agenda.

O arquivo `disciplinas.db` e a pasta `uploads/` são criados automaticamente na primeira execução.

### Acesso de demonstração

Para entrar em PEA5004:

- Nº USP: `12345678`
- E-mail: `ana.souza@usp.br`

## Fluxos implementados

- SQLite para disciplinas, alunos, aulas, artigos, apresentadores, sessões e materiais enviados;
- acesso do aluno pela combinação disciplina + e-mail + Nº USP, com token de 12 horas;
- cadastro, bloqueio e importação CSV de alunos no painel docente;
- agenda de aulas com data, horário, local, tema e observações;
- primeiro momento da aula com profissional convidado, função e temática;
- segundo momento com artigos e um ou mais alunos apresentadores;
- destaque automático da próxima aula: a aula continua em evidência durante todo o seu dia e depois avança para a data futura seguinte;
- envio autenticado de material pelo aluno, vinculado à aula e opcionalmente a um artigo, com limite de 25 MB;
- consulta dos materiais recebidos no painel docente;
- cadastro de novas disciplinas e vínculo do endereço da pasta principal do Google Drive;
- seletor entre PEA5003, PEA5004, PEA5714 e novas disciplinas cadastradas;
- capas cinematográficas, trilha, ementa, objetivos, acervo e dicas de apresentação;
- uso da marca da Escola Politécnica da USP fornecida para o projeto.

PEA5003 e PEA5714 já estão cadastradas com os links de Drive fornecidos. PEA5004 permanece como vínculo pendente até o endereço ser informado.

## Estrutura de dados

O banco é inicializado em `server.py` com estas entidades principais:

- `courses` — configuração e pasta Drive de cada disciplina;
- `students` — nome, e-mail, Nº USP, grupo e estado de acesso;
- `class_sessions` — calendário e especialista convidado;
- `articles` e `article_presenters` — leituras e alunos responsáveis;
- `uploads` — metadados dos materiais enviados;
- `auth_sessions` — tokens temporários dos alunos.

As datas são avaliadas no fuso `America/Belem`, coerente com o ambiente da aplicação. Arquivos em `uploads/` não são publicados diretamente pelo servidor.

## Limites antes de produção

O protótipo já possui persistência e autorização básica do aluno, mas ainda precisa destas camadas para uso institucional:

1. autenticação da professora e proteção das rotas administrativas;
2. HTTPS, política de privacidade/LGPD, backup e política de retenção dos dados de alunos;
3. validação de tipo, antivírus e armazenamento privado para arquivos enviados;
4. OAuth do Google e Drive API para sincronizar automaticamente pastas e metadados — o protótipo atual salva e abre o link da pasta, sem copiar seu conteúdo;
5. recuperação de acesso, auditoria e implantação em servidor institucional.

## Arquivos principais

- `server.py` — servidor HTTP, API e banco SQLite;
- `index.html` / `app.js` — experiência do aluno;
- `admin.html` / `admin.js` — painel docente;
- `data.js` — conteúdo editorial inicial e fallback local;
- `styles.css` — sistema visual, movimento e responsividade;
- `assets/` — capas geradas e marca da Escola Politécnica;
- `disciplinas.db` — banco local criado em execução;
- `uploads/` — arquivos recebidos, fora da exposição pública direta.
