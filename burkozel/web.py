"""Flask transport and SQLite persistence. Rules live in engine.py."""

from __future__ import annotations

import copy
import os
import secrets
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from flask import Flask, jsonify, render_template, request, session
from sqlalchemy import JSON, DateTime, Integer, String, create_engine, delete, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from . import engine as rules


class Base(DeclarativeBase):
    pass


class SavedGame(Base):
    __tablename__ = "games"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    state: Mapped[dict] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


def _local_secret(instance: Path) -> str:
    """Keep sessions valid across restarts without embedding a key in source."""
    location = instance / ".secret_key"
    if not location.exists():
        # Publish a complete file atomically: simultaneously starting workers
        # must never read the other worker's partially written key.
        with tempfile.NamedTemporaryFile(mode="w", dir=instance, delete=False) as output:
            temporary = Path(output.name)
            output.write(secrets.token_hex(32))
            output.flush()
            os.fsync(output.fileno())
        try:
            try:
                os.link(temporary, location)
            except FileExistsError:
                pass
        finally:
            temporary.unlink()
    key = location.read_text().strip()
    if not key:
        raise RuntimeError("instance/.secret_key is empty; restore the session key from backup.")
    return key


def create_app(config: dict | None = None) -> Flask:
    root = Path(__file__).resolve().parent.parent
    app = Flask(__name__, template_folder=str(root / "templates"),
                static_folder=str(root / "static"), instance_path=str(root / "instance"))
    instance = Path(app.instance_path)
    instance.mkdir(exist_ok=True)
    app.config.update(
        SECRET_KEY=os.environ.get("BURKOZEL_SECRET_KEY") or _local_secret(instance),
        DATABASE_URL=os.environ.get("BURKOZEL_DATABASE_URL", f"sqlite:///{instance / 'burkozel.sqlite3'}"),
        MAX_CONTENT_LENGTH=16 * 1024,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("BURKOZEL_HTTPS") == "1",
    )
    if config:
        app.config.update(config)
    url = app.config["DATABASE_URL"]
    db = create_engine(url, connect_args={"timeout": 15} if url.startswith("sqlite:") else {})
    with db.begin() as connection:
        if db.dialect.name == "sqlite":
            connection.exec_driver_sql("BEGIN IMMEDIATE")
        Base.metadata.create_all(connection)
    app.extensions["burkozel_db"] = db

    def owner() -> str:
        if "owner" not in session:
            session["owner"] = secrets.token_hex(24)
        return session["owner"]

    def public(saved: SavedGame) -> dict:
        return {**rules.view(saved.state), "id": saved.id, "revision": saved.revision}

    @app.after_request
    def headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
            "base-uri 'self'; form-action 'self'"
        )
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.before_request
    def csrf():
        if request.path.startswith("/api/") and request.method in {"POST", "DELETE"}:
            token = session.get("csrf", "")
            received = request.headers.get("X-CSRF-Token", "")
            if not token or not secrets.compare_digest(token.encode(), received.encode()):
                return jsonify(error="Сессия устарела. Обновите страницу."), 403

    @app.get("/")
    def index():
        owner()
        if "csrf" not in session:
            session["csrf"] = secrets.token_hex(24)
        return render_template("index.html", csrf_token=session["csrf"])

    @app.get("/api/game")
    def get_game():
        with Session(db) as store:
            saved = store.scalar(select(SavedGame).where(SavedGame.owner == owner()))
            return jsonify(game=public(saved) if saved else None)

    def payload() -> dict:
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            raise rules.InvalidMove("Ожидается JSON-объект.")
        return value

    def mutation(callback):
        # SQLite needs a write lock before reading a game, preventing double moves
        # from simultaneous clicks or separate tabs. Revision checks catch old UI.
        with db.connect() as connection:
            if db.dialect.name == "sqlite":
                connection.exec_driver_sql("BEGIN IMMEDIATE")
            else:
                connection.begin()
            with Session(bind=connection, expire_on_commit=False) as store:
                try:
                    result = callback(store)
                    store.flush()
                    connection.commit()
                    return result
                except rules.InvalidMove as error:
                    connection.rollback()
                    return jsonify(error=str(error)), 400
                except Exception:
                    connection.rollback()
                    raise

    @app.post("/api/game")
    def start_game():
        def start(store):
            data = payload()
            settings = data.get("settings", data)
            if not isinstance(settings, dict):
                raise rules.InvalidMove("Некорректные настройки игры.")
            if type(settings.get("players")) is not int or settings["players"] not in (2, 3, 4):
                raise rules.InvalidMove("Выберите 2, 3 или 4 игроков.")
            if type(settings.get("hand_size")) is not int or settings["hand_size"] not in (4, 6):
                raise rules.InvalidMove("Выберите 4 или 6 карт.")
            if type(settings.get("dark")) is not bool or type(settings.get("overtrump")) is not bool:
                raise rules.InvalidMove("Выберите оба варианта правил.")
            settings = {key: settings[key] for key in ("players", "hand_size", "dark", "overtrump")}
            game = rules.new_game(settings)
            store.execute(delete(SavedGame).where(SavedGame.owner == owner()))
            now = datetime.now(timezone.utc)
            saved = SavedGame(id=str(uuid4()), owner=owner(), state=game, revision=1,
                              created_at=now, updated_at=now)
            store.add(saved)
            store.flush()
            return jsonify(game=public(saved))
        return mutation(start)

    @app.post("/api/action")
    def action():
        def apply(store):
            data = payload()
            saved = store.scalar(select(SavedGame).where(SavedGame.owner == owner()).with_for_update())
            if not saved:
                return jsonify(error="Сначала начните игру.", game=None), 404
            if (data.get("game_id") != saved.id or type(data.get("revision")) is not int
                    or data["revision"] != saved.revision):
                current = public(saved)
                current["events"] = []
                return jsonify(error="Игра обновилась. Повторите действие.", game=current), 409
            state = copy.deepcopy(saved.state)
            state["events"] = []
            move = data.get("action")
            if move == "bot":
                if state.get("turn") == 0 or state.get("phase") not in ("lead", "reply", "cover"):
                    raise rules.InvalidMove("Сейчас не ход бота.")
                rules.step_bot(state)
            elif move == "next_round":
                rules.next_round(state)
            elif move in ("play", "pass", "bura"):
                cards = data.get("cards", [])
                if not isinstance(cards, list) or len(cards) > 6 or any(not isinstance(c, str) for c in cards):
                    raise rules.InvalidMove("Некорректный список карт.")
                rules.act(state, move, cards, player=0)
            else:
                raise rules.InvalidMove("Неизвестное действие.")
            saved.state = state
            saved.revision += 1
            saved.updated_at = datetime.now(timezone.utc)
            store.flush()
            return jsonify(game=public(saved))
        return mutation(apply)

    @app.delete("/api/game")
    def abandon():
        def remove(store):
            data = payload()
            saved = store.scalar(select(SavedGame).where(SavedGame.owner == owner()).with_for_update())
            if saved and data.get("game_id") != saved.id:
                current = public(saved)
                current["events"] = []
                return jsonify(error="В другой вкладке уже началась новая игра.", game=current), 409
            store.execute(delete(SavedGame).where(SavedGame.owner == owner()))
            return jsonify(game=None)
        return mutation(remove)

    @app.errorhandler(413)
    def too_large(_error):
        return jsonify(error="Запрос слишком большой."), 413

    return app
