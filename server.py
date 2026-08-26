#!/usr/bin/env python3
"""Servidor local da Rota da Disciplina com API JSON e SQLite."""

from __future__ import annotations

import base64
import cgi
import hashlib
import html
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(
    os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
    or os.environ.get("PEA_DATA_DIR")
    or ROOT
).resolve()
DB_PATH = DATA_DIR / "disciplinas.db"
UPLOAD_DIR = DATA_DIR / "uploads"
COVER_DIR = DATA_DIR / "course-covers"
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_COVER_BYTES = 8 * 1024 * 1024
APP_TIMEZONE = ZoneInfo("America/Belem")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "professora")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ALLOW_INSECURE_ADMIN = os.environ.get(
    "ALLOW_INSECURE_ADMIN",
    "0" if os.environ.get("RAILWAY_ENVIRONMENT_ID") else "1",
).lower() in {"1", "true", "yes"}
OPENAI_RUNTIME = {
    "api_key": os.environ.get("OPENAI_API_KEY", ""),
    "source": "environment" if os.environ.get("OPENAI_API_KEY") else "",
}
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")


def local_today_iso() -> str:
    return datetime.now(APP_TIMEZONE).date().isoformat()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)
    return f"pbkdf2_sha256$310000${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, rounds_text, salt_hex, digest_hex = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        calculated = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds_text)
        )
        return secrets.compare_digest(calculated.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def secret_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def create_access_token() -> str:
    return f"PEA-{secrets.token_urlsafe(18)}"


def safe_http_url(value: str, *, allow_mailto: bool = False) -> bool:
    if not value:
        return True
    parsed = urlparse(value)
    allowed = {"http", "https"} | ({"mailto"} if allow_mailto else set())
    return parsed.scheme in allowed and bool(parsed.netloc or parsed.scheme == "mailto")


class RichHTMLSanitizer(HTMLParser):
    allowed_tags = {"p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li", "a", "blockquote", "code"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.output: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in self.allowed_tags:
            return
        if tag == "a":
            href = next((value or "" for name, value in attrs if name == "href"), "")
            if safe_http_url(href, allow_mailto=True):
                self.output.append(f'<a href="{html.escape(href, quote=True)}" target="_blank" rel="noopener noreferrer">')
                return
        self.output.append(f"<{tag}>")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.allowed_tags and tag != "br":
            self.output.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        self.output.append(html.escape(data))

    def value(self) -> str:
        return "".join(self.output).strip()


def sanitize_rich_html(value: str, *, limit: int = 12_000) -> str:
    parser = RichHTMLSanitizer()
    parser.feed(value[:limit])
    return parser.value()


def add_missing_columns(database: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    existing = {row["name"] for row in database.execute(f"PRAGMA table_info({table})").fetchall()}
    for name, definition in columns.items():
        if name not in existing:
            database.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    short_title TEXT NOT NULL,
    semester TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    ementa TEXT NOT NULL DEFAULT '',
    class_day TEXT NOT NULL DEFAULT '',
    room TEXT NOT NULL DEFAULT '',
    professor_name TEXT NOT NULL DEFAULT 'Profa. Maria Lídia',
    cover TEXT NOT NULL DEFAULT '',
    drive_url TEXT NOT NULL DEFAULT '',
    drive_connected INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Rascunho',
    visibility TEXT NOT NULL DEFAULT 'Somente alunos cadastrados',
    cover_file TEXT NOT NULL DEFAULT '',
    public_overview INTEGER NOT NULL DEFAULT 1,
    public_schedule INTEGER NOT NULL DEFAULT 1,
    public_articles INTEGER NOT NULL DEFAULT 0,
    public_resources INTEGER NOT NULL DEFAULT 0,
    public_chat INTEGER NOT NULL DEFAULT 0,
    grade_results_published INTEGER NOT NULL DEFAULT 0,
    grade_scale_json TEXT NOT NULL DEFAULT '[{"letter":"A","min":8.5},{"letter":"B","min":7.0},{"letter":"C","min":5.0},{"letter":"R","min":0.0}]',
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
    access_token_hash TEXT NOT NULL DEFAULT '',
    access_token_hint TEXT NOT NULL DEFAULT '',
    token_created_at TEXT,
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
    meet_url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    student_choice_enabled INTEGER NOT NULL DEFAULT 0,
    submission_deadline TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS deliverable_types (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(course_id, name)
);

CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    session_id INTEGER REFERENCES class_sessions(id) ON DELETE SET NULL,
    article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
    deliverable_type_id INTEGER REFERENCES deliverable_types(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS presentation_reservations (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    session_id INTEGER REFERENCES class_sessions(id) ON DELETE CASCADE,
    article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'article',
    group_name TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    members TEXT NOT NULL DEFAULT '',
    slides_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_auth_sessions (
    token TEXT PRIMARY KEY,
    teacher_id INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    must_reset_password INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS student_access_recovery (
    id INTEGER PRIMARY KEY,
    student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
    identifier_hint TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending_resend',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_specialists (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL UNIQUE REFERENCES class_sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    linkedin TEXT NOT NULL DEFAULT '',
    whatsapp TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    invite_token_hash TEXT NOT NULL DEFAULT '',
    invite_expires_at TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS specialist_auth_sessions (
    token TEXT PRIMARY KEY,
    specialist_id INTEGER NOT NULL REFERENCES session_specialists(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_resources (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
    author_role TEXT NOT NULL,
    author_name TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    content_html TEXT NOT NULL DEFAULT '',
    resource_type TEXT NOT NULL DEFAULT 'material',
    visibility TEXT NOT NULL DEFAULT 'class',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_comments (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
    author_role TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content_html TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS assessment_items (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    max_score REAL NOT NULL DEFAULT 10,
    weight REAL NOT NULL DEFAULT 0,
    due_at TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS student_grades (
    id INTEGER PRIMARY KEY,
    assessment_id INTEGER NOT NULL REFERENCES assessment_items(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    score REAL NOT NULL,
    feedback TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(assessment_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_assessments_course
ON assessment_items(course_id, active, id);

CREATE INDEX IF NOT EXISTS idx_grades_student
ON student_grades(student_id, assessment_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_reservation_per_article
ON presentation_reservations(article_id) WHERE article_id IS NOT NULL;
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
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    COVER_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as database:
        database.executescript(SCHEMA)
        add_missing_columns(database, "courses", {
            "description": "TEXT NOT NULL DEFAULT ''",
            "ementa": "TEXT NOT NULL DEFAULT ''",
            "class_day": "TEXT NOT NULL DEFAULT ''",
            "room": "TEXT NOT NULL DEFAULT ''",
            "professor_name": "TEXT NOT NULL DEFAULT 'Profa. Maria Lídia'",
            "cover_file": "TEXT NOT NULL DEFAULT ''",
            "public_overview": "INTEGER NOT NULL DEFAULT 1",
            "public_schedule": "INTEGER NOT NULL DEFAULT 1",
            "public_articles": "INTEGER NOT NULL DEFAULT 0",
            "public_resources": "INTEGER NOT NULL DEFAULT 0",
            "public_chat": "INTEGER NOT NULL DEFAULT 0",
            "grade_results_published": "INTEGER NOT NULL DEFAULT 0",
            "grade_scale_json": "TEXT NOT NULL DEFAULT '[{\"letter\":\"A\",\"min\":8.5},{\"letter\":\"B\",\"min\":7.0},{\"letter\":\"C\",\"min\":5.0},{\"letter\":\"R\",\"min\":0.0}]'",
        })
        add_missing_columns(database, "students", {
            "access_token_hash": "TEXT NOT NULL DEFAULT ''",
            "access_token_hint": "TEXT NOT NULL DEFAULT ''",
            "token_created_at": "TEXT",
        })
        add_missing_columns(database, "class_sessions", {
            "meet_url": "TEXT NOT NULL DEFAULT ''",
            "student_choice_enabled": "INTEGER NOT NULL DEFAULT 0",
            "submission_deadline": "TEXT NOT NULL DEFAULT ''",
        })
        add_missing_columns(database, "uploads", {"deliverable_type_id": "INTEGER"})
        add_missing_columns(database, "admin_auth_sessions", {
            "teacher_id": "INTEGER REFERENCES teachers(id) ON DELETE CASCADE",
        })
        if not database.execute(
            "SELECT 1 FROM teachers WHERE LOWER(username) = 'maria.lidia'"
        ).fetchone():
            initial_password = ADMIN_PASSWORD or secrets.token_urlsafe(32)
            database.execute(
                """
                INSERT INTO teachers (name, username, password_hash, must_reset_password)
                VALUES ('Profa. Maria Lídia', 'maria.lidia', ?, 1)
                """,
                (hash_password(initial_password),),
            )
        if database.execute("SELECT COUNT(*) FROM courses").fetchone()[0]:
            for existing_course in database.execute("SELECT id FROM courses").fetchall():
                if not database.execute(
                    "SELECT 1 FROM deliverable_types WHERE course_id = ? LIMIT 1",
                    (existing_course["id"],),
                ).fetchone():
                    database.executemany(
                        "INSERT INTO deliverable_types (course_id, name) VALUES (?, ?)",
                        [(existing_course["id"], name) for name in ("Resenha", "Artigo", "Apresentação", "Artigo final")],
                    )
            return
        database.executemany(
            """
            INSERT INTO courses
                (code, title, short_title, semester, cover, drive_url, drive_connected, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            COURSE_SEEDS,
        )
        course_rows = database.execute("SELECT id, code FROM courses").fetchall()
        database.executemany(
            "INSERT INTO deliverable_types (course_id, name) VALUES (?, ?)",
            [
                (item["id"], name)
                for item in course_rows
                for name in ("Resenha", "Artigo", "Apresentação", "Artigo final")
            ],
        )
        course_id = next(item["id"] for item in course_rows if item["code"] == "PEA5004")
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


def public_student(row: sqlite3.Row) -> dict:
    payload = dict(row)
    payload.pop("access_token_hash", None)
    return payload


DEFAULT_GRADE_SCALE = [
    {"letter": "A", "min": 8.5},
    {"letter": "B", "min": 7.0},
    {"letter": "C", "min": 5.0},
    {"letter": "R", "min": 0.0},
]


def parse_grade_scale(raw: str | None) -> list[dict]:
    try:
        values = json.loads(raw or "")
        scale = [
            {"letter": str(item["letter"]).strip().upper()[:3], "min": float(item["min"])}
            for item in values
            if str(item.get("letter", "")).strip()
        ]
        if not scale or any(item["min"] < 0 or item["min"] > 10 for item in scale):
            raise ValueError
        return sorted(scale, key=lambda item: item["min"], reverse=True)
    except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
        return [dict(item) for item in DEFAULT_GRADE_SCALE]


def grade_concept(score: float | None, scale: list[dict]) -> str | None:
    if score is None:
        return None
    for item in sorted(scale, key=lambda value: value["min"], reverse=True):
        if score + 1e-9 >= item["min"]:
            return item["letter"]
    return scale[-1]["letter"] if scale else None


def student_grade_summary(
    database: sqlite3.Connection,
    course_id: int,
    student_id: int,
    scale: list[dict],
) -> dict:
    rows = database.execute(
        """
        SELECT ai.id, ai.max_score, ai.weight, sg.score
        FROM assessment_items ai
        LEFT JOIN student_grades sg
          ON sg.assessment_id = ai.id AND sg.student_id = ?
        WHERE ai.course_id = ? AND ai.active = 1
        ORDER BY ai.id
        """,
        (student_id, course_id),
    ).fetchall()
    graded = [row for row in rows if row["score"] is not None]
    configured_weight = sum(max(0.0, float(row["weight"])) for row in rows)
    if configured_weight > 0:
        earned = sum(
            (float(row["score"]) / max(float(row["max_score"]), 0.0001)) * max(0.0, float(row["weight"]))
            for row in graded
        )
        score = round((earned / configured_weight) * 10, 2) if rows else None
        graded_weight = round(sum(max(0.0, float(row["weight"])) for row in graded), 2)
    else:
        normalized = [
            (float(row["score"]) / max(float(row["max_score"]), 0.0001)) * 10
            for row in graded
        ]
        score = round(sum(normalized) / len(normalized), 2) if normalized else None
        graded_weight = len(graded)
    complete = bool(rows) and len(graded) == len(rows)
    return {
        "score": score,
        "concept": grade_concept(score, scale) if complete else None,
        "projected_concept": grade_concept(score, scale),
        "complete": complete,
        "graded_count": len(graded),
        "total_count": len(rows),
        "weight_total": round(configured_weight, 2),
        "graded_weight": graded_weight,
    }


def article_payload(
    database: sqlite3.Connection,
    article: sqlite3.Row,
    *,
    include_private: bool = False,
    viewer_student_id: int | None = None,
) -> dict:
    payload = dict(article)
    presenters = [
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
    if not include_private:
        for presenter in presenters:
            presenter.pop("email", None)
            presenter.pop("nusp", None)
    payload["presenters"] = presenters
    reservation = database.execute(
        """
        SELECT pr.id, pr.student_id, pr.group_name, pr.created_at, s.name AS student_name
        FROM presentation_reservations pr
        JOIN students s ON s.id = pr.student_id
        WHERE pr.article_id = ? LIMIT 1
        """,
        (article["id"],),
    ).fetchone()
    payload["available_for_choice"] = reservation is None and not presenters
    payload["chosen_by_me"] = bool(
        viewer_student_id and (
            (reservation and reservation["student_id"] == viewer_student_id)
            or any(presenter["id"] == viewer_student_id for presenter in presenters)
        )
    )
    if reservation:
        payload["reservation"] = {
            "id": reservation["id"],
            "student_name": reservation["student_name"],
            "group_name": reservation["group_name"],
        }
        if include_private:
            payload["reservation"]["student_id"] = reservation["student_id"]
    return payload


def session_payload(
    database: sqlite3.Connection,
    session: sqlite3.Row,
    *,
    include_private: bool = False,
    include_articles: bool = True,
    viewer_student_id: int | None = None,
) -> dict:
    payload = dict(session)
    payload["meeting_available"] = bool(payload.get("meet_url"))
    if not include_private:
        payload.pop("meet_url", None)
    payload["choice_open"] = bool(payload.get("student_choice_enabled"))
    deadline = str(payload.get("submission_deadline") or "")
    payload["submission_open"] = not deadline or deadline > datetime.now(APP_TIMEZONE).strftime("%Y-%m-%dT%H:%M")
    payload["articles"] = []
    if include_articles:
        payload["articles"] = [
            article_payload(
                database,
                article,
                include_private=include_private,
                viewer_student_id=viewer_student_id,
            )
            for article in database.execute(
                "SELECT * FROM articles WHERE session_id = ? ORDER BY id", (session["id"],)
            ).fetchall()
        ]
    specialist = database.execute(
        "SELECT id, name, email, role, linkedin, whatsapp, website, invite_expires_at, active FROM session_specialists WHERE session_id = ?",
        (session["id"],),
    ).fetchone()
    if specialist and include_private:
        payload["specialist"] = dict(specialist)
    return payload


def course_payload(
    code: str, *, admin: bool = False, student: sqlite3.Row | None = None
) -> dict | None:
    with connect() as database:
        course = database.execute(
            "SELECT * FROM courses WHERE UPPER(code) = UPPER(?)", (code,)
        ).fetchone()
        if not course:
            return None
        payload = dict(course)
        grade_scale = parse_grade_scale(payload.pop("grade_scale_json", ""))
        payload["grade_scale"] = grade_scale
        authenticated = bool(student and student["course_id"] == course["id"])
        payload["access"] = {
            "authenticated": authenticated,
            "public_overview": bool(course["public_overview"]),
            "public_schedule": bool(course["public_schedule"]),
            "public_articles": bool(course["public_articles"]),
            "public_resources": bool(course["public_resources"]),
            "public_chat": bool(course["public_chat"]),
        }
        payload.pop("cover_file", None)
        if not (admin or authenticated):
            payload["drive_url"] = ""
            payload["drive_connected"] = 0
            if not course["public_overview"]:
                payload["description"] = ""
                payload["ementa"] = ""
                payload["class_day"] = ""
                payload["room"] = ""
        sessions = database.execute(
            """
            SELECT * FROM class_sessions
            WHERE course_id = ?
            ORDER BY session_date, start_time, id
            """,
            (course["id"],),
        ).fetchall()
        can_see_schedule = admin or authenticated or bool(course["public_schedule"])
        can_see_articles = admin or authenticated or bool(course["public_articles"])
        payload["sessions"] = [
            session_payload(
                database,
                item,
                include_private=admin,
                include_articles=can_see_articles,
                viewer_student_id=student["id"] if authenticated else None,
            )
            for item in sessions
        ] if can_see_schedule else []
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
        payload["deliverable_types"] = [
            dict(row)
            for row in database.execute(
                "SELECT * FROM deliverable_types WHERE course_id = ? AND active = 1 ORDER BY id",
                (course["id"],),
            ).fetchall()
        ]
        if authenticated:
            payload["my_assignments"] = [
                dict(row)
                for row in database.execute(
                    """
                    SELECT pr.id AS reservation_id, pr.article_id, pr.session_id, pr.group_name,
                           a.code AS article_code, a.title AS article_title,
                           cs.title AS session_title, cs.session_date, cs.submission_deadline
                    FROM presentation_reservations pr
                    JOIN articles a ON a.id = pr.article_id
                    JOIN class_sessions cs ON cs.id = pr.session_id
                    WHERE pr.student_id = ? AND pr.kind = 'article'
                    ORDER BY cs.session_date, a.id
                    """,
                    (student["id"],),
                ).fetchall()
            ]
            for assignment in payload["my_assignments"]:
                assignment["required_deliverables"] = ["Resenha", "Apresentação"]
                assignment["uploads"] = [
                    dict(row)
                    for row in database.execute(
                        """
                        SELECT u.id, u.filename, u.created_at, dt.name AS deliverable_type
                        FROM uploads u LEFT JOIN deliverable_types dt ON dt.id = u.deliverable_type_id
                        WHERE u.student_id = ? AND u.article_id = ?
                        ORDER BY u.created_at
                        """,
                        (student["id"], assignment["article_id"]),
                    ).fetchall()
                ]
            payload["grades"] = [
                dict(row)
                for row in database.execute(
                    """
                    SELECT ai.id AS assessment_id, ai.name, ai.kind, ai.max_score, ai.weight,
                           ai.due_at, sg.score, sg.feedback, sg.updated_at
                    FROM assessment_items ai
                    LEFT JOIN student_grades sg
                      ON sg.assessment_id = ai.id AND sg.student_id = ?
                    WHERE ai.course_id = ? AND ai.active = 1
                    ORDER BY ai.id
                    """,
                    (student["id"], course["id"]),
                ).fetchall()
            ]
            payload["grade_summary"] = student_grade_summary(
                database, course["id"], student["id"], grade_scale
            )
            payload["grade_summary"]["published"] = bool(course["grade_results_published"])
            if not course["grade_results_published"]:
                payload["grade_summary"]["concept"] = None
        if admin:
            payload["students"] = [
                public_student(row)
                for row in database.execute(
                    "SELECT * FROM students WHERE course_id = ? ORDER BY name", (course["id"],)
                ).fetchall()
            ]
            payload["uploads"] = [
                dict(row)
                for row in database.execute(
                    """
                    SELECT u.*, s.name AS student_name, cs.title AS session_title,
                           a.title AS article_title, dt.name AS deliverable_type_name
                    FROM uploads u
                    JOIN students s ON s.id = u.student_id
                    LEFT JOIN class_sessions cs ON cs.id = u.session_id
                    LEFT JOIN articles a ON a.id = u.article_id
                    LEFT JOIN deliverable_types dt ON dt.id = u.deliverable_type_id
                    WHERE u.course_id = ?
                    ORDER BY u.created_at DESC, u.id DESC
                    """,
                    (course["id"],),
                ).fetchall()
            ]
            payload["presentations"] = [
                dict(row)
                for row in database.execute(
                    """
                    SELECT pr.*, s.name AS student_name, cs.title AS session_title,
                           a.code AS article_code, a.title AS article_title
                    FROM presentation_reservations pr
                    JOIN students s ON s.id = pr.student_id
                    LEFT JOIN class_sessions cs ON cs.id = pr.session_id
                    LEFT JOIN articles a ON a.id = pr.article_id
                    WHERE pr.course_id = ?
                    ORDER BY pr.created_at DESC, pr.id DESC
                    """,
                    (course["id"],),
                ).fetchall()
            ]
            payload["assessments"] = []
            for assessment in database.execute(
                "SELECT * FROM assessment_items WHERE course_id = ? ORDER BY active DESC, id",
                (course["id"],),
            ).fetchall():
                assessment_payload = dict(assessment)
                assessment_payload["grades"] = [
                    dict(row)
                    for row in database.execute(
                        """
                        SELECT sg.id, sg.student_id, sg.score, sg.feedback, sg.updated_at,
                               s.name AS student_name, s.nusp
                        FROM student_grades sg
                        JOIN students s ON s.id = sg.student_id
                        WHERE sg.assessment_id = ?
                        ORDER BY s.name
                        """,
                        (assessment["id"],),
                    ).fetchall()
                ]
                payload["assessments"].append(assessment_payload)
            payload["student_grade_summaries"] = {
                str(item["id"]): student_grade_summary(
                    database, course["id"], item["id"], grade_scale
                )
                for item in database.execute(
                    "SELECT id FROM students WHERE course_id = ? AND active = 1",
                    (course["id"],),
                ).fetchall()
            }
        return payload


def course_id_for(database: sqlite3.Connection, code: str) -> int | None:
    row = database.execute("SELECT id FROM courses WHERE UPPER(code) = UPPER(?)", (code,)).fetchone()
    return row[0] if row else None


def class_room_payload(session_id: int, *, actor: dict | None = None) -> dict | None:
    with connect() as database:
        session = database.execute(
            """
            SELECT cs.*, c.code AS course_code, c.public_schedule, c.public_resources, c.public_chat
            FROM class_sessions cs JOIN courses c ON c.id = cs.course_id
            WHERE cs.id = ?
            """,
            (session_id,),
        ).fetchone()
        if not session:
            return None
        authenticated = actor is not None
        room_session = session_payload(
            database, session, include_private=authenticated, include_articles=authenticated
        )
        if not authenticated and not session["public_schedule"]:
            room_session = {"id": session["id"], "course_code": session["course_code"]}
        payload = {
            "session": room_session,
            "actor": actor,
            "permissions": {
                "can_post": authenticated,
                "can_view_resources": authenticated or bool(session["public_resources"]),
                "can_view_chat": authenticated or bool(session["public_chat"]),
            },
        }
        if payload["permissions"]["can_view_resources"]:
            payload["resources"] = [
                dict(row)
                for row in database.execute(
                    """
                    SELECT * FROM session_resources
                    WHERE session_id = ? AND (? = 1 OR visibility = 'public')
                    ORDER BY created_at DESC, id DESC
                    """,
                    (session_id, 1 if authenticated else 0),
                ).fetchall()
            ]
        else:
            payload["resources"] = []
        if payload["permissions"]["can_view_chat"]:
            payload["comments"] = [
                dict(row)
                for row in database.execute(
                    "SELECT * FROM session_comments WHERE session_id = ? ORDER BY created_at, id",
                    (session_id,),
                ).fetchall()
            ]
        else:
            payload["comments"] = []
        specialist = database.execute(
            "SELECT name, email, role, linkedin, whatsapp, website FROM session_specialists WHERE session_id = ? AND active = 1",
            (session_id,),
        ).fetchone()
        payload["specialist"] = dict(specialist) if specialist and authenticated else None
        return payload


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

    @staticmethod
    def is_admin_path(path: str) -> bool:
        return (
            path == "/api/admin"
            or path.startswith("/api/admin/")
        )

    def require_admin(self, path: str) -> bool:
        if not self.is_admin_path(path):
            return True
        if path == "/api/admin/login":
            return True
        authorization = self.headers.get("Authorization", "")
        if self.bearer_admin():
            return True
        if authorization.startswith("Basic "):
            try:
                decoded = base64.b64decode(
                    authorization.removeprefix("Basic "), validate=True
                ).decode("utf-8")
                username, password = decoded.split(":", 1)
            except (ValueError, UnicodeDecodeError):
                username, password = "", ""
            if ADMIN_PASSWORD and secrets.compare_digest(username, ADMIN_USERNAME) and secrets.compare_digest(
                password, ADMIN_PASSWORD
            ):
                return True
        if not ADMIN_PASSWORD and ALLOW_INSECURE_ADMIN:
            return True
        self.error_response("Entre no painel com as credenciais da professora.", 401)
        return False

    def bearer_admin(self) -> sqlite3.Row | None:
        authorization = self.headers.get("Authorization", "")
        if not authorization.startswith("Bearer "):
            return None
        token = authorization.removeprefix("Bearer ").strip()
        with connect() as database:
            row = database.execute(
                """
                SELECT t.*, aas.token AS session_token
                FROM admin_auth_sessions aas
                LEFT JOIN teachers t ON t.id = aas.teacher_id
                WHERE aas.token = ? AND aas.expires_at > ?
                """,
                (token, utc_now_iso()),
            ).fetchone()
            if row:
                return row
            legacy = database.execute(
                "SELECT token AS session_token FROM admin_auth_sessions WHERE token = ? AND expires_at > ?",
                (token, utc_now_iso()),
            ).fetchone()
            return legacy

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

    def bearer_specialist(self) -> sqlite3.Row | None:
        authorization = self.headers.get("Authorization", "")
        if not authorization.startswith("Bearer "):
            return None
        token = authorization.removeprefix("Bearer ").strip()
        with connect() as database:
            return database.execute(
                """
                SELECT ss.*, cs.course_id, cs.title AS session_title, c.code AS course_code
                FROM specialist_auth_sessions sas
                JOIN session_specialists ss ON ss.id = sas.specialist_id
                JOIN class_sessions cs ON cs.id = ss.session_id
                JOIN courses c ON c.id = cs.course_id
                WHERE sas.token = ? AND sas.expires_at > ? AND ss.active = 1
                """,
                (token, utc_now_iso()),
            ).fetchone()

    def actor_for_session(self, session_id: int) -> dict | None:
        admin = self.bearer_admin()
        if admin:
            return {"role": "admin", "name": admin["name"] if "name" in admin.keys() and admin["name"] else "Professora", "id": admin["id"] if "id" in admin.keys() else None}
        student = self.bearer_student()
        if student:
            with connect() as database:
                belongs = database.execute(
                    "SELECT 1 FROM class_sessions WHERE id = ? AND course_id = ?",
                    (session_id, student["course_id"]),
                ).fetchone()
            if belongs:
                return {"role": "student", "name": student["name"], "id": student["id"]}
        specialist = self.bearer_specialist()
        if specialist and specialist["session_id"] == session_id:
            return {"role": "specialist", "name": specialist["name"], "id": specialist["id"]}
        return None

    def do_GET(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if not self.require_admin(path):
            return
        if path == "/api/health":
            self.json_response(
                {
                    "status": "ok",
                    "storage": "persistent" if DATA_DIR != ROOT else "local",
                    "today": local_today_iso(),
                }
            )
            return
        if path == "/api/courses":
            with connect() as database:
                courses = [
                    dict(row) for row in database.execute(
                        """
                        SELECT code, title, short_title, semester, cover, status, visibility,
                               public_overview, public_schedule
                        FROM courses ORDER BY code
                        """
                    ).fetchall()
                ]
            self.json_response(courses)
            return
        match = re.fullmatch(r"/api/courses/([A-Za-z0-9_-]+)/cover", path)
        if match:
            with connect() as database:
                course = database.execute(
                    "SELECT cover_file FROM courses WHERE UPPER(code) = UPPER(?)", (match.group(1),)
                ).fetchone()
            if not course or not course["cover_file"]:
                self.error_response("Capa enviada não encontrada.", 404)
                return
            target = (COVER_DIR / course["cover_file"]).resolve()
            if target.parent != COVER_DIR.resolve() or not target.is_file():
                self.error_response("Arquivo da capa não encontrado.", 404)
                return
            content_type = mimetypes.guess_type(target.name)[0] or "image/jpeg"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(target.stat().st_size))
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            with target.open("rb") as source:
                while chunk := source.read(64 * 1024):
                    self.wfile.write(chunk)
            return
        match = re.fullmatch(r"/api/courses/([A-Za-z0-9_-]+)/meeting", path)
        if match:
            student = self.bearer_student()
            if not student or student["course_code"].upper() != match.group(1).upper():
                self.error_response("Entre nesta disciplina para acessar a aula online.", 401)
                return
            with connect() as database:
                meeting = database.execute(
                    """
                    SELECT id, session_date, start_time, title, meet_url
                    FROM class_sessions
                    WHERE course_id = ? AND session_date >= ?
                    ORDER BY session_date, start_time, id
                    LIMIT 1
                    """,
                    (student["course_id"], local_today_iso()),
                ).fetchone()
            if not meeting or not meeting["meet_url"]:
                self.error_response("O link do Google Meet desta aula ainda não foi publicado.", 404)
                return
            self.json_response({"meeting": dict(meeting)})
            return
        match = re.fullmatch(r"/api/courses/([A-Za-z0-9_-]+)", path)
        if match:
            student = self.bearer_student()
            payload = course_payload(match.group(1), student=student)
            if payload is None:
                self.error_response("Disciplina não encontrada.", 404)
            else:
                self.json_response(payload)
            return
        match = re.fullmatch(r"/api/courses/([A-Za-z0-9_-]+)/sessions/(\d+)/room", path)
        if match:
            session_id = int(match.group(2))
            with connect() as database:
                valid = database.execute(
                    """
                    SELECT 1 FROM class_sessions cs JOIN courses c ON c.id = cs.course_id
                    WHERE cs.id = ? AND UPPER(c.code) = UPPER(?)
                    """,
                    (session_id, match.group(1)),
                ).fetchone()
            if not valid:
                self.error_response("Sala de aula não encontrada.", 404)
                return
            payload = class_room_payload(session_id, actor=self.actor_for_session(session_id))
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
        if path == "/api/admin/me":
            actor = self.bearer_admin()
            if not actor:
                self.error_response("Sessão administrativa expirada.", 401)
                return
            teacher = {
                key: actor[key]
                for key in ("id", "name", "username", "email", "must_reset_password")
                if key in actor.keys()
            }
            self.json_response({"teacher": teacher})
            return
        if path == "/api/admin/openai/status":
            self.json_response({
                "configured": bool(OPENAI_RUNTIME["api_key"]),
                "source": OPENAI_RUNTIME["source"] or "none",
                "model": OPENAI_MODEL,
            })
            return
        if path == "/api/specialist/me":
            specialist = self.bearer_specialist()
            if not specialist:
                self.error_response("Acesso do especialista inválido ou expirado.", 401)
                return
            public = {
                key: specialist[key]
                for key in ("id", "session_id", "session_title", "course_code", "name", "email", "role", "linkedin", "whatsapp", "website", "invite_expires_at")
            }
            self.json_response({
                "specialist": public,
                "room": class_room_payload(specialist["session_id"], actor={"role": "specialist", "name": specialist["name"], "id": specialist["id"]}),
            })
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
                self.json_response({
                    "student": public_student(student),
                    "course": course_payload(student["course_code"], student=student),
                })
            return
        if path.startswith("/uploads/"):
            self.error_response("Arquivos enviados não são públicos.", 403)
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if not self.require_admin(path):
            return
        if path == "/api/auth/login":
            self.login_student()
            return
        if path == "/api/auth/request-access":
            self.request_student_access()
            return
        if path == "/api/specialist/login":
            self.login_specialist()
            return
        if path == "/api/admin/login":
            self.login_admin()
            return
        if path == "/api/admin/openai/key":
            self.configure_openai_key()
            return
        if path == "/api/admin/ai/fill":
            self.ai_fill_fields()
            return
        if path == "/api/presentations":
            self.create_presentation_reservation()
            return
        match = re.fullmatch(r"/api/articles/(\d+)/choose", path)
        if match:
            self.choose_article(int(match.group(1)))
            return
        match = re.fullmatch(r"/api/sessions/(\d+)/resources", path)
        if match:
            self.create_session_resource(int(match.group(1)))
            return
        match = re.fullmatch(r"/api/sessions/(\d+)/comments", path)
        if match:
            self.create_session_comment(int(match.group(1)))
            return
        if path == "/api/admin/courses":
            self.create_course()
            return
        match = re.fullmatch(r"/api/admin/courses/([A-Za-z0-9_-]+)/students", path)
        if match:
            self.create_student(match.group(1))
            return
        match = re.fullmatch(r"/api/admin/students/(\d+)/token", path)
        if match:
            self.reset_student_token(int(match.group(1)))
            return
        match = re.fullmatch(r"/api/admin/courses/([A-Za-z0-9_-]+)/cover", path)
        if match:
            self.upload_course_cover(match.group(1))
            return
        match = re.fullmatch(r"/api/admin/courses/([A-Za-z0-9_-]+)/sessions", path)
        if match:
            self.create_session(match.group(1))
            return
        match = re.fullmatch(r"/api/admin/courses/([A-Za-z0-9_-]+)/deliverables", path)
        if match:
            self.create_deliverable_type(match.group(1))
            return
        match = re.fullmatch(r"/api/admin/courses/([A-Za-z0-9_-]+)/assessments", path)
        if match:
            self.create_assessment(match.group(1))
            return
        match = re.fullmatch(r"/api/admin/sessions/(\d+)/articles", path)
        if match:
            self.create_article(int(match.group(1)))
            return
        match = re.fullmatch(r"/api/admin/sessions/(\d+)/specialist-invite", path)
        if match:
            self.create_specialist_invite(int(match.group(1)))
            return
        if path == "/api/uploads":
            self.create_upload()
            return
        self.error_response("Rota não encontrada.", 404)

    def do_PUT(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if not self.require_admin(path):
            return
        if path == "/api/admin/password":
            self.update_teacher_password()
            return
        if path == "/api/specialist/profile":
            self.update_specialist_profile()
            return
        match = re.fullmatch(r"/api/admin/courses/([A-Za-z0-9_-]+)", path)
        if match:
            self.update_course(match.group(1))
            return
        match = re.fullmatch(r"/api/admin/sessions/(\d+)", path)
        if match:
            self.update_session(int(match.group(1)))
            return
        match = re.fullmatch(r"/api/admin/assessments/(\d+)", path)
        if match:
            self.update_assessment(int(match.group(1)))
            return
        match = re.fullmatch(r"/api/admin/assessments/(\d+)/grades/(\d+)", path)
        if match:
            self.update_student_grade(int(match.group(1)), int(match.group(2)))
            return
        self.error_response("Rota não encontrada.", 404)

    def do_PATCH(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if not self.require_admin(path):
            return
        match = re.fullmatch(r"/api/admin/students/(\d+)", path)
        if match:
            data = self.read_json()
            with connect() as database:
                student = database.execute(
                    "SELECT course_id FROM students WHERE id = ?", (int(match.group(1)),)
                ).fetchone()
                cursor = database.execute(
                    "UPDATE students SET active = ? WHERE id = ?",
                    (1 if data.get("active") else 0, int(match.group(1))),
                )
                if student:
                    database.execute(
                        "UPDATE courses SET grade_results_published = 0 WHERE id = ?",
                        (student["course_id"],),
                    )
            if not cursor.rowcount:
                self.error_response("Aluno não encontrado.", 404)
            else:
                self.json_response({"ok": True})
            return
        self.error_response("Rota não encontrada.", 404)

    def do_DELETE(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if not self.require_admin(path):
            return
        match = re.fullmatch(r"/api/admin/students/(\d+)", path)
        if match:
            with connect() as database:
                student = database.execute(
                    "SELECT course_id FROM students WHERE id = ?", (int(match.group(1)),)
                ).fetchone()
                if student:
                    database.execute("DELETE FROM students WHERE id = ?", (int(match.group(1)),))
                    database.execute(
                        "UPDATE courses SET grade_results_published = 0 WHERE id = ?",
                        (student["course_id"],),
                    )
            if not student:
                self.error_response("Aluno não encontrado.", 404)
            else:
                self.json_response({"ok": True})
            return
        match = re.fullmatch(r"/api/admin/assessments/(\d+)", path)
        if match:
            with connect() as database:
                assessment = database.execute(
                    "SELECT course_id FROM assessment_items WHERE id = ?", (int(match.group(1)),)
                ).fetchone()
                if assessment:
                    database.execute(
                        "DELETE FROM assessment_items WHERE id = ?", (int(match.group(1)),)
                    )
                    database.execute(
                        "UPDATE courses SET grade_results_published = 0 WHERE id = ?",
                        (assessment["course_id"],),
                    )
            if not assessment:
                self.error_response("Avaliação não encontrada.", 404)
            else:
                self.json_response({"ok": True})
            return
        match = re.fullmatch(r"/api/admin/presentations/(\d+)", path)
        if match:
            with connect() as database:
                reservation = database.execute(
                    "SELECT article_id, student_id FROM presentation_reservations WHERE id = ?",
                    (int(match.group(1)),),
                ).fetchone()
                if reservation:
                    database.execute(
                        "DELETE FROM article_presenters WHERE article_id = ? AND student_id = ?",
                        (reservation["article_id"], reservation["student_id"]),
                    )
                    database.execute(
                        "DELETE FROM presentation_reservations WHERE id = ?", (int(match.group(1)),)
                    )
            if not reservation:
                self.error_response("Reserva não encontrada.", 404)
            else:
                self.json_response({"ok": True})
            return
        for pattern, table, label in [
            (r"/api/admin/sessions/(\d+)", "class_sessions", "Aula"),
            (r"/api/admin/articles/(\d+)", "articles", "Artigo"),
            (r"/api/admin/deliverables/(\d+)", "deliverable_types", "Tipo de entrega"),
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
        identifier = str(
            data.get("access_token") or data.get("identifier") or data.get("email") or data.get("nusp") or ""
        ).strip()
        if not code or not identifier:
            self.error_response("Informe o token de acesso da disciplina.")
            return
        with connect() as database:
            if identifier.startswith("PEA-"):
                student = database.execute(
                    """
                    SELECT s.*, c.code AS course_code
                    FROM students s JOIN courses c ON c.id = s.course_id
                    WHERE UPPER(c.code) = UPPER(?) AND s.access_token_hash = ? AND s.active = 1
                    """,
                    (code, secret_hash(identifier)),
                ).fetchone()
            else:
                student = database.execute(
                    """
                    SELECT s.*, c.code AS course_code
                    FROM students s JOIN courses c ON c.id = s.course_id
                    WHERE UPPER(c.code) = UPPER(?)
                      AND (LOWER(s.email) = LOWER(?) OR s.nusp = ?)
                      AND s.active = 1
                    """,
                    (code, identifier, identifier),
                ).fetchone()
            if not student:
                self.error_response("Token inválido ou aluno sem acesso a esta disciplina.", 401)
                return
            token = secrets.token_urlsafe(32)
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat()
            database.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (utc_now_iso(),))
            database.execute(
                "INSERT INTO auth_sessions (token, student_id, expires_at) VALUES (?, ?, ?)",
                (token, student["id"], expires_at),
            )
        self.json_response({"token": token, "expires_at": expires_at, "student": public_student(student)})

    def request_student_access(self) -> None:
        data = self.read_json()
        code = str(data.get("course_code", "")).strip()
        identifier = str(data.get("identifier", "")).strip()
        with connect() as database:
            student = database.execute(
                """
                SELECT s.id FROM students s JOIN courses c ON c.id = s.course_id
                WHERE UPPER(c.code) = UPPER(?)
                  AND (LOWER(s.email) = LOWER(?) OR s.nusp = ?) AND s.active = 1
                """,
                (code, identifier, identifier),
            ).fetchone()
            if student:
                database.execute(
                    "INSERT INTO student_access_recovery (student_id, identifier_hint) VALUES (?, ?)",
                    (student["id"], identifier[-4:]),
                )
        self.json_response({
            "ok": True,
            "delivery": "pending_resend",
            "message": "Se o cadastro existir, a solicitação foi registrada. O envio por e-mail será ativado quando o Resend for conectado.",
        })

    def login_admin(self) -> None:
        data = self.read_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        with connect() as database:
            teacher = database.execute(
                "SELECT * FROM teachers WHERE LOWER(username) = LOWER(?) AND active = 1",
                (username,),
            ).fetchone()
            valid_teacher = bool(teacher and verify_password(password, teacher["password_hash"]))
            valid_legacy = bool(
                ADMIN_PASSWORD
                and secrets.compare_digest(username, ADMIN_USERNAME)
                and secrets.compare_digest(password, ADMIN_PASSWORD)
            )
            if not valid_teacher and not valid_legacy:
                if not ADMIN_PASSWORD and ALLOW_INSECURE_ADMIN:
                    teacher = database.execute("SELECT * FROM teachers WHERE active = 1 ORDER BY id LIMIT 1").fetchone()
                else:
                    self.error_response("Usuário ou senha do painel incorretos.", 401)
                    return
            if valid_legacy and not teacher:
                teacher = database.execute("SELECT * FROM teachers WHERE active = 1 ORDER BY id LIMIT 1").fetchone()
            token = secrets.token_urlsafe(32)
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat()
            database.execute("DELETE FROM admin_auth_sessions WHERE expires_at <= ?", (utc_now_iso(),))
            database.execute(
                "INSERT INTO admin_auth_sessions (token, teacher_id, expires_at) VALUES (?, ?, ?)",
                (token, teacher["id"] if teacher else None, expires_at),
            )
        self.json_response({
            "token": token,
            "expires_at": expires_at,
            "teacher": {
                "id": teacher["id"], "name": teacher["name"], "username": teacher["username"],
                "email": teacher["email"], "must_reset_password": bool(teacher["must_reset_password"]),
            } if teacher else None,
        })

    def update_teacher_password(self) -> None:
        teacher = self.bearer_admin()
        if not teacher or "password_hash" not in teacher.keys():
            self.error_response("Entre novamente para alterar a senha.", 401)
            return
        data = self.read_json()
        current_password = str(data.get("current_password", ""))
        new_password = str(data.get("new_password", ""))
        if not verify_password(current_password, teacher["password_hash"]):
            self.error_response("A senha atual está incorreta.", 401)
            return
        if len(new_password) < 10 or not re.search(r"[A-Za-z]", new_password) or not re.search(r"\d", new_password):
            self.error_response("Use ao menos 10 caracteres, com letras e números.")
            return
        with connect() as database:
            database.execute(
                "UPDATE teachers SET password_hash = ?, must_reset_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (hash_password(new_password), teacher["id"]),
            )
        self.json_response({"ok": True, "must_reset_password": False})

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
                access_token = create_access_token()
                cursor = database.execute(
                    """
                    INSERT INTO students
                        (course_id, name, email, nusp, group_name, active,
                         access_token_hash, access_token_hint, token_created_at)
                    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
                    """,
                    (
                        course_id, required[0], required[1].lower(), required[2],
                        str(data.get("group_name", "—")), secret_hash(access_token),
                        access_token[-6:], utc_now_iso(),
                    ),
                )
                student = database.execute("SELECT * FROM students WHERE id = ?", (cursor.lastrowid,)).fetchone()
                database.execute(
                    "UPDATE courses SET grade_results_published = 0 WHERE id = ?", (course_id,)
                )
        except sqlite3.IntegrityError:
            self.error_response("Esse e-mail ou Nº USP já está cadastrado.", 409)
            return
        self.json_response({"student": public_student(student), "access_token": access_token}, 201)

    def reset_student_token(self, student_id: int) -> None:
        access_token = create_access_token()
        with connect() as database:
            cursor = database.execute(
                """
                UPDATE students
                SET access_token_hash = ?, access_token_hint = ?, token_created_at = ?
                WHERE id = ?
                """,
                (secret_hash(access_token), access_token[-6:], utc_now_iso(), student_id),
            )
            database.execute("DELETE FROM auth_sessions WHERE student_id = ?", (student_id,))
        if not cursor.rowcount:
            self.error_response("Aluno não encontrado.", 404)
            return
        self.json_response({"access_token": access_token, "hint": access_token[-6:]})

    def create_presentation_reservation(self) -> None:
        student = self.bearer_student()
        if not student:
            self.error_response("Entre na disciplina antes de reservar uma apresentação.", 401)
            return
        data = self.read_json()
        kind = str(data.get("kind", "article")).strip().lower()
        group_name = str(data.get("group_name", "")).strip()
        topic = str(data.get("topic", "")).strip()
        members = str(data.get("members", "")).strip()
        slides_url = str(data.get("slides_url", "")).strip()
        try:
            target_id = int(data.get("target_id", 0))
        except (TypeError, ValueError):
            target_id = 0
        if kind not in {"article", "final"} or not group_name or not members or not target_id:
            self.error_response("Informe o tipo, o destino, o grupo e seus integrantes.")
            return
        if slides_url:
            parsed_slides = urlparse(slides_url)
            if parsed_slides.scheme not in {"http", "https"}:
                self.error_response("Informe um link válido para os slides.")
                return
        with connect() as database:
            database.execute("BEGIN IMMEDIATE")
            session_id = None
            article_id = None
            if kind == "article":
                article = database.execute(
                    """
                    SELECT a.id, a.session_id, cs.student_choice_enabled, cs.submission_deadline
                    FROM articles a
                    JOIN class_sessions cs ON cs.id = a.session_id
                    WHERE a.id = ? AND cs.course_id = ?
                    """,
                    (target_id, student["course_id"]),
                ).fetchone()
                if not article:
                    self.error_response("O artigo selecionado não pertence a esta disciplina.")
                    return
                if not article["student_choice_enabled"]:
                    self.error_response("A escolha de artigos ainda não foi aberta pela professora.", 403)
                    return
                deadline = str(article["submission_deadline"] or "")
                if deadline and deadline <= datetime.now(APP_TIMEZONE).strftime("%Y-%m-%dT%H:%M"):
                    self.error_response("O período de escolha e envio desta aula foi encerrado.", 409)
                    return
                if database.execute(
                    "SELECT 1 FROM presentation_reservations WHERE article_id = ? LIMIT 1",
                    (target_id,),
                ).fetchone():
                    self.error_response("Este artigo já possui um grupo inscrito.", 409)
                    return
                article_id = article["id"]
                session_id = article["session_id"]
            else:
                session = database.execute(
                    "SELECT id FROM class_sessions WHERE id = ? AND course_id = ?",
                    (target_id, student["course_id"]),
                ).fetchone()
                if not session:
                    self.error_response("A aula final selecionada não pertence a esta disciplina.")
                    return
                session_id = session["id"]
            cursor = database.execute(
                """
                INSERT INTO presentation_reservations
                    (course_id, student_id, session_id, article_id, kind, group_name, topic, members, slides_url)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    student["course_id"], student["id"], session_id, article_id, kind,
                    group_name, topic, members, slides_url,
                ),
            )
            reservation = database.execute(
                "SELECT * FROM presentation_reservations WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        self.json_response({"presentation": dict(reservation)}, 201)

    def choose_article(self, article_id: int) -> None:
        student = self.bearer_student()
        if not student:
            self.error_response("Entre na disciplina para escolher um artigo.", 401)
            return
        try:
            with connect() as database:
                database.execute("BEGIN IMMEDIATE")
                article = database.execute(
                    """
                    SELECT a.id, a.session_id, a.title, a.code,
                           cs.student_choice_enabled, cs.submission_deadline
                    FROM articles a JOIN class_sessions cs ON cs.id = a.session_id
                    WHERE a.id = ? AND cs.course_id = ?
                    """,
                    (article_id, student["course_id"]),
                ).fetchone()
                if not article:
                    self.error_response("Artigo não encontrado nesta disciplina.", 404)
                    return
                if not article["student_choice_enabled"]:
                    self.error_response("A professora ainda não abriu a escolha desta aula.", 403)
                    return
                deadline = str(article["submission_deadline"] or "")
                now_local = datetime.now(APP_TIMEZONE).strftime("%Y-%m-%dT%H:%M")
                if deadline and deadline <= now_local:
                    self.error_response("O prazo para escolher este artigo terminou.", 409)
                    return
                existing_student = database.execute(
                    """
                    SELECT pr.id, a.title
                    FROM presentation_reservations pr
                    JOIN articles a ON a.id = pr.article_id
                    WHERE pr.student_id = ? AND pr.course_id = ? AND pr.kind = 'article'
                    LIMIT 1
                    """,
                    (student["id"], student["course_id"]),
                ).fetchone()
                if existing_student:
                    self.error_response(
                        f"Você já escolheu o artigo “{existing_student['title']}”. Somente a professora pode alterar a escolha.",
                        409,
                    )
                    return
                occupied = database.execute(
                    """
                    SELECT 1 FROM presentation_reservations WHERE article_id = ?
                    UNION ALL
                    SELECT 1 FROM article_presenters WHERE article_id = ?
                    LIMIT 1
                    """,
                    (article_id, article_id),
                ).fetchone()
                if occupied:
                    self.error_response("Outro aluno acabou de escolher este artigo.", 409)
                    return
                cursor = database.execute(
                    """
                    INSERT INTO presentation_reservations
                        (course_id, student_id, session_id, article_id, kind, group_name, members)
                    VALUES (?, ?, ?, ?, 'article', ?, ?)
                    """,
                    (
                        student["course_id"], student["id"], article["session_id"], article_id,
                        student["name"], f"Nº USP {student['nusp']}",
                    ),
                )
                database.execute(
                    "INSERT OR IGNORE INTO article_presenters (article_id, student_id) VALUES (?, ?)",
                    (article_id, student["id"]),
                )
                reservation = database.execute(
                    "SELECT * FROM presentation_reservations WHERE id = ?", (cursor.lastrowid,)
                ).fetchone()
        except sqlite3.IntegrityError:
            self.error_response("Outro aluno acabou de escolher este artigo.", 409)
            return
        self.json_response({
            "reservation": dict(reservation),
            "required_deliverables": ["Resenha", "Apresentação"],
            "submission_deadline": article["submission_deadline"],
        }, 201)

    def create_deliverable_type(self, code: str) -> None:
        data = self.read_json()
        name = str(data.get("name", "")).strip()
        if not name or len(name) > 80:
            self.error_response("Informe um nome de entrega com até 80 caracteres.")
            return
        try:
            with connect() as database:
                course_id = course_id_for(database, code)
                if not course_id:
                    self.error_response("Disciplina não encontrada.", 404)
                    return
                cursor = database.execute(
                    "INSERT INTO deliverable_types (course_id, name) VALUES (?, ?)",
                    (course_id, name),
                )
                deliverable = database.execute(
                    "SELECT * FROM deliverable_types WHERE id = ?", (cursor.lastrowid,)
                ).fetchone()
        except sqlite3.IntegrityError:
            self.error_response("Esse tipo de entrega já está cadastrado.", 409)
            return
        self.json_response({"deliverable_type": dict(deliverable)}, 201)

    @staticmethod
    def assessment_values(data: dict, current: sqlite3.Row | None = None) -> tuple | None:
        name = str(data.get("name", current["name"] if current else "")).strip()[:120]
        kind = str(data.get("kind", current["kind"] if current else "other")).strip().lower()
        if kind not in {"review", "presentation", "participation", "final_work", "article", "other"}:
            kind = "other"
        try:
            max_score = float(data.get("max_score", current["max_score"] if current else 10))
            weight = float(data.get("weight", current["weight"] if current else 0))
        except (TypeError, ValueError):
            return None
        due_at = str(data.get("due_at", current["due_at"] if current else "")).strip()
        if due_at and not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", due_at):
            return None
        active = 1 if data.get("active", bool(current["active"]) if current else True) else 0
        if not name or not (0 < max_score <= 1000) or not (0 <= weight <= 100):
            return None
        return name, kind, max_score, weight, due_at, active

    def create_assessment(self, code: str) -> None:
        data = self.read_json()
        values = self.assessment_values(data)
        if values is None:
            self.error_response("Revise o nome, a nota máxima, o peso e o prazo da avaliação.")
            return
        with connect() as database:
            course_id = course_id_for(database, code)
            if not course_id:
                self.error_response("Disciplina não encontrada.", 404)
                return
            cursor = database.execute(
                """
                INSERT INTO assessment_items
                    (course_id, name, kind, max_score, weight, due_at, active)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (course_id, *values),
            )
            assessment = database.execute(
                "SELECT * FROM assessment_items WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            database.execute(
                "UPDATE courses SET grade_results_published = 0 WHERE id = ?", (course_id,)
            )
        self.json_response({"assessment": dict(assessment)}, 201)

    def update_assessment(self, assessment_id: int) -> None:
        data = self.read_json()
        with connect() as database:
            assessment = database.execute(
                "SELECT * FROM assessment_items WHERE id = ?", (assessment_id,)
            ).fetchone()
            if not assessment:
                self.error_response("Avaliação não encontrada.", 404)
                return
            values = self.assessment_values(data, assessment)
            if values is None:
                self.error_response("Revise o nome, a nota máxima, o peso e o prazo da avaliação.")
                return
            database.execute(
                """
                UPDATE assessment_items
                SET name = ?, kind = ?, max_score = ?, weight = ?, due_at = ?, active = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (*values, assessment_id),
            )
            database.execute(
                "UPDATE courses SET grade_results_published = 0 WHERE id = ?",
                (assessment["course_id"],),
            )
            updated = database.execute(
                "SELECT * FROM assessment_items WHERE id = ?", (assessment_id,)
            ).fetchone()
        self.json_response({"assessment": dict(updated)})

    def update_student_grade(self, assessment_id: int, student_id: int) -> None:
        data = self.read_json()
        feedback = str(data.get("feedback", "")).strip()[:4000]
        raw_score = data.get("score")
        with connect() as database:
            link = database.execute(
                """
                SELECT ai.max_score, ai.course_id, s.name
                FROM assessment_items ai
                JOIN students s ON s.id = ? AND s.course_id = ai.course_id
                WHERE ai.id = ?
                """,
                (student_id, assessment_id),
            ).fetchone()
            if not link:
                self.error_response("Aluno ou avaliação não pertence a esta disciplina.", 404)
                return
            if raw_score is None or str(raw_score).strip() == "":
                database.execute(
                    "DELETE FROM student_grades WHERE assessment_id = ? AND student_id = ?",
                    (assessment_id, student_id),
                )
                database.execute(
                    "UPDATE courses SET grade_results_published = 0 WHERE id = ?", (link["course_id"],)
                )
                self.json_response({"ok": True, "grade": None})
                return
            try:
                score = float(raw_score)
            except (TypeError, ValueError):
                self.error_response("Informe uma nota numérica.")
                return
            if score < 0 or score > float(link["max_score"]):
                self.error_response(f"A nota deve ficar entre 0 e {link['max_score']:g}.")
                return
            database.execute(
                """
                INSERT INTO student_grades (assessment_id, student_id, score, feedback)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(assessment_id, student_id) DO UPDATE SET
                    score = excluded.score, feedback = excluded.feedback,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (assessment_id, student_id, score, feedback),
            )
            database.execute(
                "UPDATE courses SET grade_results_published = 0 WHERE id = ?", (link["course_id"],)
            )
            grade = database.execute(
                "SELECT * FROM student_grades WHERE assessment_id = ? AND student_id = ?",
                (assessment_id, student_id),
            ).fetchone()
        self.json_response({"grade": dict(grade)})

    def create_course(self) -> None:
        data = self.read_json()
        code = str(data.get("code", "")).strip().upper()
        title = str(data.get("title", "")).strip()
        semester = str(data.get("semester", "")).strip()
        template_code = str(data.get("template_code", "")).strip().upper()
        first_class_date = str(data.get("first_class_date", "")).strip()
        if not re.fullmatch(r"[A-Z0-9_-]{3,12}", code) or not title or not semester:
            self.error_response("Informe código, nome e semestre da disciplina.")
            return
        if template_code and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", first_class_date):
            self.error_response("Informe a data da primeira aula para recalcular a agenda clonada.")
            return
        try:
            with connect() as database:
                template_course = None
                template_sessions = []
                if template_code:
                    template_course = database.execute(
                        "SELECT * FROM courses WHERE UPPER(code) = UPPER(?)",
                        (template_code,),
                    ).fetchone()
                    if not template_course:
                        self.error_response("A disciplina usada como modelo não foi encontrada.", 404)
                        return
                    template_sessions = database.execute(
                        """
                        SELECT * FROM class_sessions
                        WHERE course_id = ?
                        ORDER BY session_date, start_time, id
                        """,
                        (template_course["id"],),
                    ).fetchall()
                course_cursor = database.execute(
                    """
                    INSERT INTO courses
                        (code, title, short_title, semester, description, ementa, class_day, room,
                         professor_name, cover, drive_url, drive_connected, status,
                         public_overview, public_schedule, public_articles, public_resources, public_chat,
                         grade_scale_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Rascunho', ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        code, title, str(data.get("short_title", title)).strip(), semester,
                        str(data.get("description", template_course["description"] if template_course else "")),
                        str(data.get("ementa", template_course["ementa"] if template_course else "")),
                        str(data.get("class_day", template_course["class_day"] if template_course else "")),
                        str(data.get("room", template_course["room"] if template_course else "")),
                        str(data.get("professor_name", template_course["professor_name"] if template_course else "Profa. Maria Lídia")),
                        str(data.get("cover", "assets/course-pea5004.webp")),
                        str(data.get("drive_url", "")).strip(), 1 if data.get("drive_url") else 0,
                        template_course["public_overview"] if template_course else 1,
                        template_course["public_schedule"] if template_course else 1,
                        template_course["public_articles"] if template_course else 0,
                        template_course["public_resources"] if template_course else 0,
                        template_course["public_chat"] if template_course else 0,
                        template_course["grade_scale_json"] if template_course else json.dumps(DEFAULT_GRADE_SCALE),
                    ),
                )
                if template_course:
                    deliverable_names = [
                        row["name"]
                        for row in database.execute(
                            "SELECT name FROM deliverable_types WHERE course_id = ? AND active = 1 ORDER BY id",
                            (template_course["id"],),
                        ).fetchall()
                    ]
                else:
                    deliverable_names = ["Resenha", "Artigo", "Apresentação", "Artigo final"]
                database.executemany(
                    "INSERT INTO deliverable_types (course_id, name) VALUES (?, ?)",
                    [(course_cursor.lastrowid, name) for name in deliverable_names],
                )
                if template_course:
                    database.executemany(
                        """
                        INSERT INTO assessment_items
                            (course_id, name, kind, max_score, weight, due_at, active)
                        VALUES (?, ?, ?, ?, ?, '', ?)
                        """,
                        [
                            (
                                course_cursor.lastrowid, item["name"], item["kind"],
                                item["max_score"], item["weight"], item["active"],
                            )
                            for item in database.execute(
                                "SELECT * FROM assessment_items WHERE course_id = ? ORDER BY id",
                                (template_course["id"],),
                            ).fetchall()
                        ],
                    )
                cloned_sessions = 0
                cloned_articles = 0
                if template_sessions:
                    source_start = datetime.fromisoformat(template_sessions[0]["session_date"]).date()
                    target_start = datetime.fromisoformat(first_class_date).date()
                    for source_session in template_sessions:
                        source_date = datetime.fromisoformat(source_session["session_date"]).date()
                        target_date = target_start + timedelta(days=(source_date - source_start).days)
                        session_cursor = database.execute(
                            """
                            INSERT INTO class_sessions
                                (course_id, session_date, start_time, title, theme, location,
                                 specialist_name, specialist_role, specialist_topic, meet_url, notes,
                                 student_choice_enabled, submission_deadline)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, '')
                            """,
                            (
                                course_cursor.lastrowid, target_date.isoformat(), source_session["start_time"],
                                source_session["title"], source_session["theme"], source_session["location"],
                                source_session["specialist_name"], source_session["specialist_role"],
                                source_session["specialist_topic"], source_session["notes"],
                                source_session["student_choice_enabled"],
                            ),
                        )
                        cloned_sessions += 1
                        source_articles = database.execute(
                            "SELECT * FROM articles WHERE session_id = ? ORDER BY id",
                            (source_session["id"],),
                        ).fetchall()
                        for source_article in source_articles:
                            database.execute(
                                """
                                INSERT INTO articles (session_id, code, title, author, url)
                                VALUES (?, ?, ?, ?, ?)
                                """,
                                (
                                    session_cursor.lastrowid, source_article["code"], source_article["title"],
                                    source_article["author"], source_article["url"],
                                ),
                            )
                            cloned_articles += 1
        except sqlite3.IntegrityError:
            self.error_response("Já existe uma disciplina com esse código.", 409)
            return
        except ValueError:
            self.error_response("A data da primeira aula é inválida.")
            return
        self.json_response(
            {
                "course": course_payload(code),
                "cloned": {"sessions": cloned_sessions, "articles": cloned_articles},
            },
            201,
        )

    def create_session(self, code: str) -> None:
        data = self.read_json()
        if not data.get("session_date") or not data.get("title"):
            self.error_response("Informe a data e o título da aula.")
            return
        meet_url = str(data.get("meet_url", "")).strip()
        if meet_url:
            parsed_meet = urlparse(meet_url)
            if parsed_meet.scheme != "https" or parsed_meet.hostname != "meet.google.com":
                self.error_response("Use um link válido iniciado por https://meet.google.com/.")
                return
        submission_deadline = str(data.get("submission_deadline", "")).strip()
        if submission_deadline and not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", submission_deadline):
            self.error_response("Informe uma data e hora válidas para o limite de envio.")
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
                     specialist_name, specialist_role, specialist_topic, meet_url, notes,
                     student_choice_enabled, submission_deadline)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    course_id, data["session_date"], data.get("start_time", "14:00"), data["title"],
                    data.get("theme", ""), data.get("location", ""), data.get("specialist_name", ""),
                    data.get("specialist_role", ""), data.get("specialist_topic", ""), meet_url,
                    data.get("notes", ""), 1 if data.get("student_choice_enabled") else 0,
                    submission_deadline,
                ),
            )
            session = database.execute("SELECT * FROM class_sessions WHERE id = ?", (cursor.lastrowid,)).fetchone()
            payload = session_payload(database, session, include_private=True)
        self.json_response({"session": payload}, 201)

    def update_session(self, session_id: int) -> None:
        data = self.read_json()
        if "meet_url" in data:
            meet_url = str(data.get("meet_url", "")).strip()
            if meet_url:
                parsed_meet = urlparse(meet_url)
                if parsed_meet.scheme != "https" or parsed_meet.hostname != "meet.google.com":
                    self.error_response("Use um link válido iniciado por https://meet.google.com/.")
                    return
            data["meet_url"] = meet_url
        if "submission_deadline" in data:
            deadline = str(data.get("submission_deadline", "")).strip()
            if deadline and not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", deadline):
                self.error_response("Informe uma data e hora válidas para o limite de envio.")
                return
            data["submission_deadline"] = deadline
        if "student_choice_enabled" in data:
            data["student_choice_enabled"] = 1 if data.get("student_choice_enabled") else 0
        with connect() as database:
            existing = database.execute("SELECT * FROM class_sessions WHERE id = ?", (session_id,)).fetchone()
            if not existing:
                self.error_response("Aula não encontrada.", 404)
                return
            fields = [
                "session_date", "start_time", "title", "theme", "location", "specialist_name",
                "specialist_role", "specialist_topic", "meet_url", "notes",
                "student_choice_enabled", "submission_deadline",
            ]
            values = [data.get(field, existing[field]) for field in fields]
            database.execute(
                f"UPDATE class_sessions SET {', '.join(field + ' = ?' for field in fields)}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (*values, session_id),
            )
            session = database.execute("SELECT * FROM class_sessions WHERE id = ?", (session_id,)).fetchone()
            payload = session_payload(database, session, include_private=True)
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
            payload = article_payload(database, article, include_private=True)
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
                "description": "description", "ementa": "ementa", "classDay": "class_day",
                "room": "room", "professorName": "professor_name",
                "driveUrl": "drive_url", "status": "status", "visibility": "visibility",
                "publicOverview": "public_overview", "publicSchedule": "public_schedule",
                "publicArticles": "public_articles", "publicResources": "public_resources",
                "publicChat": "public_chat", "gradeScale": "grade_scale_json",
                "gradeResultsPublished": "grade_results_published",
            }
            updates = {column: data[key] for key, column in mapping.items() if key in data}
            for flag in ("public_overview", "public_schedule", "public_articles", "public_resources", "public_chat", "grade_results_published"):
                if flag in updates:
                    updates[flag] = 1 if updates[flag] else 0
            if "drive_url" in updates:
                updates["drive_connected"] = 1 if updates["drive_url"] else 0
            if "grade_scale_json" in updates:
                scale = updates["grade_scale_json"]
                if not isinstance(scale, list) or len(scale) < 2:
                    self.error_response("Cadastre ao menos duas faixas para a conversão em letras.")
                    return
                normalized = parse_grade_scale(json.dumps(scale))
                if len(normalized) != len(scale):
                    self.error_response("Revise as letras e as notas mínimas da escala.")
                    return
                updates["grade_scale_json"] = json.dumps(normalized, ensure_ascii=False)
                updates["grade_results_published"] = 0
            if updates.get("grade_results_published"):
                assessment_count = database.execute(
                    "SELECT COUNT(*) FROM assessment_items WHERE course_id = ? AND active = 1",
                    (course["id"],),
                ).fetchone()[0]
                student_count = database.execute(
                    "SELECT COUNT(*) FROM students WHERE course_id = ? AND active = 1",
                    (course["id"],),
                ).fetchone()[0]
                grade_count = database.execute(
                    """
                    SELECT COUNT(*) FROM student_grades sg
                    JOIN assessment_items ai ON ai.id = sg.assessment_id AND ai.active = 1
                    JOIN students s ON s.id = sg.student_id AND s.active = 1
                    WHERE ai.course_id = ?
                    """,
                    (course["id"],),
                ).fetchone()[0]
                if not assessment_count or not student_count or grade_count < assessment_count * student_count:
                    self.error_response(
                        "Conclua as notas de todos os alunos nas avaliações ativas antes de publicar.", 409
                    )
                    return
            if updates:
                query = ", ".join(f"{column} = ?" for column in updates)
                database.execute(
                    f"UPDATE courses SET {query}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (*updates.values(), course["id"]),
                )
        self.json_response({"course": course_payload(code)})

    def upload_course_cover(self, code: str) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_COVER_BYTES:
            self.error_response("A capa deve ter no máximo 8 MB.", 413)
            return
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self.error_response("Envie a capa como formulário multipart.")
            return
        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type, "CONTENT_LENGTH": str(content_length)},
        )
        file_field = form["cover"] if "cover" in form else None
        if file_field is None or not getattr(file_field, "filename", ""):
            self.error_response("Selecione uma imagem para a capa.")
            return
        mime_type = file_field.type or mimetypes.guess_type(file_field.filename)[0] or ""
        extension_by_mime = {
            "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
        }
        extension = extension_by_mime.get(mime_type)
        if not extension:
            self.error_response("Use uma imagem JPG, PNG, WebP ou GIF.")
            return
        stored_name = f"{uuid.uuid4().hex}{extension}"
        destination = COVER_DIR / stored_name
        size = 0
        with destination.open("wb") as output:
            while chunk := file_field.file.read(64 * 1024):
                size += len(chunk)
                if size > MAX_COVER_BYTES:
                    destination.unlink(missing_ok=True)
                    self.error_response("A capa deve ter no máximo 8 MB.", 413)
                    return
                output.write(chunk)
        with connect() as database:
            course = database.execute(
                "SELECT id, cover_file FROM courses WHERE UPPER(code) = UPPER(?)", (code,)
            ).fetchone()
            if not course:
                destination.unlink(missing_ok=True)
                self.error_response("Disciplina não encontrada.", 404)
                return
            old_file = course["cover_file"]
            cover_url = f"/api/courses/{code.upper()}/cover?v={uuid.uuid4().hex[:8]}"
            database.execute(
                "UPDATE courses SET cover = ?, cover_file = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (cover_url, stored_name, course["id"]),
            )
        if old_file:
            old_target = (COVER_DIR / old_file).resolve()
            if old_target.parent == COVER_DIR.resolve() and old_target != destination:
                old_target.unlink(missing_ok=True)
        self.json_response({"cover": cover_url, "course": course_payload(code, admin=True)}, 201)

    def create_specialist_invite(self, session_id: int) -> None:
        data = self.read_json()
        name = str(data.get("name", "")).strip()
        if not name:
            self.error_response("Informe o nome do especialista.")
            return
        try:
            duration_hours = min(168, max(1, int(data.get("duration_hours", 48))))
        except (TypeError, ValueError):
            duration_hours = 48
        contacts = {
            "email": str(data.get("email", "")).strip(),
            "role": str(data.get("role", "")).strip(),
            "linkedin": str(data.get("linkedin", "")).strip(),
            "whatsapp": str(data.get("whatsapp", "")).strip(),
            "website": str(data.get("website", "")).strip(),
        }
        for field in ("linkedin", "website"):
            if contacts[field] and not safe_http_url(contacts[field]):
                self.error_response(f"Informe um link válido em {field}.")
                return
        invite_token = secrets.token_urlsafe(32)
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=duration_hours)).isoformat()
        with connect() as database:
            session = database.execute("SELECT id FROM class_sessions WHERE id = ?", (session_id,)).fetchone()
            if not session:
                self.error_response("Aula não encontrada.", 404)
                return
            database.execute(
                """
                INSERT INTO session_specialists
                    (session_id, name, email, role, linkedin, whatsapp, website,
                     invite_token_hash, invite_expires_at, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(session_id) DO UPDATE SET
                    name = excluded.name, email = excluded.email, role = excluded.role,
                    linkedin = excluded.linkedin, whatsapp = excluded.whatsapp,
                    website = excluded.website, invite_token_hash = excluded.invite_token_hash,
                    invite_expires_at = excluded.invite_expires_at, active = 1,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    session_id, name, contacts["email"], contacts["role"], contacts["linkedin"],
                    contacts["whatsapp"], contacts["website"], secret_hash(invite_token), expires_at,
                ),
            )
            specialist = database.execute(
                "SELECT id FROM session_specialists WHERE session_id = ?", (session_id,)
            ).fetchone()
            database.execute("DELETE FROM specialist_auth_sessions WHERE specialist_id = ?", (specialist["id"],))
            database.execute(
                "UPDATE class_sessions SET specialist_name = ?, specialist_role = ? WHERE id = ?",
                (name, contacts["role"], session_id),
            )
        forwarded_proto = self.headers.get("X-Forwarded-Proto", "")
        scheme = forwarded_proto or ("https" if self.headers.get("X-Forwarded-Host") else "http")
        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host", "localhost")
        invite_url = f"{scheme}://{host}/specialist.html#token={quote(invite_token)}"
        self.json_response({"invite_token": invite_token, "invite_url": invite_url, "expires_at": expires_at}, 201)

    def login_specialist(self) -> None:
        data = self.read_json()
        invite_token = str(data.get("token", "")).strip()
        if not invite_token:
            self.error_response("Informe o convite temporário.")
            return
        with connect() as database:
            specialist = database.execute(
                """
                SELECT * FROM session_specialists
                WHERE invite_token_hash = ? AND invite_expires_at > ? AND active = 1
                """,
                (secret_hash(invite_token), utc_now_iso()),
            ).fetchone()
            if not specialist:
                self.error_response("Convite inválido ou expirado.", 401)
                return
            token = secrets.token_urlsafe(32)
            session_expiry = min(
                datetime.fromisoformat(specialist["invite_expires_at"]),
                datetime.now(timezone.utc) + timedelta(hours=12),
            ).isoformat()
            database.execute(
                "INSERT INTO specialist_auth_sessions (token, specialist_id, expires_at) VALUES (?, ?, ?)",
                (token, specialist["id"], session_expiry),
            )
        self.json_response({"token": token, "expires_at": session_expiry})

    def update_specialist_profile(self) -> None:
        specialist = self.bearer_specialist()
        if not specialist:
            self.error_response("Acesso do especialista inválido ou expirado.", 401)
            return
        data = self.read_json()
        fields = ("email", "role", "linkedin", "whatsapp", "website")
        values = {field: str(data.get(field, specialist[field])).strip() for field in fields}
        for field in ("linkedin", "website"):
            if values[field] and not safe_http_url(values[field]):
                self.error_response(f"Informe um link válido em {field}.")
                return
        with connect() as database:
            database.execute(
                """
                UPDATE session_specialists
                SET email = ?, role = ?, linkedin = ?, whatsapp = ?, website = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (*[values[field] for field in fields], specialist["id"]),
            )
            database.execute(
                "UPDATE class_sessions SET specialist_role = ? WHERE id = ?",
                (values["role"], specialist["session_id"]),
            )
        self.json_response({"ok": True, "profile": values})

    def create_session_resource(self, session_id: int) -> None:
        actor = self.actor_for_session(session_id)
        if not actor:
            self.error_response("Entre na turma ou use o convite do especialista para adicionar material.", 401)
            return
        data = self.read_json()
        title = str(data.get("title", "")).strip()[:180]
        url = str(data.get("url", "")).strip()
        content_html = sanitize_rich_html(str(data.get("content_html", "")))
        resource_type = str(data.get("resource_type", "material")).strip()
        visibility = str(data.get("visibility", "class")).strip()
        if not title or (not url and not content_html):
            self.error_response("Informe o título e um link ou uma descrição.")
            return
        if url and not safe_http_url(url):
            self.error_response("Informe um link válido iniciado por http ou https.")
            return
        if resource_type not in {"material", "slide", "link"}:
            resource_type = "material"
        if visibility not in {"class", "public"} or actor["role"] == "student":
            visibility = "class"
        with connect() as database:
            if not database.execute("SELECT 1 FROM class_sessions WHERE id = ?", (session_id,)).fetchone():
                self.error_response("Aula não encontrada.", 404)
                return
            cursor = database.execute(
                """
                INSERT INTO session_resources
                    (session_id, author_role, author_name, title, url, content_html, resource_type, visibility)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (session_id, actor["role"], actor["name"], title, url, content_html, resource_type, visibility),
            )
            resource = database.execute("SELECT * FROM session_resources WHERE id = ?", (cursor.lastrowid,)).fetchone()
        self.json_response({"resource": dict(resource)}, 201)

    def create_session_comment(self, session_id: int) -> None:
        actor = self.actor_for_session(session_id)
        if not actor:
            self.error_response("Entre na turma ou use o convite do especialista para comentar.", 401)
            return
        data = self.read_json()
        content_html = sanitize_rich_html(str(data.get("content_html", "")))
        plain = re.sub(r"<[^>]+>", "", content_html).strip()
        if not plain:
            self.error_response("Escreva um comentário antes de publicar.")
            return
        with connect() as database:
            cursor = database.execute(
                """
                INSERT INTO session_comments (session_id, author_role, author_name, content_html)
                VALUES (?, ?, ?, ?)
                """,
                (session_id, actor["role"], actor["name"], content_html),
            )
            comment = database.execute("SELECT * FROM session_comments WHERE id = ?", (cursor.lastrowid,)).fetchone()
        self.json_response({"comment": dict(comment)}, 201)

    def configure_openai_key(self) -> None:
        data = self.read_json()
        api_key = str(data.get("api_key", "")).strip()
        if api_key and not api_key.startswith("sk-"):
            self.error_response("A chave informada não possui o formato esperado.")
            return
        OPENAI_RUNTIME["api_key"] = api_key
        OPENAI_RUNTIME["source"] = "teacher_session" if api_key else ""
        self.json_response({"configured": bool(api_key), "source": OPENAI_RUNTIME["source"] or "none", "model": OPENAI_MODEL})

    def ai_fill_fields(self) -> None:
        api_key = OPENAI_RUNTIME["api_key"]
        if not api_key:
            self.error_response("Configure uma chave OpenAI no painel antes de usar a IA.", 409)
            return
        data = self.read_json()
        kind = str(data.get("kind", "course"))
        current = data.get("fields") if isinstance(data.get("fields"), dict) else {}
        if kind == "session":
            schema_properties = {
                "title": {"type": "string"}, "theme": {"type": "string"},
                "specialist_topic": {"type": "string"}, "notes": {"type": "string"},
            }
            purpose = "uma aula universitária de automação, portos e sistemas inteligentes"
        else:
            schema_properties = {
                "shortTitle": {"type": "string"}, "description": {"type": "string"},
                "ementa": {"type": "string"},
            }
            purpose = "uma disciplina universitária da Escola Politécnica da USP"
        schema = {
            "type": "object", "properties": schema_properties,
            "required": list(schema_properties), "additionalProperties": False,
        }
        prompt = (
            f"Preencha em português brasileiro os campos editoriais de {purpose}. "
            "Seja técnico, direto e fiel ao conteúdo fornecido; não invente nomes de pessoas, datas ou links. "
            f"Dados atuais: {json.dumps(current, ensure_ascii=False)}"
        )
        request_body = {
            "model": OPENAI_MODEL,
            "input": prompt,
            "store": False,
            "text": {"format": {"type": "json_schema", "name": "pea_fields", "strict": True, "schema": schema}},
        }
        request = Request(
            "https://api.openai.com/v1/responses",
            data=json.dumps(request_body).encode("utf-8"),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=45) as response:
                result = json.loads(response.read().decode("utf-8"))
            output_text = "".join(
                content.get("text", "")
                for item in result.get("output", []) if item.get("type") == "message"
                for content in item.get("content", []) if content.get("type") == "output_text"
            )
            fields = json.loads(output_text)
        except HTTPError as error:
            detail = ""
            try:
                detail = json.loads(error.read().decode("utf-8")).get("error", {}).get("message", "")
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass
            self.error_response(f"A OpenAI recusou a solicitação: {detail or error.reason}", 502)
            return
        except (URLError, TimeoutError, json.JSONDecodeError) as error:
            self.error_response(f"Não foi possível concluir o preenchimento com IA: {error}", 502)
            return
        self.json_response({"fields": fields, "model": result.get("model", OPENAI_MODEL)})

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
            deliverable_type_id = int(form.getfirst("deliverable_type_id", "0") or 0) or None
        except (TypeError, ValueError):
            destination.unlink(missing_ok=True)
            self.error_response("Aula ou artigo inválido.")
            return
        description = str(form.getfirst("description", ""))[:500]
        mime_type = file_field.type or mimetypes.guess_type(original_name)[0] or "application/octet-stream"
        with connect() as database:
            if not deliverable_type_id or not database.execute(
                "SELECT id FROM deliverable_types WHERE id = ? AND course_id = ? AND active = 1",
                (deliverable_type_id, student["course_id"]),
            ).fetchone():
                destination.unlink(missing_ok=True)
                self.error_response("Selecione um tipo de entrega cadastrado pela professora.")
                return
            if session_id:
                valid_session = database.execute(
                    "SELECT id, submission_deadline FROM class_sessions WHERE id = ? AND course_id = ?",
                    (session_id, student["course_id"]),
                ).fetchone()
                if not valid_session:
                    destination.unlink(missing_ok=True)
                    self.error_response("A aula selecionada não pertence a esta disciplina.")
                    return
                deadline = str(valid_session["submission_deadline"] or "")
                if deadline and deadline <= datetime.now(APP_TIMEZONE).strftime("%Y-%m-%dT%H:%M"):
                    destination.unlink(missing_ok=True)
                    self.error_response("O prazo de envio desta aula terminou.", 409)
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
                owns_article = database.execute(
                    """
                    SELECT 1 FROM presentation_reservations
                    WHERE article_id = ? AND student_id = ? AND kind = 'article'
                    """,
                    (article_id, student["id"]),
                ).fetchone()
                if not owns_article:
                    destination.unlink(missing_ok=True)
                    self.error_response("Somente o aluno que escolheu o artigo pode enviar sua resenha e apresentação.", 403)
                    return
            cursor = database.execute(
                """
                INSERT INTO uploads
                    (course_id, student_id, session_id, article_id, deliverable_type_id, filename, stored_name,
                     description, mime_type, size_bytes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    student["course_id"], student["id"], session_id, article_id, deliverable_type_id, original_name,
                    stored_name, description, mime_type, size,
                ),
            )
            upload = database.execute("SELECT * FROM uploads WHERE id = ?", (cursor.lastrowid,)).fetchone()
        self.json_response({"upload": dict(upload)}, 201)

    def log_message(self, message: str, *args) -> None:
        sys.stdout.write(f"[{self.log_date_time_string()}] {message % args}\n")


def main() -> None:
    initialize_database()
    host = os.environ.get(
        "APP_HOST", "0.0.0.0" if os.environ.get("RAILWAY_ENVIRONMENT_ID") else "127.0.0.1"
    )
    port = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else "4173"))
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
