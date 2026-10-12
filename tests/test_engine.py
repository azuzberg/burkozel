import itertools
import json
from copy import deepcopy

import pytest

from burkozel.engine import (
    InvalidMove, POINTS, RANKS, SUITS, _finish_round, act, new_game,
    next_round, normalize_state, sort_hand, step_bot, view,
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
    assert game["phase"] == "reply" and game["turn"] == 1
    with pytest.raises(InvalidMove):
        act(game, "pass", player=1)
    act(game, "play", ["hearts-A"], player=1)
    assert len(game["players"][1]["hand"]) == 2
    assert game["phase"] == "lead" and game["turn"] == 0
    assert {item["id"] for item in game["_captured"][0]} == {
        "clubs-K", "clubs-10", "clubs-A", "hearts-A"}


def test_three_card_attack_cannot_be_recovered_with_one_card_left():
    game = position([
        ["clubs-6", "clubs-7", "clubs-8", "hearts-6"],
        ["clubs-9", "clubs-J", "clubs-Q", "hearts-7"],
    ], overtrump=True)
    act(game, "play", ["clubs-6", "clubs-7", "clubs-8"])
    act(game, "play", ["clubs-9", "clubs-J", "clubs-Q"], player=1)
    assert game["turn"] == 1 and game["phase"] == "lead"
    assert view(game)["legal"]["required_count"] == 0
    assert view(game)["legal"]["max_lead"] == 1
    assert len(game["_captured"][1]) == 6


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
    assert "spades-8" in {item["id"] for item in game["players"][0]["hand"]}
    assert "clubs-8" in {item["id"] for item in game["players"][1]["hand"]}
    assert game["trump"] == "clubs"
    assert game["open_trump"] is None and not game["hidden_trump"]
    assert game["deck_count"] == 0
    assert game["events"][-1] == {"type": "trump", "suit": "clubs"}
    assert [item["cards"][0]["id"] for item in draws if item["player"] == 0] == [
        "diamonds-6", "spades-8"]
    assert all("cards" not in item for item in draws if item["player"] != 0)
    assert all(player["hand"] == sort_hand(player["hand"], "clubs") for player in game["players"])


def test_drawing_skips_full_hands():
    game = position([
        ["clubs-K", "diamonds-6"],
        ["clubs-10", "hearts-6", "hearts-7", "hearts-8"],
        ["clubs-Q", "diamonds-8", "diamonds-9", "diamonds-J"],
    ], deck=["spades-6", "spades-7", "hearts-9", "spades-8", "spades-9"], overtrump=True)
    act(game, "play", ["clubs-K"])
    act(game, "play", ["clubs-10"], player=1)
    act(game, "play", ["clubs-Q"], player=2)
    act(game, "pass")
    draws = [event["player"] for event in game["events"] if event["type"] == "draw"]
    assert draws == [1, 2, 0, 0, 0]
    assert all(len(player["hand"]) == 4 for player in game["players"])


@pytest.mark.parametrize("players,count", itertools.product((2, 3, 4), (1, 2, 3)))
def test_second_cycle_requires_equal_payment_from_every_player(players, count):
    first = [f"clubs-{rank}" for rank in ("6", "7", "8")[:count]]
    cover = [f"spades-{rank}" for rank in ("6", "7", "8")[:count]]
    opening = [
        first,
        [f"clubs-{rank}" for rank in ("9", "J", "Q")[:count]],
        [f"hearts-{rank}" for rank in ("6", "7", "8")[:count]],
        [f"hearts-{rank}" for rank in ("9", "J", "Q")[:count]],
    ][:players]
    closing = [
        cover,
        [f"diamonds-{rank}" for rank in ("6", "7", "8")[:count]],
        [f"diamonds-{rank}" for rank in ("9", "J", "Q")[:count]],
        [f"hearts-{rank}" for rank in ("K", "10", "A")[:count]],
    ][:players]
    game = position([lead + reply for lead, reply in zip(opening, closing)],
                    overtrump=True, hand_size=6 if count == 3 else 4)
    for player, ids in enumerate(opening):
        act(game, "play", ids, player=player)
    assert game["phase"] == "cover" and game["turn"] == 0
    act(game, "play", closing[0])
    for player in range(1, players):
        assert game["phase"] == "reply" and game["turn"] == player
        assert game["_required_count"] == count
        assert not view(game)["legal"]["can_pass"]
        before = deepcopy(game)
        with pytest.raises(InvalidMove):
            act(game, "pass", player=player)
        assert game == before
        act(game, "play", closing[player], player=player)
    assert game["phase"] == "round_over"
    assert all(not player["hand"] for player in game["players"])
    plays = [event for event in game["events"] if event["type"] == "play"]
    assert len(plays) == players * 2
    assert all(sum(len(play["cards"]) for play in plays if play["player"] == index) == 2 * count
               for index in range(players))
    assert len(game["_captured"][0]) == 2 * players * count


def test_each_complete_cycle_can_offer_its_leader_another_cover():
    game = position([
        ["clubs-6", "clubs-9", "clubs-K"],
        ["clubs-7", "clubs-J", "clubs-10"],
        ["clubs-8", "clubs-Q", "clubs-A"],
    ], overtrump=True)
    for cards in (("clubs-6", "clubs-7", "clubs-8"),
                  ("clubs-9", "clubs-J", "clubs-Q"),
                  ("clubs-K", "clubs-10", "clubs-A")):
        for player, card_id in enumerate(cards):
            act(game, "play", [card_id], player=player)
        if cards[0] != "clubs-K":
            assert game["phase"] == "cover" and game["turn"] == 0
    assert game["phase"] == "round_over"
    assert len(game["_captured"][2]) == 9


def test_no_additional_cycle_if_one_original_participant_cannot_afford_it():
    game = position([
        ["clubs-6", "clubs-A", "clubs-K"],
        ["clubs-7", "hearts-6", "hearts-7"],
        ["clubs-8"],
    ], overtrump=True)
    act(game, "play", ["clubs-6"])
    act(game, "play", ["clubs-7"], player=1)
    act(game, "play", ["clubs-8"], player=2)
    assert game["phase"] == "lead" and game["turn"] == 0
    assert len(game["_captured"][2]) == 3
    assert [len(player["hand"]) for player in game["players"]] == [2, 2, 0]


def test_players_empty_before_the_trick_are_not_extra_cycle_participants():
    game = position([["clubs-K", "clubs-A"], ["clubs-10", "hearts-6"], []],
                    overtrump=True)
    act(game, "play", ["clubs-K"])
    act(game, "play", ["clubs-10"], player=1)
    assert game["_cycle_participants"] == [0, 1]
    act(game, "play", ["clubs-A"])
    assert game["phase"] == "reply" and game["turn"] == 1
    act(game, "play", ["hearts-6"], player=1)
    assert game["phase"] == "round_over"


@pytest.mark.parametrize("trump", SUITS)
@pytest.mark.parametrize("present", [SUITS, ("clubs", "spades", "hearts"),
                                     ("diamonds", "hearts"), ("clubs",), ()])
def test_hand_sort_groups_colours_sorts_ranks_and_places_trumps_last(trump, present):
    cards = [card(f"{suit}-{rank}") for rank in reversed(RANKS) for suit in present]
    original = deepcopy(cards)
    sorted_cards = sort_hand(cards, trump)
    assert cards == original
    assert {item["id"] for item in sorted_cards} == {item["id"] for item in cards}
    groups = [(suit, list(group)) for suit, group in itertools.groupby(sorted_cards, key=lambda item: item["suit"])]
    assert len(groups) == len(present)
    if trump in present:
        assert groups[-1][0] == trump
    for _, group in groups:
        assert [item["rank"] for item in group] == list(RANKS)
    nontrump_suits = [suit for suit, _ in groups if suit != trump]
    reds = sum(suit in ("diamonds", "hearts") for suit in nontrump_suits)
    blacks = len(nontrump_suits) - reds
    switches = sum((left in ("diamonds", "hearts")) != (right in ("diamonds", "hearts"))
                   for left, right in zip(nontrump_suits, nontrump_suits[1:]))
    assert switches == min(max(0, len(nontrump_suits) - 1), 2 * min(reds, blacks))
    all_suits = [suit for suit, _ in groups]
    reds = sum(suit in ("diamonds", "hearts") for suit in all_suits)
    blacks = len(all_suits) - reds
    switches = sum((left in ("diamonds", "hearts")) != (right in ("diamonds", "hearts"))
                   for left, right in zip(all_suits, all_suits[1:]))
    maximum = 2 * min(reds, blacks)
    if trump in present:
        ending_colour = reds if trump in ("diamonds", "hearts") else blacks
        other_colour = len(all_suits) - ending_colour
        if ending_colour <= other_colour:
            maximum -= 1
    assert switches == min(max(0, len(all_suits) - 1), maximum)


def test_colour_alternation_includes_the_last_trump_group():
    cards = [card("clubs-6"), card("diamonds-6"), card("hearts-6")]
    assert [item["suit"] for item in sort_hand(cards, "hearts")] == [
        "diamonds", "clubs", "hearts"]


def test_initial_sort_and_human_only_deal_events_retain_actual_dealing_order():
    game = new_game({"players": 4, "hand_size": 6}, seed=12)
    assert all(player["hand"] == sort_hand(player["hand"], game["trump"])
               for player in game["players"])
    events = view(game)["events"]
    assert all(len(event["cards"]) == event["count"] for event in events if event["player"] == 0)
    assert all("cards" not in event for event in events if event["player"] != 0)
    assert {event["cards"][0]["id"] for event in events if event["player"] == 0} == {
        item["id"] for item in game["players"][0]["hand"]}
    # Public sanitization also protects against a legacy event containing bot cards.
    game["events"] = [{"type": "draw", "player": 1, "count": 1, "cards": [card("hearts-A")]}]
    assert view(game)["events"] == [{"type": "draw", "player": 1, "count": 1}]


def test_legacy_cover_with_an_extra_beat_is_collected_without_losing_cards():
    hands = [["clubs-K", "clubs-A", "spades-6", "diamonds-6"],
             ["clubs-10", "hearts-6", "hearts-7", "diamonds-7"]]
    used = {item for hand in hands for item in hand}
    deck = [f"{suit}-{rank}" for suit in SUITS for rank in RANKS
            if f"{suit}-{rank}" not in used and f"{suit}-{rank}" not in ("spades-9", "hearts-9")]
    deck += ["spades-9", "hearts-9"]
    game = position(hands, deck=deck, overtrump=True)
    game["players"][0]["penalty"] = 4
    act(game, "play", ["clubs-K"])
    act(game, "play", ["clubs-10"], player=1)
    act(game, "play", ["clubs-A"])
    game.update(phase="cover", turn=1, _remaining_replies=[])
    del game["_rules_version"]
    del game["_cycle_participants"]
    assert_cards_conserved(game)
    assert normalize_state(game)
    assert_cards_conserved(game)
    assert game["phase"] == "lead" and game["turn"] == 0
    assert [player["penalty"] for player in game["players"]] == [4, 0]
    assert {item["id"] for item in game["_captured"][0]} == {"clubs-K", "clubs-10", "clubs-A"}
    assert game["events"][0]["type"] == "rules_updated"
    assert game["_rules_version"] == 2
    before = deepcopy(game)
    assert not normalize_state(game)
    assert game == before


def test_legacy_first_reply_restores_participants_and_finishes_the_initial_cycle():
    game = position([
        ["clubs-6", "clubs-A"], ["clubs-7", "hearts-6"],
        ["clubs-8", "hearts-7"],
    ], overtrump=True)
    act(game, "play", ["clubs-6"])
    act(game, "play", ["clubs-7"], player=1)
    del game["_rules_version"]
    del game["_cycle_participants"]
    assert normalize_state(game)
    assert game["_cycle_participants"] == [0, 1, 2]
    assert game["_remaining_replies"] == [2]
    act(game, "play", ["clubs-8"], player=2)
    assert game["phase"] == "cover" and game["turn"] == 0
    act(game, "play", ["clubs-A"])
    assert game["_remaining_replies"] == [1, 2]


@pytest.mark.parametrize("phase", ["lead", "round_over", "match_over"])
def test_other_legacy_phases_keep_all_cards_and_penalties(phase):
    game = new_game({"players": 3}, seed=31)
    game["phase"] = phase
    game["players"][0]["penalty"] = 8
    del game["_rules_version"]
    del game["_cycle_participants"]
    assert normalize_state(game)
    assert game["phase"] == phase and game["players"][0]["penalty"] == 8
    assert_cards_conserved(game)


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
