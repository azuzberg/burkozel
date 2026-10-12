from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from burkozel.web import SavedGame, create_app
from burkozel import engine as rules


@pytest.fixture
def app(tmp_path):
    application = create_app({
        "TESTING": True,
        "SECRET_KEY": "test-only-secret",
        "DATABASE_URL": f"sqlite:///{tmp_path / 'test.sqlite3'}",
    })
    yield application
    application.extensions["burkozel_db"].dispose()


@pytest.fixture
def client(app):
    client = app.test_client()
    assert client.get("/").status_code == 200
    return client


def headers(client):
    with client.session_transaction() as session:
        return {"X-CSRF-Token": session["csrf"]}


def start(client):
    response = client.post("/api/game", json={
        "players": 3, "hand_size": 4, "overtrump": True, "dark": True,
    }, headers=headers(client))
    assert response.status_code == 200
    return response.json["game"]


def test_game_survives_reload_and_hides_opponents(client, app):
    game = start(client)
    assert len(game["players"][0]["hand"]) == 4
    assert all(p["hand"] == [] and p["hand_count"] == 4 for p in game["players"][1:])
    assert game["deck_count"] == 24
    assert client.get("/api/game").json["game"]["id"] == game["id"]
    assert not any(key.startswith("_") for key in game)
    # Actual hands and deck must remain available server-side after JSON storage.
    with Session(app.extensions["burkozel_db"]) as store:
        saved = store.scalar(select(SavedGame))
        assert saved and saved.state and saved.revision == 1


def test_sessions_are_isolated(client, app):
    first = start(client)
    stranger = app.test_client()
    stranger.get("/")
    assert stranger.get("/api/game").json == {"game": None}
    assert stranger.post("/api/action", json={"action": "pass", "revision": first["revision"]},
                         headers=headers(stranger)).status_code == 404
    stranger.delete("/api/game", json={"game_id": first["id"]}, headers=headers(stranger))
    assert client.get("/api/game").json["game"]["id"] == first["id"]


def test_csrf_and_settings_validation(client):
    assert client.post("/api/game", json={}).status_code == 403
    assert client.post("/api/game", json={"players": 5, "hand_size": 4,
                                        "dark": True, "overtrump": True},
                       headers=headers(client)).status_code == 400
    assert client.post("/api/game", json={"players": 2, "hand_size": 4,
                                        "dark": "false", "overtrump": True},
                       headers=headers(client)).status_code == 400
    assert client.get("/api/game").json["game"] is None


def test_illegal_move_does_not_change_saved_game(client):
    game = start(client)
    for data in [
        {"action": "play", "cards": ["nonexistent"]},
        {"action": "play", "cards": [123]},
        {"action": "pass"},
        {"action": "bot"},
        {"action": "next_round"},
        {"action": "unknown"},
    ]:
        response = client.post("/api/action", json={**data, "revision": 1, "game_id": game["id"]}, headers=headers(client))
        assert response.status_code == 400
        assert client.get("/api/game").json["game"]["revision"] == game["revision"]


def test_stale_revision_cannot_make_a_second_move(client):
    game = start(client)
    body = {"action": "play", "cards": [game["players"][0]["hand"][0]["id"]], "revision": 1, "game_id": game["id"]}
    assert client.post("/api/action", json=body, headers=headers(client)).status_code == 200
    response = client.post("/api/action", json=body, headers=headers(client))
    assert response.status_code == 409
    assert response.json["game"]["revision"] == 2
    assert response.json["game"]["events"] == []


def test_simultaneous_requests_commit_only_one_move(client, app):
    game = start(client)
    cookie = client.get_cookie("session").value
    csrf = headers(client)
    body = {"action": "play", "cards": [game["players"][0]["hand"][0]["id"]], "revision": 1, "game_id": game["id"]}

    def move():
        separate_client = app.test_client()
        separate_client.set_cookie("session", cookie)
        return separate_client.post("/api/action", json=body, headers=csrf).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: move(), range(2))) == [200, 409]
    assert client.get("/api/game").json["game"]["revision"] == 2


