import itertools
import json
from copy import deepcopy

import pytest

from burkozel.engine import (
    InvalidMove, POINTS, RANKS, SUITS, _finish_round, act, new_game,
    next_round, step_bot, view,
)


def card(card_id):
    suit, rank = card_id.split("-")
    return {"id": card_id, "suit": suit, "rank": rank, "points": POINTS[rank]}


def position(hands, *, deck=(), trump="spades", overtrump=False,
             dark=True, hand_size=4):
    """A small, explicit position for testing a particular rule."""
    game = new_game({"players": len(hands), "hand_size": hand_size,
                     "dark": dark, "overtrump": overtrump}, seed=1)
    for player, hand in zip(game["players"], hands):
        player.update(hand=[card(value) for value in hand], hand_count=len(hand),
                      round_points=0, tricks_count=0)
    game.update(_deck=[card(value) for value in deck], deck_count=len(deck),
                _captured=[[] for _ in hands], trump=trump, events=[],
                open_trump=card(deck[-2]) if len(deck) >= 2 else None,
                hidden_trump=len(deck) >= 2,
                _hidden_trump_id=deck[-1] if deck else "")
    return game


def assert_cards_conserved(game):
    cards = [*game["_deck"],
             *(item for player in game["players"] for item in player["hand"]),
             *(item for play in game["table"] for item in play["cards"]),
             *(item for pile in game["_captured"] for item in pile)]
    expected = {f"{suit}-{rank}" for suit in SUITS for rank in RANKS}
    assert len(cards) == 36
    assert {item["id"] for item in cards} == expected
    assert sum(item["points"] for item in cards) == 120
    assert game["deck_count"] == len(game["_deck"])
    assert all(player["hand_count"] == len(player["hand"]) for player in game["players"])


@pytest.mark.parametrize("players,hand_size", itertools.product((2, 3, 4), (4, 6)))
def test_initial_deal_is_one_card_per_player_per_circuit(players, hand_size):
    game = new_game({"players": players, "hand_size": hand_size}, seed=123)
    assert game["phase"] == "lead" and game["turn"] == 0
    assert [event["player"] for event in game["events"]] == list(range(players)) * hand_size
    assert all(event["count"] == 1 for event in game["events"])
    assert game["deck_count"] == 36 - players * hand_size
    assert game["open_trump"] == game["_deck"][-2]
    assert game["trump"] == game["_deck"][-2]["suit"]
    assert game["hidden_trump"]
    assert_cards_conserved(game)


@pytest.mark.parametrize("setting,value", [
    ("players", 1), ("players", True), ("hand_size", 5),
    ("dark", "yes"), ("overtrump", 1),
])
def test_invalid_settings(setting, value):
    with pytest.raises(InvalidMove):
        new_game({setting: value})


@pytest.mark.parametrize("lead,response,trump,expected", [
    ("clubs-K", "clubs-10", "spades", "beat"),
    ("clubs-10", "clubs-A", "spades", "beat"),
    ("clubs-10", "clubs-K", "spades", "discard"),
    ("clubs-A", "spades-6", "spades", "beat"),
    ("spades-6", "clubs-A", "spades", "discard"),
    ("clubs-6", "hearts-A", "spades", "discard"),
])
def test_rank_and_trump_rules(lead, response, trump, expected):
    game = position([[lead, "diamonds-6"], [response, "diamonds-7"]], trump=trump)
    act(game, "play", [lead])
    act(game, "play", [response], player=1)
    play = [event for event in game["events"] if event["type"] == "play"][-1]
    assert play["kind"] == expected
    assert game["turn"] == (1 if expected == "beat" else 0)


def test_covering_a_mixed_winning_set_does_not_depend_on_click_order():
    game = position([
        ["clubs-9", "clubs-K", "diamonds-6", "diamonds-7"],
        ["clubs-10", "spades-6", "hearts-6", "hearts-7"],
        ["spades-7", "clubs-A", "diamonds-8", "diamonds-9"],
    ])
    act(game, "play", ["clubs-9", "clubs-K"])
    act(game, "play", ["clubs-10", "spades-6"], player=1)
    assert game["winner"] == 1
    act(game, "play", ["spades-7", "clubs-A"], player=2)
    assert game["turn"] == 2
    last_play = [event for event in game["events"] if event["type"] == "play"][-1]
    assert [item["id"] for item in last_play["cards"]] == ["clubs-A", "spades-7"]
    assert len(game["_captured"][2]) == 6


