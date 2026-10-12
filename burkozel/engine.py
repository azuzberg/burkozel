"""Server-authoritative rules for a 36-card game of Burkozel.

The state contains only JSON values so it can be saved in SQLite unchanged.
Use :func:`view` for browser responses: the stored state contains secret cards.
"""

from __future__ import annotations

from copy import deepcopy
from itertools import combinations, permutations
import random
import secrets
from typing import Any


SUITS = ("clubs", "diamonds", "hearts", "spades")
RANKS = ("6", "7", "8", "9", "J", "Q", "K", "10", "A")
POINTS = {"6": 0, "7": 0, "8": 0, "9": 0, "J": 2, "Q": 3,
          "K": 4, "10": 10, "A": 11}
STRENGTH = {rank: index for index, rank in enumerate(RANKS)}
SUIT_ORDER = ("clubs", "diamonds", "spades", "hearts")
RED_SUITS = {"diamonds", "hearts"}


class InvalidMove(ValueError):
    """A request that cannot be applied to the current game."""


def _card(suit: str, rank: str) -> dict[str, Any]:
    return {"id": f"{suit}-{rank}", "suit": suit, "rank": rank,
            "points": POINTS[rank]}


def sort_hand(cards: list[dict], trump: str) -> list[dict]:
    """Group suits with alternating colours where possible and trumps last."""
    present = [suit for suit in SUIT_ORDER if suit != trump
               and any(card["suit"] == suit for card in cards)]
    has_trump = any(card["suit"] == trump for card in cards)

    def order_key(suits: tuple[str, ...]) -> tuple:
        sequence = (*suits, trump) if has_trump else suits
        switches = sum((left in RED_SUITS) != (right in RED_SUITS)
                       for left, right in zip(sequence, sequence[1:]))
        return -switches, tuple(SUIT_ORDER.index(suit) for suit in suits)

    order = min(permutations(present), key=order_key)
    positions = {suit: index for index, suit in enumerate((*order, trump))}
    return sorted(cards, key=lambda card: (positions[card["suit"]], STRENGTH[card["rank"]]))


def _sort_hands(game: dict) -> None:
    for player in game["players"]:
        player["hand"] = sort_hand(player["hand"], game["trump"])


def new_game(settings: dict[str, Any], seed: int | str | None = None) -> dict:
    """Create a match and deal its first round, beginning with the human."""
    options = {"players": 2, "hand_size": 4, "dark": True,
               "overtrump": True}
    options.update({key: settings[key] for key in options if key in settings})
    if type(options["players"]) is not int or options["players"] not in (2, 3, 4):
        raise InvalidMove("Выберите 2, 3 или 4 игроков.")
    if type(options["hand_size"]) is not int or options["hand_size"] not in (4, 6):
        raise InvalidMove("Выберите 4 или 6 карт в руке.")
    if any(type(options[key]) is not bool for key in ("dark", "overtrump")):
        raise InvalidMove("Настройки сброса и перекрытия должны быть логическими.")
    game = {
        "settings": options,
        "round": 1,
        "players": [
            {"id": index, "name": "Вы" if index == 0 else f"Бот {index}",
             "is_bot": index != 0, "hand": [], "hand_count": 0,
             "round_points": 0, "penalty": 0, "tricks_count": 0}
            for index in range(options["players"])
        ],
        "events": [],
        "_rules_version": 2,
        "_seed": str(secrets.randbits(128) if seed is None else seed),
        "_last_trick_winner": 0,
    }
    _deal_round(game, 0)
    return game


def _deal_round(game: dict, leader: int) -> None:
    deck = [_card(suit, rank) for suit in SUITS for rank in RANKS]
    random.Random(f"{game['_seed']}:{game['round']}").shuffle(deck)
    game.update({"phase": "lead", "turn": leader, "winner": None,
                 "table": [], "table_cards": [], "result": None,
                 "_deck": deck, "_captured": [[] for _ in game["players"]],
                 "_leader": leader, "_required_count": 0, "_cycle_participants": [],
                 "_remaining_replies": []})
    for player in game["players"]:
        player.update(hand=[], hand_count=0, round_points=0, tricks_count=0)
    for _ in range(game["settings"]["hand_size"]):
        for offset in range(len(game["players"])):
            index = (leader + offset) % len(game["players"])
            card = deck.pop(0)
            game["players"][index]["hand"].append(card)
            event = {"type": "deal", "player": index, "count": 1}
            if index == 0:
                event["cards"] = [deepcopy(card)]
            game["events"].append(event)
    game["open_trump"] = deepcopy(deck[-2])
    game["_hidden_trump_id"] = deck[-1]["id"]
    game["hidden_trump"] = True
    game["trump"] = game["open_trump"]["suit"]
    _sort_hands(game)
    _sync_counts(game)


