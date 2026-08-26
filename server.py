#!/usr/bin/env python3
"""Servidor local da Rota da Disciplina com API JSON e SQLite."""

from __future__ import annotations

import cgi
import json
import mimetypes
import re
import secrets
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "disciplinas.db"
UPLOAD_DIR = ROOT / "uploads"
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
APP_TIMEZONE = ZoneInfo("America/Belem")


def local_today_iso() -> str:
    return datetime.now(APP_TIMEZONE).date().isoformat()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    short_title TEXT NOT NULL,
    semester TEXT NOT NULL,
    cover TEXT NOT NULL DEFAULT '',
    drive_url TEXT NOT NULL DEFAULT '',
    drive_connected INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Rascunho',
    visibility TEXT NOT NULL DEFAULT 'Somente alunos cadastrados',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    nusp TEXT NOT NULL,
    group_name TEXT NOT NULL DEFAULT '—',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(course_id, email),
    UNIQUE(course_id, nusp)
);

CREATE TABLE IF NOT EXISTS class_sessions (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    session_date TEXT NOT NULL,
    start_time TEXT NOT NULL DEFAULT '14:00',
    title TEXT NOT NULL,
    theme TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    specialist_name TEXT NOT NULL DEFAULT '',
    specialist_role TEXT NOT NULL DEFAULT '',
    specialist_topic TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_course_date
ON class_sessions(course_id, session_date, start_time);

CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
    code TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS article_presenters (
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    PRIMARY KEY(article_id, student_id)
);

CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    session_id INTEGER REFERENCES class_sessions(id) ON DELETE SET NULL,
    article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


COURSE_SEEDS = [
    (
        "PEA5004",
        "Sistemas de Automação para Monitoramento e Segurança Pública, Privada e Ambiental para Área Portuária",
        "Monitoramento e segurança portuária",
        "2º semestre de 2026",
        "assets/course-pea5004.webp",
        "",
        0,
        "Publicada",
    ),
    (
        "PEA5003",
        "Componentes de Automação em ITS",
        "Componentes de automação em ITS",
        "1º semestre de 2027",
        "assets/course-pea5003.webp",
        "https://drive.google.com/drive/folders/1Z6EvnGAYkvGZZKKyOVzmxDa0AjveNKFz",
        1,
        "Rascunho",
    ),
    (
        "PEA5714",
        "Automação de Sistemas Industriais e Portuários",
        "Automação industrial e portuária",
        "1º semestre de 2026",
        "assets/course-pea5714.webp",
        "https://drive.google.com/drive/folders/11BmJQxhewM4_X3u4yks6lKbxnWUIb7BG",
        1,
        "Arquivada",
    ),
]


PEA5004_SESSIONS = [
    (
        "2026-08-19", "14:00", "O porto como sistema vivo", "Visão sistêmica, riscos e atores",
        "PEA · Sala A2-06", "Profa. Lídia Rebello Dias", "Docente responsável · PEA/EPUSP",
        "Abertura da disciplina e leitura integrada da operação portuária",
    ),
    (
        "2026-08-26", "14:00", "Risco público, privado e ambiental", "Panorama de riscos integrados",
        "PEA · Sala A2-06", "Eng. Ricardo Mendes", "Gerente de segurança portuária",
        "Como um centro de controle integra ocorrências, acesso e resposta operacional",
    ),
    (
        "2026-09-02", "14:00", "Sensores na linha d'água", "IoT e monitoramento ambiental",
        "PEA · Sala A2-06", "Dra. Carla Siqueira", "Pesquisadora · IPT",
        "Qualidade do ar, água e ruído em ambientes industriais e costeiros",
    ),
    (
        "2026-09-09", "14:00", "Visão computacional", "CFTV inteligente e rastreamento",
        "PEA · Sala A2-06", "Eng. Marina Torres", "Arquiteta de soluções · Visão computacional",
        "Detecção, reidentificação e limites do monitoramento automatizado",
    ),
    (
        "2026-09-16", "14:00", "Identidade e controle de acesso", "Credenciais, biometria e ISPS Code",
        "PEA · Sala A2-06", "Cap. Fábio Almeida", "Núcleo de segurança portuária",
        "Integração entre autoridade, terminal e sistemas de identificação",
    ),
    (
        "2026-09-23", "14:00", "Redes que não podem parar", "5G, LPWAN e redundância",
        "PEA · Sala A2-06", "Eng. Paulo Gomes", "Especialista em redes críticas",
        "Comunicação resiliente para sensores, voz, vídeo e automação",
    ),
    (
        "2026-09-30", "14:00", "Centro de controle integrado", "Da telemetria à decisão",
        "PEA · Sala A2-06", "Eng. Ricardo Mendes", "Gerente de segurança portuária",
        "Alarmes, contexto e coordenação da resposta em tempo real",
    ),
    (
        "2026-11-18", "14:00", "Projeto: porto seguro", "Apresentações finais",
        "PEA · Sala A2-06", "Banca convidada", "Profissionais e pesquisadores do setor",
        "Discussão das propostas finais dos grupos",
    ),
]


ARTICLE_SEEDS = {
    "2026-08-26": [
        ("A01", "Towards Smart Port Infrastructures: Enhancing Port Activities using ICT", "Yau et al."),
        ("A02", "Assessing Port Facility Safety: A Comparative Analysis of Global Accident and Injury Databases", "Giovannetti et al."),
    ],
    "2026-09-02": [
        ("A03", "Deployment Strategies of Mobile Networks for IoT in Smart Maritime Ports", "El Idrissi et al."),
        ("A04", "IoT-Based Environmental Monitoring for Port Areas", "Leitura da disciplina"),
    ],
    "2026-09-09": [
        ("A05", "Multi-Source Transfer Network for Cross Domain Person Re-Identification", "Wang, Hu & Zhang"),
    ],
}


def connect() -> sqlite3.Connection:
    database = sqlite3.connect(DB_PATH)
    database.row_factory = sqlite3.Row
    database.execute("PRAGMA foreign_keys = ON")
    database.execute("PRAGMA journal_mode = WAL")
    return database


def initialize_database() -> None:
    UPLOAD_DIR.mkdir(exist_ok=True)
    with connect() as database:
        database.executescript(SCHEMA)
        if database.execute("SELECT COUNT(*) FROM courses").fetchone()[0]:
            return
        database.executemany(
            """
            INSERT INTO courses
                (code, title, short_title, semester, cover, drive_url, drive_connected, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            COURSE_SEEDS,
        )
        course_id = database.execute("SELECT id FROM courses WHERE code = 'PEA5004'").fetchone()[0]
        database.executemany(
            """
            INSERT INTO students (course_id, name, email, nusp, group_name, active)
            VALUES (?, ?, ?, ?, ?, 1)
            """,
            [
                (course_id, "Ana Souza", "ana.souza@usp.br", "12345678", "Grupo Farol"),
                (course_id, "Bruno Lima", "bruno.lima@usp.br", "11223344", "Grupo Maré"),
                (course_id, "Carla Nunes", "carla.nunes@usp.br", "88776655", "—"),
            ],
        )
        session_ids: dict[str, int] = {}
        for values in PEA5004_SESSIONS:
            cursor = database.execute(
                """
                INSERT INTO class_sessions
                    (course_id, session_date, start_time, title, theme, location,
                     specialist_name, specialist_role, specialist_topic)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (course_id, *values),
            )
            session_ids[values[0]] = cursor.lastrowid
        article_ids: list[int] = []
        for session_date, articles in ARTICLE_SEEDS.items():
            for code, title, author in articles:
                cursor = database.execute(
                    "INSERT INTO articles (session_id, code, title, author) VALUES (?, ?, ?, ?)",
                    (session_ids[session_date], code, title, author),
                )
                article_ids.append(cursor.lastrowid)
        students = database.execute(
            "SELECT id FROM students WHERE course_id = ? ORDER BY id", (course_id,)
        ).fetchall()
        if article_ids and students:
            for index, article_id in enumerate(article_ids):
                student_id = students[index % len(students)][0]
                database.execute(
                    "INSERT OR IGNORE INTO article_presenters (article_id, student_id) VALUES (?, ?)",
                    (article_id, student_id),
                )


def row_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


def article_payload(database: sqlite3.Connection, article: sqlite3.Row) -> dict:
    payload = dict(article)
    payload["presenters"] = [
        dict(row)
        for row in database.execute(
            """
            SELECT s.id, s.name, s.email, s.nusp, s.group_name
            FROM article_presenters ap
            JOIN students s ON s.id = ap.student_id
            WHERE ap.article_id = ?
            ORDER BY s.name
            """,
            (article["id"],),
        ).fetchall()
    ]
    return payload


def session_payload(database: sqlite3.Connection, session: sqlite3.Row) -> dict:
    payload = dict(session)
    payload["articles"] = [
        article_payload(database, article)
        for article in database.execute(
            "SELECT * FROM articles WHERE session_id = ? ORDER BY id", (session["id"],)
        ).fetchall()
    ]
    return payload


def course_payload(code: str, *, admin: bool = False) -> dict | None:
    with connect() as database:
        course = database.execute(
            "SELECT * FROM courses WHERE UPPER(code) = UPPER(?)", (code,)
        ).fetchone()
        if not course:
            return None
        payload = dict(course)
        sessions = database.execute(
            """
            SELECT * FROM class_sessions
            WHERE course_id = ?
            ORDER BY session_date, start_time, id
            """,
            (course["id"],),
        ).fetchall()
        payload["sessions"] = [session_payload(database, item) for item in sessions]
        today = local_today_iso()
        payload["next_class"] = next(
            (item for item in payload["sessions"] if item["session_date"] >= today), None
        )
        payload["stats"] = {
            "students": database.execute(
                "SELECT COUNT(*) FROM students WHERE course_id = ? AND active = 1", (course["id"],)
            ).fetchone()[0],
            "classes": len(sessions),
            "articles": database.execute(
                """
                SELECT COUNT(*) FROM articles a
                JOIN class_sessions cs ON cs.id = a.session_id
                WHERE cs.course_id = ?
                """,
                (course["id"],),
            ).fetchone()[0],
            "uploads": database.execute(
                "SELECT COUNT(*) FROM uploads WHERE course_id = ?", (course["id"],)
            ).fetchone()[0],
        }
        if admin:
            payload["students"] = [
                dict(row)
                for row in database.execute(
                    "SELECT * FROM students WHERE course_id = ? ORDER BY name", (course["id"],)
                ).fetchall()
            ]
            payload["uploads"] = [
                dict(row)
                for row in database.execute(
                    """
                    SELECT u.*, s.name AS student_name, cs.title AS session_title,
                           a.title AS article_title
                    FROM uploads u
                    JOIN students s ON s.id = u.student_id
                    LEFT JOIN class_sessions cs ON cs.id = u.session_id
                    LEFT JOIN articles a ON a.id = u.article_id
                    WHERE u.course_id = ?
                    ORDER BY u.created_at DESC, u.id DESC
                    """,
                    (course["id"],),
                ).fetchall()
            ]
        return payload


def course_id_for(database: sqlite3.Connection, code: str) -> int | None:
    row = database.execute("SELECT id FROM courses WHERE UPPER(code) = UPPER(?)", (code,)).fetchone()
    return row[0] if row else None


def clean_filename(filename: str) -> str:
    name = Path(filename).name
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip(".-")
    return name[:120] or "material"


class RotaHandler(SimpleHTTPRequestHandler):
    server_version = "RotaDisciplina/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def json_response(self, payload: dict | list, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error_response(self, message: str, status: int = 400) -> None:
        self.json_response({"error": message}, status)

    def read_json(self) -> dict:
        size = int(self.headers.get("Content-Length", "0"))
        if size <= 0 or size > 1_000_000:
            return {}
        try:
            return json.loads(self.rfile.read(size).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}

    def bearer_student(self) -> sqlite3.Row | None:
        authorization = self.headers.get("Authorization", "")
        if not authorization.startswith("Bearer "):
            return None
        token = authorization.removeprefix("Bearer ").strip()
        with connect() as database:
            return database.execute(
                """
                SELECT s.*, c.code AS course_code
                FROM auth_sessions aus
                JOIN students s ON s.id = aus.student_id
                JOIN courses c ON c.id = s.course_id
                WHERE aus.token = ? AND aus.expires_at > ? AND s.active = 1
                """,
                (token, utc_now_iso()),
            ).fetchone()

    def do_GET(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if path == "/api/health":
            self.json_response({"status": "ok", "database": DB_PATH.name, "today": local_today_iso()})
            return
        if path == "/api/courses":
            with connect() as database:
                courses = [dict(row) for row in database.execute("SELECT * FROM courses ORDER BY code").fetchall()]
            self.json_response(courses)
            return
        match = re.fullmatch(r"/api/courses/([A-Za-z0-9_-]+)", path)
        if match:
            payload = course_payload(match.group(1))
            if payload is None:
                self.error_response("Disciplina não encontrada.", 404)
            else:
                self.json_response(payload)
            return
        match = re.fullmatch(r"/api/admin/courses/([A-Za-z0-9_-]+)", path)
        if match:
            payload = course_payload(match.group(1), admin=True)
            if payload is None:
                self.error_response("Disciplina não encontrada.", 404)
            else:
                self.json_response(payload)
            return
        match = re.fullmatch(r"/api/admin/uploads/(\d+)/download", path)
        if match:
            with connect() as database:
                upload = database.execute(
                    "SELECT filename, stored_name, mime_type, size_bytes FROM uploads WHERE id = ?",
                    (int(match.group(1)),),
                ).fetchone()
            if not upload:
                self.error_response("Material não encontrado.", 404)
                return
            target = (UPLOAD_DIR / upload["stored_name"]).resolve()
            if target.parent != UPLOAD_DIR.resolve() or not target.is_file():
                self.error_response("Arquivo do material não encontrado.", 404)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", upload["mime_type"] or "application/octet-stream")
            self.send_header("Content-Length", str(target.stat().st_size))
            self.send_header(
                "Content-Disposition",
                f"attachment; filename=material; filename*=UTF-8''{quote(upload['filename'])}",
            )
            self.send_header("Cache-Control", "private, no-store")
            self.end_headers()
            with target.open("rb") as source:
                while chunk := source.read(64 * 1024):
                    self.wfile.write(chunk)
            return
        if path == "/api/me":
            student = self.bearer_student()
            if not student:
                self.error_response("Sessão inválida ou expirada.", 401)
            else:
                self.json_response({"student": dict(student)})
            return
        if path.startswith("/uploads/"):
            self.error_response("Arquivos enviados não são públicos.", 403)
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if path == "/api/auth/login":
            self.login_student()
            return
        if path == "/api/admin/courses":
            self.create_course()
            return
        match = re.fullmatch(r"/api/admin/courses/([A-Za-z0-9_-]+)/students", path)
        if match:
            self.create_student(match.group(1))
            return
        match = re.fullmatch(r"/api/admin/courses/([A-Za-z0-9_-]+)/sessions", path)
        if match:
            self.create_session(match.group(1))
            return
        match = re.fullmatch(r"/api/admin/sessions/(\d+)/articles", path)
        if match:
            self.create_article(int(match.group(1)))
            return
        if path == "/api/uploads":
            self.create_upload()
            return
        self.error_response("Rota não encontrada.", 404)

    def do_PUT(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        match = re.fullmatch(r"/api/admin/courses/([A-Za-z0-9_-]+)", path)
        if match:
            self.update_course(match.group(1))
            return
        match = re.fullmatch(r"/api/admin/sessions/(\d+)", path)
        if match:
            self.update_session(int(match.group(1)))
            return
        self.error_response("Rota não encontrada.", 404)

    def do_PATCH(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        match = re.fullmatch(r"/api/admin/students/(\d+)", path)
        if match:
            data = self.read_json()
            with connect() as database:
                cursor = database.execute(
                    "UPDATE students SET active = ? WHERE id = ?",
                    (1 if data.get("active") else 0, int(match.group(1))),
                )
            if not cursor.rowcount:
                self.error_response("Aluno não encontrado.", 404)
            else:
                self.json_response({"ok": True})
            return
        self.error_response("Rota não encontrada.", 404)

    def do_DELETE(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        for pattern, table, label in [
            (r"/api/admin/students/(\d+)", "students", "Aluno"),
            (r"/api/admin/sessions/(\d+)", "class_sessions", "Aula"),
            (r"/api/admin/articles/(\d+)", "articles", "Artigo"),
        ]:
            match = re.fullmatch(pattern, path)
            if match:
                with connect() as database:
                    cursor = database.execute(f"DELETE FROM {table} WHERE id = ?", (int(match.group(1)),))
                if not cursor.rowcount:
                    self.error_response(f"{label} não encontrado.", 404)
                else:
                    self.json_response({"ok": True})
                return
        self.error_response("Rota não encontrada.", 404)

    def login_student(self) -> None:
        data = self.read_json()
        code = str(data.get("course_code", "")).strip()
        email = str(data.get("email", "")).strip().lower()
        nusp = str(data.get("nusp", "")).strip()
        with connect() as database:
            student = database.execute(
                """
                SELECT s.*, c.code AS course_code
                FROM students s JOIN courses c ON c.id = s.course_id
                WHERE UPPER(c.code) = UPPER(?) AND LOWER(s.email) = ? AND s.nusp = ? AND s.active = 1
                """,
                (code, email, nusp),
            ).fetchone()
            if not student:
                self.error_response("E-mail ou Nº USP não cadastrado nesta disciplina.", 401)
                return
            token = secrets.token_urlsafe(32)
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat()
            database.execute(
                "INSERT INTO auth_sessions (token, student_id, expires_at) VALUES (?, ?, ?)",
                (token, student["id"], expires_at),
            )
        self.json_response({"token": token, "expires_at": expires_at, "student": dict(student)})

    def create_student(self, code: str) -> None:
        data = self.read_json()
        required = [str(data.get(key, "")).strip() for key in ("name", "email", "nusp")]
        if not all(required) or not re.fullmatch(r"\d{7,10}", required[2]):
            self.error_response("Informe nome, e-mail e um Nº USP válido.")
            return
        try:
            with connect() as database:
                course_id = course_id_for(database, code)
                if not course_id:
                    self.error_response("Disciplina não encontrada.", 404)
                    return
                cursor = database.execute(
                    """
                    INSERT INTO students (course_id, name, email, nusp, group_name, active)
                    VALUES (?, ?, ?, ?, ?, 1)
                    """,
                    (course_id, required[0], required[1].lower(), required[2], str(data.get("group_name", "—"))),
                )
                student = database.execute("SELECT * FROM students WHERE id = ?", (cursor.lastrowid,)).fetchone()
        except sqlite3.IntegrityError:
            self.error_response("Esse e-mail ou Nº USP já está cadastrado.", 409)
            return
        self.json_response({"student": dict(student)}, 201)

    def create_course(self) -> None:
        data = self.read_json()
        code = str(data.get("code", "")).strip().upper()
        title = str(data.get("title", "")).strip()
        semester = str(data.get("semester", "")).strip()
        if not re.fullmatch(r"[A-Z0-9_-]{3,12}", code) or not title or not semester:
            self.error_response("Informe código, nome e semestre da disciplina.")
            return
        try:
            with connect() as database:
                database.execute(
                    """
                    INSERT INTO courses
                        (code, title, short_title, semester, cover, drive_url, drive_connected, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'Rascunho')
                    """,
                    (
                        code, title, str(data.get("short_title", title)).strip(), semester,
                        str(data.get("cover", "assets/course-pea5004.webp")),
                        str(data.get("drive_url", "")).strip(), 1 if data.get("drive_url") else 0,
                    ),
                )
        except sqlite3.IntegrityError:
            self.error_response("Já existe uma disciplina com esse código.", 409)
            return
        self.json_response({"course": course_payload(code)}, 201)

    def create_session(self, code: str) -> None:
        data = self.read_json()
        if not data.get("session_date") or not data.get("title"):
            self.error_response("Informe a data e o título da aula.")
            return
        with connect() as database:
            course_id = course_id_for(database, code)
            if not course_id:
                self.error_response("Disciplina não encontrada.", 404)
                return
            cursor = database.execute(
                """
                INSERT INTO class_sessions
                    (course_id, session_date, start_time, title, theme, location,
                     specialist_name, specialist_role, specialist_topic, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    course_id, data["session_date"], data.get("start_time", "14:00"), data["title"],
                    data.get("theme", ""), data.get("location", ""), data.get("specialist_name", ""),
                    data.get("specialist_role", ""), data.get("specialist_topic", ""), data.get("notes", ""),
                ),
            )
            session = database.execute("SELECT * FROM class_sessions WHERE id = ?", (cursor.lastrowid,)).fetchone()
            payload = session_payload(database, session)
        self.json_response({"session": payload}, 201)

    def update_session(self, session_id: int) -> None:
        data = self.read_json()
        with connect() as database:
            existing = database.execute("SELECT * FROM class_sessions WHERE id = ?", (session_id,)).fetchone()
            if not existing:
                self.error_response("Aula não encontrada.", 404)
                return
            fields = [
                "session_date", "start_time", "title", "theme", "location", "specialist_name",
                "specialist_role", "specialist_topic", "notes",
            ]
            values = [data.get(field, existing[field]) for field in fields]
            database.execute(
                f"UPDATE class_sessions SET {', '.join(field + ' = ?' for field in fields)}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (*values, session_id),
            )
            session = database.execute("SELECT * FROM class_sessions WHERE id = ?", (session_id,)).fetchone()
            payload = session_payload(database, session)
        self.json_response({"session": payload})

    def create_article(self, session_id: int) -> None:
        data = self.read_json()
        if not str(data.get("title", "")).strip():
            self.error_response("Informe o título do artigo.")
            return
        presenter_ids = [int(value) for value in data.get("presenter_ids", []) if str(value).isdigit()]
        with connect() as database:
            session = database.execute("SELECT * FROM class_sessions WHERE id = ?", (session_id,)).fetchone()
            if not session:
                self.error_response("Aula não encontrada.", 404)
                return
            cursor = database.execute(
                "INSERT INTO articles (session_id, code, title, author, url) VALUES (?, ?, ?, ?, ?)",
                (session_id, data.get("code", ""), data["title"].strip(), data.get("author", ""), data.get("url", "")),
            )
            article_id = cursor.lastrowid
            for student_id in presenter_ids:
                database.execute(
                    """
                    INSERT OR IGNORE INTO article_presenters (article_id, student_id)
                    SELECT ?, id FROM students WHERE id = ? AND course_id = ?
                    """,
                    (article_id, student_id, session["course_id"]),
                )
            article = database.execute("SELECT * FROM articles WHERE id = ?", (article_id,)).fetchone()
            payload = article_payload(database, article)
        self.json_response({"article": payload}, 201)

    def update_course(self, code: str) -> None:
        data = self.read_json()
        with connect() as database:
            course = database.execute("SELECT * FROM courses WHERE UPPER(code) = UPPER(?)", (code,)).fetchone()
            if not course:
                self.error_response("Disciplina não encontrada.", 404)
                return
            mapping = {
                "title": "title", "shortTitle": "short_title", "semester": "semester", "cover": "cover",
                "driveUrl": "drive_url", "status": "status", "visibility": "visibility",
            }
            updates = {column: data[key] for key, column in mapping.items() if key in data}
            if "drive_url" in updates:
                updates["drive_connected"] = 1 if updates["drive_url"] else 0
            if updates:
                query = ", ".join(f"{column} = ?" for column in updates)
                database.execute(
                    f"UPDATE courses SET {query}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (*updates.values(), course["id"]),
                )
        self.json_response({"course": course_payload(code)})

    def create_upload(self) -> None:
        student = self.bearer_student()
        if not student:
            self.error_response("Entre na disciplina antes de enviar material.", 401)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.error_response("Tamanho de envio inválido.")
            return
        if content_length <= 0 or content_length > MAX_UPLOAD_BYTES:
            self.error_response("O arquivo deve ter no máximo 25 MB.", 413)
            return
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self.error_response("Envie o material como formulário multipart.")
            return
        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type, "CONTENT_LENGTH": str(content_length)},
        )
        file_field = form["file"] if "file" in form else None
        if file_field is None or not getattr(file_field, "filename", ""):
            self.error_response("Selecione um arquivo para enviar.")
            return
        original_name = clean_filename(file_field.filename)
        stored_name = f"{uuid.uuid4().hex}-{original_name}"
        destination = UPLOAD_DIR / stored_name
        size = 0
        with destination.open("wb") as output:
            while True:
                chunk = file_field.file.read(64 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    output.close()
                    destination.unlink(missing_ok=True)
                    self.error_response("O arquivo deve ter no máximo 25 MB.", 413)
                    return
                output.write(chunk)
        try:
            session_id = int(form.getfirst("session_id", "0") or 0) or None
            article_id = int(form.getfirst("article_id", "0") or 0) or None
        except (TypeError, ValueError):
            destination.unlink(missing_ok=True)
            self.error_response("Aula ou artigo inválido.")
            return
        description = str(form.getfirst("description", ""))[:500]
        mime_type = file_field.type or mimetypes.guess_type(original_name)[0] or "application/octet-stream"
        with connect() as database:
            if session_id:
                valid_session = database.execute(
                    "SELECT id FROM class_sessions WHERE id = ? AND course_id = ?",
                    (session_id, student["course_id"]),
                ).fetchone()
                if not valid_session:
                    destination.unlink(missing_ok=True)
                    self.error_response("A aula selecionada não pertence a esta disciplina.")
                    return
            if article_id:
                valid_article = database.execute(
                    """
                    SELECT a.id, a.session_id FROM articles a
                    JOIN class_sessions cs ON cs.id = a.session_id
                    WHERE a.id = ? AND cs.course_id = ?
                    """,
                    (article_id, student["course_id"]),
                ).fetchone()
                if not valid_article or (session_id and valid_article["session_id"] != session_id):
                    destination.unlink(missing_ok=True)
                    self.error_response("O artigo selecionado não pertence a esta aula.")
                    return
            cursor = database.execute(
                """
                INSERT INTO uploads
                    (course_id, student_id, session_id, article_id, filename, stored_name,
                     description, mime_type, size_bytes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    student["course_id"], student["id"], session_id, article_id, original_name,
                    stored_name, description, mime_type, size,
                ),
            )
            upload = database.execute("SELECT * FROM uploads WHERE id = ?", (cursor.lastrowid,)).fetchone()
        self.json_response({"upload": dict(upload)}, 201)

    def log_message(self, message: str, *args) -> None:
        sys.stdout.write(f"[{self.log_date_time_string()}] {message % args}\n")


def main() -> None:
    initialize_database()
    host = "127.0.0.1"
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    server = ThreadingHTTPServer((host, port), RotaHandler)
    print(f"Rota da Disciplina em http://{host}:{port}")
    print(f"SQLite: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