def test_partial_cover_is_a_complete_discard():
    game = position([
        ["clubs-K", "clubs-Q", "diamonds-6", "diamonds-7"],
        ["clubs-A", "clubs-6", "hearts-6", "hearts-7"],
    ])
    act(game, "play", ["clubs-K", "clubs-Q"])
    act(game, "play", ["clubs-A", "clubs-6"], player=1)
    plays = [event for event in game["events"] if event["type"] == "play"]
    assert plays[-1]["kind"] == "discard"
    assert game["turn"] == 0
    assert len(game["_captured"][0]) == 4


@pytest.mark.parametrize("action,ids,player", [
    ("play", ["clubs-6"], 1),
    ("play", ["clubs-6", "hearts-6"], 0),
    ("play", ["clubs-6", "clubs-6"], 0),
    ("play", ["clubs-A"], 0),
    ("play", [], 0),
    ("pass", None, 0),
    ("bura", None, 0),
    ("invalid", None, 0),
    ("play", ["clubs-6"], -1),
])
def test_invalid_moves_do_not_change_state(action, ids, player):
    game = position([
        ["clubs-6", "hearts-6", "diamonds-6", "spades-6"],
        ["clubs-7", "hearts-7", "diamonds-7", "spades-7"],
    ])
    before = deepcopy(game)
    with pytest.raises(InvalidMove):
        act(game, action, ids, player=player)
    assert game == before


def test_mandatory_reply_requires_the_same_number_of_cards_and_cannot_pass():
    game = position([
        ["clubs-6", "clubs-7", "diamonds-6", "diamonds-7"],
        ["clubs-8", "clubs-9", "hearts-6", "hearts-7"],
    ])
    act(game, "play", ["clubs-6", "clubs-7"])
    before = deepcopy(game)
    with pytest.raises(InvalidMove):
        act(game, "play", ["clubs-8"], player=1)
    with pytest.raises(InvalidMove):
        act(game, "pass", player=1)
    assert game == before


def test_additional_cover_can_continue_back_around_the_table():
    game = position([
        ["clubs-K", "clubs-A", "clubs-6", "hearts-6"],
        ["clubs-10", "hearts-A", "hearts-K", "diamonds-6"],
    ], overtrump=True)
    act(game, "play", ["clubs-K"])
    act(game, "play", ["clubs-10"], player=1)
    assert game["phase"] == "cover" and game["turn"] == 0
    act(game, "play", ["clubs-A"])
    assert game["phase"] == "cover" and game["turn"] == 1
    before_hand = deepcopy(game["players"][1]["hand"])
    act(game, "pass", player=1)
    assert game["players"][1]["hand"] == before_hand
    assert game["phase"] == "lead" and game["turn"] == 0
    assert {item["id"] for item in game["_captured"][0]} == {"clubs-K", "clubs-10", "clubs-A"}


def test_three_card_attack_cannot_be_recovered_with_one_card_left():
    game = position([
        ["clubs-6", "clubs-7", "clubs-8", "hearts-6"],
        ["clubs-9", "clubs-J", "clubs-Q", "hearts-7"],
    ], overtrump=True)
    act(game, "play", ["clubs-6", "clubs-7", "clubs-8"])
    act(game, "play", ["clubs-9", "clubs-J", "clubs-Q"], player=1)
    assert view(game)["legal"] == {
        "can_play": False, "can_pass": True, "can_bura": False,
        "required_count": 3, "max_lead": 0,
    }
    with pytest.raises(InvalidMove):
        act(game, "play", ["hearts-6"])
    act(game, "pass")
    assert game["turn"] == 1 and game["phase"] == "lead"


def test_invalid_additional_cover_is_rejected_without_consuming_cards():
    game = position([
        ["clubs-K", "hearts-6"], ["clubs-10", "hearts-7"],
    ], overtrump=True)
    act(game, "play", ["clubs-K"])
    act(game, "play", ["clubs-10"], player=1)
    before = deepcopy(game)
    with pytest.raises(InvalidMove):
        act(game, "play", ["hearts-6"])
    assert game == before