def normalize_state(game: dict) -> bool:
    """Upgrade a saved version-one game without resetting its cards or match.

    An old optional-cover sequence may already have spent unequal numbers of
    cards. Award that existing trick normally rather than inventing partial
    responses. An initial mandatory round can continue under the new rules.
    The caller must persist changes and increment its optimistic revision.
    """
    if game.get("_rules_version") == 2:
        return False
    game["_rules_version"] = 2
    game["_cycle_participants"] = []
    if game["phase"] == "reply":
        leader = game["table"][0]["player"]
        members = {play["player"] for play in game["table"]}
        members.update(game["_remaining_replies"])
        game["_leader"] = leader
        game["_cycle_participants"] = [
            (leader + offset) % len(game["players"])
            for offset in range(len(game["players"]))
            if (leader + offset) % len(game["players"]) in members]
    elif game["phase"] == "cover":
        game["events"] = [{"type": "rules_updated"}]
        _collect_and_draw(game)
    _sort_hands(game)
    _sync_counts(game)
    return True


def _sync_counts(game: dict) -> None:
    game["deck_count"] = len(game["_deck"])
    for player in game["players"]:
        player["hand_count"] = len(player["hand"])


def _max_lead(game: dict) -> int:
    sizes = [len(player["hand"]) for player in game["players"] if player["hand"]]
    return min(3, min(sizes)) if sizes else 0


def _has_bura(game: dict, player: int) -> bool:
    hand = game["players"][player]["hand"]
    return (game["phase"] == "lead"
            and len(hand) == game["settings"]["hand_size"]
            and all(card["suit"] == game["trump"] for card in hand))


def _beats(card: dict, target: dict, trump: str) -> bool:
    if card["suit"] == target["suit"]:
        return STRENGTH[card["rank"]] > STRENGTH[target["rank"]]
    return card["suit"] == trump and target["suit"] != trump


def _covering_order(cards: list[dict], targets: list[dict], trump: str) -> list | None:
    """Find a perfect matching; clicking cards in another order is equivalent."""
    if len(cards) != len(targets):
        return None

    def match(remaining: list[dict], index: int) -> list | None:
        if index == len(targets):
            return []
        for position, card in enumerate(remaining):
            if _beats(card, targets[index], trump):
                tail = match(remaining[:position] + remaining[position + 1:], index + 1)
                if tail is not None:
                    return [card, *tail]
        return None

    return match(cards, 0)


def _selected(game: dict, player: int, card_ids: list[str] | None) -> list[dict]:
    if not isinstance(card_ids, (list, tuple)) or not card_ids:
        raise InvalidMove("Выберите карты.")
    if any(not isinstance(card_id, str) for card_id in card_ids):
        raise InvalidMove("Неверный идентификатор карты.")
    if len(set(card_ids)) != len(card_ids):
        raise InvalidMove("Одну карту нельзя выбрать дважды.")
    hand = {card["id"]: card for card in game["players"][player]["hand"]}
    if any(card_id not in hand for card_id in card_ids):
        raise InvalidMove("Выбранной карты нет в вашей руке.")
    return [hand[card_id] for card_id in card_ids]


def _place(game: dict, player: int, cards: list[dict], kind: str) -> None:
    ids = {card["id"] for card in cards}
    game["players"][player]["hand"] = [
        card for card in game["players"][player]["hand"] if card["id"] not in ids]
    play = {"player": player, "cards": cards, "kind": kind,
            "face_down": kind == "discard" and game["settings"]["dark"]}
    game["table"].append(play)
    game["events"].append({"type": "play", **deepcopy(play)})
    if kind in ("lead", "beat"):
        game["winner"] = player
        game["table_cards"] = list(cards)
    _sync_counts(game)