def test_database_and_session_survive_app_restart(client, app):
    game = start(client)
    cookie = client.get_cookie("session").value
    restarted = create_app({"TESTING": True, "SECRET_KEY": app.config["SECRET_KEY"],
                            "DATABASE_URL": app.config["DATABASE_URL"]})
    browser = restarted.test_client()
    browser.set_cookie("session", cookie)
    assert browser.get("/api/game").json["game"]["id"] == game["id"]
    restarted.extensions["burkozel_db"].dispose()


def test_new_game_replaces_only_own_game_and_delete_works(client):
    first = start(client)
    second = start(client)
    assert first["id"] != second["id"]
    assert client.post("/api/action", json={"action": "play", "revision": 1,
                                            "game_id": first["id"], "cards": []},
                       headers=headers(client)).status_code == 409
    assert client.delete("/api/game", json={"game_id": first["id"]}, headers=headers(client)).status_code == 409
    assert client.get("/api/game").json["game"]["id"] == second["id"]
    assert client.delete("/api/game", json={"game_id": second["id"]}, headers=headers(client)).json == {"game": None}
    assert client.get("/api/game").json == {"game": None}


def test_legacy_game_is_migrated_once_and_preserves_session(client, app):
    game = start(client)
    with Session(app.extensions["burkozel_db"]) as store:
        saved = store.scalar(select(SavedGame))
        old = dict(saved.state)
        old.pop("_rules_version", None)
        old.pop("_cycle_participants", None)
        saved.state = old
        store.commit()
    migrated = client.get("/api/game").json["game"]
    assert migrated["id"] == game["id"]
    assert migrated["revision"] == game["revision"] + 1
    assert migrated["deck_count"] == game["deck_count"]
    assert {c["id"] for c in migrated["players"][0]["hand"]} == {
        c["id"] for c in game["players"][0]["hand"]
    }
    assert client.get("/api/game").json["game"]["revision"] == migrated["revision"]
    old_action = {"action": "play", "cards": [game["players"][0]["hand"][0]["id"]],
                  "game_id": game["id"], "revision": game["revision"]}
    assert client.post("/api/action", json=old_action, headers=headers(client)).status_code == 409
    with Session(app.extensions["burkozel_db"]) as store:
        assert store.scalar(select(SavedGame)).state["_rules_version"] == 2


def test_second_cover_requires_bot_to_discard_through_http(client, app):
    game = start(client)
    state = rules.new_game({"players": 2, "hand_size": 4, "dark": True,
                            "overtrump": True}, seed=17)
    hands = [["clubs-K", "clubs-A", "diamonds-8", "diamonds-9"],
             ["clubs-10", "hearts-6", "hearts-7", "hearts-8"]]
    used = {card for hand in hands for card in hand}
    pool = [rules._card(suit, rank) for suit in rules.SUITS for rank in rules.RANKS]
    state["_deck"] = [card for card in pool if card["id"] not in used]
    state["deck_count"] = len(state["_deck"])
    state["open_trump"] = state["_deck"][-2]
    state["_hidden_trump_id"] = state["_deck"][-1]["id"]
    state["trump"] = state["open_trump"]["suit"]
    for player, hand in zip(state["players"], hands):
        player["hand"] = rules.sort_hand([card for card in pool if card["id"] in hand], state["trump"])
        player["hand_count"] = len(hand)
    state["events"] = []
    with Session(app.extensions["burkozel_db"]) as store:
        saved = store.scalar(select(SavedGame))
        saved.state = state
        store.commit()

    current = client.get("/api/game").json["game"]

    def move(action, cards=()):
        nonlocal current
        response = client.post("/api/action", json={"action": action, "cards": list(cards),
                               "game_id": current["id"], "revision": current["revision"]},
                               headers=headers(client))
        assert response.status_code == 200, response.json
        current = response.json["game"]

    move("play", ["clubs-K"])
    move("bot")
    assert current["phase"] == "cover" and current["turn"] == 0
    move("play", ["clubs-A"])
    assert current["phase"] == "reply" and current["turn"] == 1
    assert current["players"][1]["hand_count"] == 3
    move("bot")
    plays = [event for event in current["events"] if event["type"] == "play"]
    assert plays[0]["player"] == 1 and plays[0]["kind"] == "discard"
    assert plays[0]["cards"] == [{"hidden": True}]
    assert next(event["count"] for event in current["events"] if event["type"] == "collect") == 4
    assert [event["player"] for event in current["events"] if event["type"] == "draw"] == [0, 1, 0, 1]