def test_shortest_remaining_hand_limits_the_next_lead_and_empty_hands_are_skipped():
    game = position([["clubs-6"], ["clubs-7", "hearts-6"]], overtrump=True)
    assert view(game)["legal"]["max_lead"] == 1
    act(game, "play", ["clubs-6"])
    act(game, "play", ["clubs-7"], player=1)
    assert game["turn"] == 1 and game["phase"] == "lead"
    act(game, "play", ["hearts-6"], player=1)
    assert game["phase"] == "round_over"


def test_draw_is_one_card_at_a_time_from_the_winner_and_last_card_changes_trump():
    game = position([
        ["clubs-6", "clubs-7", "diamonds-K", "diamonds-A"],
        ["hearts-6", "hearts-7", "diamonds-8", "diamonds-9"],
    ], deck=["diamonds-6", "hearts-8", "spades-8", "clubs-8"])
    act(game, "play", ["clubs-6", "clubs-7"])
    act(game, "play", ["hearts-6", "hearts-7"], player=1)
    draws = [event for event in game["events"] if event["type"] == "draw"]
    assert [event["player"] for event in draws] == [0, 1, 0, 1]
    assert all(event["count"] == 1 for event in draws)
    assert game["players"][0]["hand"][-1]["id"] == "spades-8"
    assert game["players"][1]["hand"][-1]["id"] == "clubs-8"
    assert game["trump"] == "clubs"
    assert game["open_trump"] is None and not game["hidden_trump"]
    assert game["deck_count"] == 0
    assert game["events"][-1] == {"type": "trump", "suit": "clubs"}


def test_drawing_skips_full_hands():
    game = position([
        ["clubs-K", "clubs-A", "diamonds-6", "diamonds-7"],
        ["clubs-10", "hearts-6", "hearts-7", "hearts-8"],
        ["clubs-Q", "diamonds-8", "diamonds-9", "diamonds-J"],
    ], deck=["spades-6", "spades-7", "spades-8", "spades-9"], overtrump=True)
    act(game, "play", ["clubs-K"])
    act(game, "play", ["clubs-10"], player=1)
    act(game, "play", ["clubs-Q"], player=2)
    act(game, "play", ["clubs-A"])
    act(game, "pass", player=1)
    act(game, "pass", player=2)
    draws = [event["player"] for event in game["events"] if event["type"] == "draw"]
    assert draws == [0, 1, 2, 0]
    assert all(len(player["hand"]) == 4 for player in game["players"])


@pytest.mark.parametrize("points,expected", [
    ([89, 31], [0, 2]), ([90, 30], [0, 4]), ([120, 0], [0, 6]),
    ([60, 60], [0, 0]), ([60, 30, 30], [0, 4, 4]),
    ([40, 40, 40], [0, 0, 0]), ([60, 31, 29, 0], [0, 2, 4, 6]),
])
def test_round_scoring_including_31_points_and_tied_maxima(points, expected):
    game = new_game({"players": len(points)}, seed=3)
    for player, total in zip(game["players"], points):
        player["round_points"] = total
    _finish_round(game)
    assert game["result"]["penalties"] == expected
    assert [player["penalty"] for player in game["players"]] == expected
    assert game["phase"] == "round_over"


def test_match_ends_as_soon_as_a_player_reaches_12_penalty_points():
    game = new_game({"players": 4}, seed=3)
    for player, total in zip(game["players"], [60, 31, 29, 0]):
        player["round_points"] = total
        player["penalty"] = 10
    _finish_round(game)
    assert game["phase"] == "match_over" and game["turn"] is None
    assert game["result"]["losers"] == [1, 2, 3]
    with pytest.raises(InvalidMove):
        next_round(game)


@pytest.mark.parametrize("hand_size", [4, 6])
def test_bura_can_be_declared_out_of_turn_before_the_lead(hand_size):
    trumps = [f"spades-{rank}" for rank in RANKS[:hand_size]]
    game = position([
        [f"clubs-{rank}" for rank in RANKS[:hand_size]], trumps,
    ], hand_size=hand_size)
    act(game, "bura", player=1)
    assert game["phase"] == "round_over"
    assert game["result"]["reason"] == "bura"
    assert game["result"]["bura_player"] == 1
    assert game["result"]["penalties"] == [6, 0]
    assert len(game["_captured"][1]) == hand_size