def act(game: dict, action: str, card_ids: list[str] | None = None,
        player: int = 0) -> None:
    """Apply one human or bot action, rejecting invalid requests atomically."""
    if type(player) is not int or not 0 <= player < len(game["players"]):
        raise InvalidMove("Неизвестный игрок.")
    if action == "bura":
        if not _has_bura(game, player):
            raise InvalidMove("Буру можно объявить только перед заходом со всеми козырями.")
        _place(game, player, list(game["players"][player]["hand"]), "lead")
        _collect_cards(game)
        _finish_round(game, bura_player=player)
        return
    if game["phase"] not in ("lead", "reply", "cover"):
        raise InvalidMove("Эта раздача уже завершена.")
    if game["turn"] != player:
        raise InvalidMove("Сейчас ход другого игрока.")
    if action == "pass":
        if game["phase"] != "cover":
            raise InvalidMove("Отказаться можно только от дополнительного перекрытия.")
        _collect_and_draw(game)
        return
    if action != "play":
        raise InvalidMove("Неизвестное действие.")
    cards = _selected(game, player, card_ids)
    if game["phase"] == "lead":
        if not 1 <= len(cards) <= _max_lead(game):
            raise InvalidMove("Для захода выберите от одной до трёх карт с учётом остатка рук.")
        if len({card["suit"] for card in cards}) != 1:
            raise InvalidMove("Карты захода должны быть одной масти.")
        game["_leader"] = player
        game["_required_count"] = len(cards)
        game["_cycle_participants"] = [
            (player + offset) % len(game["players"])
            for offset in range(len(game["players"]))
            if game["players"][(player + offset) % len(game["players"])]["hand"]]
        _place(game, player, cards, "lead")
        game["_remaining_replies"] = game["_cycle_participants"][1:]
        if game["_remaining_replies"]:
            game["phase"] = "reply"
            game["turn"] = game["_remaining_replies"][0]
        else:
            _collect_and_draw(game)
        return
    if len(cards) != game["_required_count"]:
        raise InvalidMove(f"Выберите ровно {game['_required_count']} карт.")
    ordered = _covering_order(cards, game["table_cards"], game["trump"])
    if game["phase"] == "cover":
        if ordered is None:
            raise InvalidMove("Для перекрытия нужно побить все верхние карты или отказаться.")
        _place(game, player, ordered, "beat")
        game["_leader"] = player
        participants = game["_cycle_participants"]
        first = participants.index(player)
        game["_remaining_replies"] = participants[first + 1:] + participants[:first]
        game["phase"] = "reply"
        game["turn"] = game["_remaining_replies"][0]
        return
    _place(game, player, ordered if ordered is not None else cards,
           "beat" if ordered is not None else "discard")
    game["_remaining_replies"].pop(0)
    if game["_remaining_replies"]:
        game["turn"] = game["_remaining_replies"][0]
    else:
        _finish_cycle(game)


def _finish_cycle(game: dict) -> None:
    """A further cycle must be affordable by every original participant."""
    count = game["_required_count"]
    if (not game["settings"]["overtrump"] or game["winner"] == game["_leader"]
            or any(len(game["players"][index]["hand"]) < count
                   for index in game["_cycle_participants"])):
        _collect_and_draw(game)
        return
    game["phase"] = "cover"
    game["turn"] = game["_leader"]


def _collect_cards(game: dict) -> int:
    winner = game["winner"]
    cards = [card for play in game["table"] for card in play["cards"]]
    game["_captured"][winner].extend(cards)
    game["players"][winner]["round_points"] += sum(card["points"] for card in cards)
    game["players"][winner]["tricks_count"] += 1
    game["_last_trick_winner"] = winner
    game["events"].append({"type": "collect", "player": winner, "count": len(cards)})
    game["table"] = []
    game["table_cards"] = []
    game["_remaining_replies"] = []
    game["_cycle_participants"] = []
    game["_required_count"] = 0
    return winner


def _collect_and_draw(game: dict) -> None:
    winner = _collect_cards(game)
    size = game["settings"]["hand_size"]
    while game["_deck"] and any(len(player["hand"]) < size for player in game["players"]):
        for offset in range(len(game["players"])):
            index = (winner + offset) % len(game["players"])
            if game["_deck"] and len(game["players"][index]["hand"]) < size:
                card = game["_deck"].pop(0)
                game["players"][index]["hand"].append(card)
                event = {"type": "draw", "player": index, "count": 1}
                if index == 0:
                    event["cards"] = [deepcopy(card)]
                game["events"].append(event)
                if game["open_trump"] and card["id"] == game["open_trump"]["id"]:
                    game["open_trump"] = None
                if card["id"] == game["_hidden_trump_id"]:
                    game["hidden_trump"] = False
                    game["trump"] = card["suit"]
                    game["events"].append({"type": "trump", "suit": card["suit"]})
                    _sort_hands(game)
                else:
                    game["players"][index]["hand"] = sort_hand(
                        game["players"][index]["hand"], game["trump"])
    _sync_counts(game)
    if not any(player["hand"] for player in game["players"]):
        _finish_round(game)
        return
    game["phase"] = "lead"
    game["winner"] = None
    game["turn"] = next((winner + offset) % len(game["players"])
                        for offset in range(len(game["players"]))
                        if game["players"][(winner + offset) % len(game["players"])]["hand"])
    game["_leader"] = game["turn"]


def _finish_round(game: dict, bura_player: int | None = None) -> None:
    points = [player["round_points"] for player in game["players"]]
    maximum = max(points)
    penalties = [(0 if index == bura_player else 6) if bura_player is not None
                 else (0 if total == maximum else 6 if total == 0 else 2 if total >= 31 else 4)
                 for index, total in enumerate(points)]
    for player, penalty in zip(game["players"], penalties):
        player["penalty"] += penalty
    losers = [player["id"] for player in game["players"] if player["penalty"] >= 12]
    game["phase"] = "match_over" if losers else "round_over"
    game["turn"] = None
    game["result"] = {"reason": "bura" if bura_player is not None else "cards_finished",
                      "bura_player": bura_player, "round_points": points,
                      "penalties": penalties, "losers": losers}
    game["events"].append({"type": "round_end", "result": deepcopy(game["result"])})


def next_round(game: dict) -> None:
    if game["phase"] != "round_over":
        raise InvalidMove("Новая раздача доступна только после завершённой раздачи.")
    game["round"] += 1
    _deal_round(game, game["_last_trick_winner"])


def _best_cover(game: dict, player: int) -> list | None:
    count = game["_required_count"]
    hand = game["players"][player]["hand"]
    candidates = []
    for cards in combinations(hand, count):
        ordered = _covering_order(list(cards), game["table_cards"], game["trump"])
        if ordered is not None:
            cost = sum(card["points"] + STRENGTH[card["rank"]] / 10
                       + (5 if card["suit"] == game["trump"] else 0) for card in cards)
            candidates.append((cost, ordered))
    return min(candidates, key=lambda candidate: candidate[0])[1] if candidates else None


def step_bot(game: dict) -> None:
    """Perform exactly one bot action; animation pacing is the caller's job."""
    index = game["turn"]
    if (game["phase"] not in ("lead", "reply", "cover") or index is None
            or not game["players"][index]["is_bot"]):
        return
    if game["phase"] == "lead":
        for offset in range(len(game["players"])):
            candidate = (index + offset) % len(game["players"])
            if game["players"][candidate]["is_bot"] and _has_bura(game, candidate):
                act(game, "bura", player=candidate)
                return
        groups = []
        for suit in SUITS:
            cards = [card for card in game["players"][index]["hand"] if card["suit"] == suit]
            if cards:
                cards.sort(key=lambda card: STRENGTH[card["rank"]], reverse=True)
                cards = cards[:_max_lead(game)]
                value = len(cards) * 10 + sum(STRENGTH[card["rank"]] for card in cards) / 10
                value -= 4 if suit == game["trump"] else 0
                groups.append((value, cards))
        cards = max(groups, key=lambda group: group[0])[1]
    else:
        cards = _best_cover(game, index)
        if cards is None and game["phase"] == "cover":
            act(game, "pass", player=index)
            return
        if cards is None:
            hand = sorted(game["players"][index]["hand"], key=lambda card:
                          card["points"] + STRENGTH[card["rank"]] / 10
                          + (20 if card["suit"] == game["trump"] else 0))
            cards = hand[:game["_required_count"]]
    act(game, "play", [card["id"] for card in cards], player=index)


def _public_play(play: dict) -> dict:
    public = deepcopy(play)
    if public.get("face_down"):
        public["cards"] = [{"hidden": True} for _ in public["cards"]]
    return public


def _public_event(event: dict) -> dict:
    if event["type"] == "play":
        return _public_play(event)
    public = deepcopy(event)
    if event["type"] in ("deal", "draw") and event["player"] != 0:
        public.pop("cards", None)
    return public


def view(game: dict) -> dict:
    """Return a detached browser-safe snapshot, including masked events."""
    public = {key: deepcopy(game[key]) for key in (
        "settings", "phase", "turn", "round", "trump", "deck_count",
        "open_trump", "hidden_trump", "table_cards", "winner", "result")}
    public["players"] = [
        {**deepcopy(player), "hand": deepcopy(player["hand"]) if player["id"] == 0 else []}
        for player in game["players"]]
    public["table"] = [_public_play(play) for play in game["table"]]
    public["events"] = [_public_event(event) for event in game["events"]]
    human_turn = game["turn"] == 0
    count = game["_required_count"]
    can_play = (human_turn and game["phase"] in ("lead", "reply", "cover")
                and bool(game["players"][0]["hand"]))
    if game["phase"] == "cover" and can_play:
        can_play = _best_cover(game, 0) is not None
    public["legal"] = {"can_play": bool(can_play),
                       "can_pass": human_turn and game["phase"] == "cover",
                       "can_bura": _has_bura(game, 0),
                       "required_count": count,
                       "max_lead": _max_lead(game) if game["phase"] == "lead" else 0}
    return public