def test_bura_must_have_a_full_hand_and_be_declared_before_any_lead():
    game = position([
        ["clubs-6", "clubs-7", "clubs-8", "clubs-9"],
        ["spades-6", "spades-7", "spades-8", "spades-9"],
    ])
    act(game, "play", ["clubs-6"])
    with pytest.raises(InvalidMove):
        act(game, "bura", player=1)
    short = position([["spades-6", "spades-7", "spades-8"], ["clubs-6"]])
    assert not view(short)["legal"]["can_bura"]
    with pytest.raises(InvalidMove):
        act(short, "bura")


def test_next_round_preserves_penalties_and_uses_last_trick_winner():
    game = new_game({"players": 3}, seed=6)
    for player, total in zip(game["players"], [80, 31, 9]):
        player["round_points"] = total
    game["_last_trick_winner"] = 2
    _finish_round(game)
    game["events"] = []
    next_round(game)
    assert game["round"] == 2 and game["turn"] == 2
    assert [player["penalty"] for player in game["players"]] == [0, 2, 4]
    assert all(player["round_points"] == 0 for player in game["players"])
    assert game["result"] is None
    assert_cards_conserved(game)


@pytest.mark.parametrize("dark", [False, True])
def test_public_view_hides_bot_hands_deck_and_dark_discards(dark):
    game = position([
        ["clubs-K", "clubs-6"], ["hearts-A", "diamonds-6"],
        ["clubs-A", "diamonds-7"],
    ], dark=dark)
    act(game, "play", ["clubs-K"])
    act(game, "play", ["hearts-A"], player=1)
    public = view(game)
    assert public["players"][0]["hand"] == [card("clubs-6")]
    assert all(player["hand"] == [] for player in public["players"][1:])
    assert not any(key.startswith("_") for key in public)
    assert "diamonds-6" not in json.dumps(public)
    assert ("hearts-A" in json.dumps(public)) is (not dark)
    if dark:
        assert public["table"][-1]["cards"] == [{"hidden": True}]
        assert public["events"][-1]["cards"] == [{"hidden": True}]
    public["players"][0]["hand"].clear()
    assert game["players"][0]["hand"]


def test_bot_step_is_noop_on_human_turn_and_performs_only_one_move():
    game = new_game({"players": 4}, seed=12)
    before = deepcopy(game)
    step_bot(game)
    assert game == before
    act(game, "play", [game["players"][0]["hand"][0]["id"]])
    game["events"] = []
    step_bot(game)
    assert len([event for event in game["events"] if event["type"] == "play"]) == 1
    assert game["turn"] == 2


SETTINGS = [dict(players=players, hand_size=size, dark=dark, overtrump=cover)
            for players, size, dark, cover in itertools.product((2, 3, 4), (4, 6),
                                                               (False, True), (False, True))]


@pytest.mark.parametrize("settings", SETTINGS)
@pytest.mark.parametrize("seed", [0, 17, 89])
def test_complete_matches_conserve_cards_and_terminate_for_every_configuration(settings, seed):
    game = new_game(settings, seed=seed)
    steps = 0
    while game["phase"] != "match_over":
        assert_cards_conserved(game)
        game["events"] = []
        if game["phase"] == "round_over":
            assert sum(player["round_points"] for player in game["players"]) == 120
            next_round(game)
        elif game["turn"] != 0:
            step_bot(game)
        else:
            public = view(game)
            if public["legal"]["can_bura"]:
                act(game, "bura")
            elif public["legal"]["can_pass"]:
                act(game, "pass")
            else:
                count = public["legal"]["required_count"] or 1
                act(game, "play", [item["id"] for item in game["players"][0]["hand"][:count]])
        # SQLite JSON persistence must not change the next permissible action.
        game = json.loads(json.dumps(game))
        steps += 1
        assert steps < 3000
    assert_cards_conserved(game)
    assert game["result"]["losers"]
    assert all(game["players"][index]["penalty"] >= 12 for index in game["result"]["losers"])
