/* A small, server-authoritative client. All rules and bot moves live in Python. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const suits = { clubs: "♣", diamonds: "♦", hearts: "♥", spades: "♠" };
  const suitNames = {
    clubs: "трефы",
    diamonds: "бубны",
    hearts: "червы",
    spades: "пики",
  };
  const rankNames = { A: "туз", K: "король", Q: "дама", J: "валет" };
  const rankLabels = { A: "A", K: "К", Q: "Д", J: "В" };
  const icons = ["♣", "♠", "♦", "♥"];
  const activePhases = ["lead", "reply", "cover"];
  const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
  const animator = window.CardAnimator ? new window.CardAnimator() : null;
  let game = null;
  let screen = "lobby";
  let selected = new Set();
  let busy = false;
  let botTimer = null;
  let toastTimer = null;
  let lastEventRevision = -1;
  let declinedBuraHand = "";
  let resultKey = "";
  let botError = false;
  let requestEpoch = 0;

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  }

  function isRed(suit) {
    return suit === "hearts" || suit === "diamonds";
  }
  function plural(number, forms) {
    return forms[
      number % 100 >= 11 && number % 100 <= 14
        ? 2
        : number % 10 === 1
          ? 0
          : number % 10 >= 2 && number % 10 <= 4
            ? 1
            : 2
    ];
  }
  function handSignature() {
    return (
      game?.players[0].hand
        .map((card) => card.id)
        .sort()
        .join("|") || ""
    );
  }
  function buraPending() {
    return (
      game?.legal.can_bura &&
      game.turn !== 0 &&
      handSignature() !== declinedBuraHand
    );
  }
  function cardName(card) {
    return `${rankNames[card.rank] || card.rank}, ${suitNames[card.suit]}`;
  }

  function royalArt(rank, symbol) {
    const crown =
      rank === "K"
        ? '<path d="M10 15 10 6 16 11 24 4 32 11 38 6 38 15Z" fill="#c9a65b" stroke="#243e4b" stroke-width=".7"/><path d="M12 13H36M17 10V15M24 8V15M31 10V15" stroke="#fff9e4" stroke-width=".7"/>'
        : rank === "Q"
          ? '<path d="M10 17 13 7 18 12 24 5 30 12 35 7 38 17Z" fill="#c9a65b" stroke="#243e4b" stroke-width=".7"/><circle cx="24" cy="11" r="1.5" fill="#b12e37"/>'
          : '<path d="M9 15Q13 6 29 7L39 15 36 18H11Z" fill="#b12e37" stroke="#243e4b" stroke-width=".7"/><path d="M14 13 31 10 35 13 13 17Z" fill="#c9a65b"/>';
    const hair =
      rank === "Q"
        ? '<path d="M13 16Q8 23 12 34L18 31 16 20H31L30 31 36 34Q40 23 35 16Z" fill="#c9a65b" stroke="#243e4b" stroke-width=".6"/>'
        : '<path d="M13 17 12 27 17 26V20H32V26L36 27 35 17Z" fill="#c9a65b" stroke="#243e4b" stroke-width=".6"/>';
    const beard =
      rank === "K"
        ? '<path d="M17 26 20 32 25 35 31 30 33 25 28 29 23 30Z" fill="#c9a65b" stroke="#243e4b" stroke-width=".6"/>'
        : "";
    const figure = `${hair}${crown}<path d="M17 18H31L32 26 28 31H21L17 27Z" fill="#f4e7ca" stroke="#243e4b" stroke-width=".65"/><path d="M20 22H23M28 22H30M25 21 24 26H27M22 28H28" fill="none" stroke="#243e4b" stroke-width=".65"/>${beard}<path d="M16 31 8 35V43H40V35L32 31 25 37Z" fill="#b12e37" stroke="#243e4b" stroke-width=".6"/><path d="M9 35 16 33 21 43H9ZM39 35 32 33 27 43H39Z" fill="#244459"/><path d="M13 35 17 43M10 37 13 43M35 35 31 43M38 37 35 43" stroke="#c9a65b" stroke-width="1.2"/><path d="M16 32 24 39 32 32M23 37V44M26 37V44" fill="none" stroke="#c9a65b" stroke-width="1.3"/><circle cx="24.5" cy="40" r="1.1" fill="#fff8df"/>`;
    return `<svg class="royal-art" viewBox="0 0 48 76" aria-hidden="true"><rect x="1" y="1" width="46" height="74" rx="1" fill="#fbf5e7" stroke="currentColor" stroke-width=".8"/><rect x="3" y="3" width="42" height="70" fill="none" stroke="#c9a65b" stroke-width=".45"/><g>${figure}</g><g transform="translate(48 76) rotate(180)">${figure}</g><path d="M7 37H41" stroke="#c9a65b" stroke-width="1.2"/><circle cx="24" cy="38" r="7" fill="#fbf5e7" stroke="#c9a65b" stroke-width=".8"/><text x="24" y="42" text-anchor="middle" font-family="Georgia,serif" font-size="14" fill="currentColor">${symbol}</text></svg>`;
  }

  function cardInterior(card) {
    const symbol = suits[card.suit];
    const rank = rankLabels[card.rank] || card.rank;
    const corners = `<span class="card-corner">${rank}<span class="suit-small">${symbol}</span></span><span class="card-corner corner-bottom">${rank}<span class="suit-small">${symbol}</span></span>`;
    let middle;
    if (["K", "Q", "J"].includes(card.rank))
      middle = `<span class="card-main">${royalArt(card.rank, symbol)}</span>`;
    else if (card.rank === "A")
      middle = `<span class="card-main"><span class="ace-symbol">${symbol}</span></span>`;
    else {
      const count = Number(card.rank);
      const rows = count >= 9 ? [22, 41, 59, 78] : [27, 50, 73];
      const positions = rows.flatMap((y) => [
        [34, y],
        [66, y],
      ]);
      if (count === 7) positions.push([50, 38]);
      if (count === 8) positions.push([50, 38], [50, 62]);
      if (count === 9) positions.push([50, 50]);
      if (count === 10) positions.push([50, 31], [50, 69]);
      middle = `<span class="card-pips count-${count}">${positions.map(([x, y]) => `<span class="${y > 50 ? "pip-upside" : ""}" style="left:${x}%;top:${y}%">${symbol}</span>`).join("")}</span>`;
    }
    return corners + middle;
  }

  function backHtml(attributes = "") {
    return `<div class="card card-back" ${attributes}><svg viewBox="0 0 100 140" aria-hidden="true"><use href="#red-back"/></svg></div>`;
  }

  function cardHtml(card, options = {}) {
    const attrs = options.attributes || "";
    if (!card || card.hidden || options.faceDown) return backHtml(attrs);
    const color = isRed(card.suit) ? "red" : "";
    const face = ["K", "Q", "J"].includes(card.rank) ? "card-face" : "";
    return `<div class="card ${color} ${face}" data-card-id="${escapeHtml(card.id)}" ${attrs} aria-label="${escapeHtml(cardName(card))}">${cardInterior(card)}</div>`;
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => {
      $("toast").hidden = true;
    }, 4400);
  }

  function showScreen(next, options = {}) {
    clearTimeout(botTimer);
    screen = next;
    document.body.classList.toggle("is-playing", next === "game");
    ["lobby", "settings", "game"].forEach((name) => {
      $(`${name}-screen`).hidden = name !== next;
    });
    $("continue-game").hidden = !game;
    if (next === "game" && game && options.render !== false) {
      renderGame();
      showResult();
      scheduleBot();
    }
    document.title =
      next === "game"
        ? `Раздача ${game?.round || 1} — Буркозёл`
        : "Буркозёл — карточный клуб";
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function playerHeading(player) {
    const turn = game.turn === player.id && activePhases.includes(game.phase);
    return `<div class="player-heading ${turn ? "is-turn" : ""}" data-player-pile="${player.id}"><span class="player-avatar">${icons[player.id]}</span><span class="player-name">${escapeHtml(player.name)}</span><span class="player-penalty" title="Штрафы: при 12 очках проигрыш">${player.penalty}<small>/12</small></span><span class="player-points" title="Очки во взятках"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="8" height="11" rx="1.5"/><path d="M11 5h2v9H5v-1"/></svg>${player.round_points}</span></div>`;
  }

  function renderOpponents() {
    const players = game.players.slice(1);
    $("opponents").classList.toggle("one-opponent", players.length === 1);
    $("opponents").classList.toggle("three-opponents", players.length === 3);
    $("opponents").innerHTML = players
      .map((player) => {
        const cards = Array.from({ length: player.hand_count }, (_, index) =>
          backHtml(
            `data-hand-player="${player.id}" data-hand-index="${index}" style="--rotation:${(index - (player.hand_count - 1) / 2) * 6}deg"`,
          ),
        ).join("");
        return `<div class="opponent" data-player="${player.id}">${playerHeading(player)}<div class="opponent-hand" data-player-hand="${player.id}">${cards}</div></div>`;
      })
      .join("");
  }

  function renderDeck() {
    let html = game.deck_count
      ? `<div class="deck-cards">${backHtml('data-deck-layer="bottom"')}${backHtml('data-deck-layer="middle"')}${backHtml('id="deck-card" data-deck')}</div>`
      : '<div class="empty-deck" id="deck-card" data-deck aria-label="Колода закончилась"></div>';
    if (game.hidden_trump)
      html += `<div class="hidden-trump-card" title="Скрытый козырь">${backHtml()}</div>`;
    if (game.open_trump)
      html += `<div class="open-trump">${cardHtml(game.open_trump)}</div>`;
    html += `<div class="deck-caption"><span class="deck-count" title="Осталось карт в колоде">${game.deck_count}</span><span class="trump-symbol ${isRed(game.trump) ? "red" : ""}" title="Козырь: ${suitNames[game.trump]}">${suits[game.trump]}</span></div>`;
    $("deck-area").innerHTML = html;
  }

  function renderTable() {
    const table = game.table;
    if (!table.length) {
      $("table-cards").replaceChildren();
      return;
    }
    const lastBeat = table.map((entry) => entry.kind).lastIndexOf("beat");
    const topIndex = lastBeat >= 0 ? lastBeat : 0;
    let beatDepth = 0,
      discardDepth = 0;
    $("table-cards").innerHTML = table
      .map((entry, index) => {
        const discard = entry.kind === "discard";
        if (entry.kind === "beat") beatDepth++;
        if (discard) discardDepth++;
        const depth = discard ? discardDepth : beatDepth;
        const offsetX = discard ? -18 - depth * 4 : depth * 8;
        const offsetY = discard ? 17 + depth * 4 : -depth * 5;
        const cards = entry.cards
          .map((card, position) =>
            cardHtml(card, {
              faceDown: entry.face_down,
              attributes: `data-table-player="${entry.player}" style="--rotation:${(position - (entry.cards.length - 1) / 2) * 3}deg"`,
            }),
          )
          .join("");
        return `<div class="table-entry kind-${entry.kind} ${index !== topIndex ? "obscured" : ""}" data-entry-index="${index}" style="margin-left:${offsetX}px;top:${offsetY}px;z-index:${discard ? index + 1 : 50 + index}"><span class="table-entry-label">${escapeHtml(game.players[entry.player].name)}</span>${cards}</div>`;
      })
      .join("");
  }

  function renderHand() {
    const hand = game.players[0].hand;
    selected = new Set(
      [...selected].filter((id) => hand.some((card) => card.id === id)),
    );
    $("human-player").innerHTML = playerHeading(game.players[0]);
    $("human-hand").classList.toggle(
      "six-cards",
      game.settings.hand_size === 6,
    );
    $("human-hand").innerHTML = hand.length
      ? hand
          .map((card, index) => {
            const chosen = selected.has(card.id);
            const rotation = (index - (hand.length - 1) / 2) * 4;
            const lift = Math.round(
              Math.abs(index - (hand.length - 1) / 2) * 2.5,
            );
            const face = ["K", "Q", "J"].includes(card.rank) ? "card-face" : "";
            return `<button class="card hand-card ${isRed(card.suit) ? "red" : ""} ${face} ${chosen ? "selected" : ""} ${card.suit === game.trump ? "is-trump" : ""}" data-card-id="${escapeHtml(card.id)}" data-hand-player="0" data-hand-index="${index}" style="--rotation:${rotation}deg;--lift:${lift}px;--card-order:${index + 1}" aria-label="${escapeHtml(cardName(card))}${card.suit === game.trump ? ", козырь" : ""}" aria-pressed="${chosen}" ${busy || !game.legal.can_play ? "disabled" : ""}><span class="card-interior">${cardInterior(card)}</span></button>`;
          })
          .join("")
      : '<div class="empty-hand">Все карты сыграны</div>';
  }

  function selectionDescription() {
    const cards = game.players[0].hand.filter((card) => selected.has(card.id));
    if (!cards.length) return null;
    if (game.phase === "lead") {
      if (cards.length > game.legal.max_lead)
        return `Для захода можно выбрать до ${game.legal.max_lead} карт.`;
      if (new Set(cards.map((card) => card.suit)).size > 1)
        return "Для захода нужны карты одной масти.";
      return `${cards.length === 1 ? "Одна карта" : `${cards.length} карты`} для нового захода.`;
    }
    if (cards.length !== game.legal.required_count)
      return `Нужно выбрать ровно ${game.legal.required_count} ${game.legal.required_count === 1 ? "карту" : "карты"}.`;
    return game.phase === "cover"
      ? "Перекройте все верхние карты или откажитесь."
      : "Подходящие карты перекроют; остальные уйдут в сброс.";
  }

  function updateControls() {
    if (!game) return;
    const legal = game.legal;
    const active = activePhases.includes(game.phase);
    $("selection-count").textContent = selected.size;
    $("play-cards").disabled = busy || !legal.can_play || selected.size === 0;
    $("pass-turn").hidden = !legal.can_pass;
    $("pass-turn").disabled = busy;
    $("declare-bura").hidden = !legal.can_bura;
    $("declare-bura").disabled = busy;
    $("declare-bura").classList.toggle("bura-glow", legal.can_bura && !busy);
    $("resume-bots").hidden = !buraPending() && !botError;
    $("resume-bots").disabled = busy;
    $("resume-bots").textContent = botError
      ? "Повторить ход →"
      : "Продолжить без буры →";
    let hint;
    if (!active) hint = "";
    else if (busy) hint = "";
    else if (buraPending()) hint = "Все карты — козыри. У вас бура!";
    else if (game.turn !== 0)
      hint = `${game.players[game.turn]?.name || "Соперник"} ходит…`;
    else if (game.phase === "lead")
      hint =
        legal.max_lead === 1
          ? "Ваш ход · выберите одну карту"
          : `Ваш ход · 1–${legal.max_lead} карты одной масти`;
    else if (game.phase === "cover")
      hint = `Перекройте ${legal.required_count} ${legal.required_count === 1 ? "карту" : "карты"} или откажитесь`;
    else
      hint = `Ваш ответ · ${legal.required_count} ${legal.required_count === 1 ? "карта" : "карты"}`;
    $("turn-description").textContent =
      !busy && game.turn === 0 && selected.size ? selectionDescription() : hint;
  }

  function renderGame() {
    if (!game) return;
    renderOpponents();
    renderDeck();
    renderTable();
    renderHand();
    updateControls();
  }

  function renderAnimationState(state) {
    const finalState = game;
    game = state;
    renderGame();
    game = finalState;
  }

  async function playEvents(previous, next, events) {
    if (animator && screen === "game") {
      await animator.play({
        previous,
        next,
        events,
        render: renderAnimationState,
      });
    } else {
      renderGame();
    }
  }

  window.BurkozelCards = { cardHtml, backHtml };

  async function api(method, path, body) {
    let response;
    try {
      response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(
        "Не удалось связаться со столом. Проверьте подключение и попробуйте ещё раз.",
      );
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("Сервер не смог ответить. Попробуйте ещё раз.");
    }
    if (!response.ok) {
      const error = new Error(data.error || "Не удалось выполнить ход.");
      if ("game" in data) error.game = data.game;
      throw error;
    }
    return data;
  }

  async function applyMutation(request) {
    if (busy) return;
    clearTimeout(botTimer);
    const oldGame = game;
    busy = true;
    requestEpoch++;
    botError = false;
    updateControls();
    $("human-hand")
      .querySelectorAll("button")
      .forEach((node) => {
        node.disabled = true;
      });
    try {
      const data = await request();
      game = data.game;
      selected.clear();
      const events = game.revision !== lastEventRevision ? game.events : [];
      lastEventRevision = game.revision;
      await playEvents(oldGame, game, events);
      showResult();
    } catch (error) {
      if (error.game !== undefined) {
        game = error.game;
        selected.clear();
        if (game) {
          lastEventRevision = game.revision;
          renderGame();
          showResult();
        } else showScreen("lobby");
      }
      toast(error.message);
      if (
        game &&
        game.turn !== 0 &&
        activePhases.includes(game.phase) &&
        error.game === undefined
      )
        botError = true;
    } finally {
      busy = false;
      if (game) {
        renderHand();
        updateControls();
      }
      $("continue-game").hidden = !game;
      scheduleBot();
    }
  }

  function act(action, cards = []) {
    if (!game || busy) return;
    return applyMutation(() =>
      api("POST", "/api/action", {
        action,
        cards,
        revision: game.revision,
        game_id: game.id,
      }),
    );
  }

  function scheduleBot() {
    clearTimeout(botTimer);
    if (
      !game ||
      busy ||
      document.hidden ||
      screen !== "game" ||
      game.turn === 0 ||
      !activePhases.includes(game.phase) ||
      buraPending() ||
      botError ||
      document.querySelector("dialog[open]")
    )
      return;
    botTimer = setTimeout(() => {
      act("bot");
    }, 850);
  }

  function showResult() {
    if (
      !game ||
      !["round_over", "match_over"].includes(game.phase) ||
      screen !== "game"
    )
      return;
    const key = `${game.id}:${game.round}:${game.phase}`;
    if (key === resultKey && $("result-dialog").open) return;
    resultKey = key;
    const finished = game.phase === "match_over";
    const result = game.result;
    const lost = result.losers || [];
    const humanLost = lost.includes(0);
    const bura =
      result.bura_player !== null && result.bura_player !== undefined;
    const highest = Math.max(...result.round_points);
    const leaderNames = game.players
      .filter((player) => player.round_points === highest)
      .map((player) => player.name);
    const title = finished
      ? humanLost
        ? "В следующий раз!"
        : "Хорошо сыграно!"
      : bura
        ? "Бура за столом!"
        : "Раздача сыграна.";
    const description = finished
      ? humanLost
        ? `Вы набрали ${game.players[0].penalty} штрафных очков. Пора попробовать новую стратегию.`
        : "Вы остались ниже 12 штрафных очков и выиграли эту игру."
      : bura
        ? `${game.players[result.bura_player].name === "Вы" ? "Вы объявили" : `${game.players[result.bura_player].name} объявил`} буру: все карты в руке — козыри.`
        : `${leaderNames.join(" и ")} ${leaderNames.length > 1 ? "набрали" : leaderNames[0] === "Вы" ? "набрали" : "набрал"} больше всего очков во взятках: ${highest}.`;
    const rows = game.players
      .map(
        (player, index) =>
          `<tr class="${player.id === 0 ? "score-human" : ""}"><td class="score-name ${lost.includes(player.id) ? "score-lost" : ""}">${escapeHtml(player.name)}${lost.includes(player.id) ? " · проигрыш" : ""}</td><td>${result.round_points[index]}</td><td><span class="penalty-add">+${result.penalties[index]}</span><strong class="${lost.includes(player.id) ? "score-lost" : ""}">${player.penalty}</strong></td></tr>`,
      )
      .join("");
    $("result-content").innerHTML =
      `<div class="result-symbol">${finished ? (humanLost ? "♧" : "♠") : bura ? "♣" : "♦"}</div><div class="eyebrow">${finished ? "ИТОГИ ИГРЫ" : `РАЗДАЧА ${game.round} · ИТОГИ`}</div><h2>${title}</h2><p class="result-subtitle">${escapeHtml(description)}</p><table class="score-table"><thead><tr><th>Игрок</th><th>Во взятках</th><th>Штрафы / 12</th></tr></thead><tbody>${rows}</tbody></table><button class="button button-dark" id="result-primary">${finished ? "Ещё одну партию" : "Следующая раздача"} <span>→</span></button><button class="text-button result-bottom-link" id="result-to-lobby">Вернуться в лобби</button>`;
    $("result-primary").onclick = async () => {
      $("result-dialog").close();
      if (finished) {
        $("new-game-dialog").showModal();
      } else await act("next_round");
    };
    $("result-to-lobby").onclick = () => {
      $("result-dialog").close();
      showScreen("lobby");
    };
    if (!$("result-dialog").open) $("result-dialog").showModal();
  }

  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const settings = {
      players: Number(form.get("players")),
      hand_size: Number(form.get("hand_size")),
      overtrump: form.get("overtrump") === "true",
      dark: form.get("dark") === "true",
    };
    busy = true;
    requestEpoch++;
    $("start-game").disabled = true;
    const oldLabel = $("start-game").innerHTML;
    $("start-game").textContent = "Готовим стол…";
    try {
      const data = await api("POST", "/api/game", settings);
      game = data.game;
      selected.clear();
      declinedBuraHand = "";
      resultKey = "";
      botError = false;
      showScreen("game", { render: false });
      lastEventRevision = game.revision;
      await playEvents(null, game, game.events);
    } catch (error) {
      toast(error.message);
    } finally {
      busy = false;
      $("start-game").disabled = false;
      $("start-game").innerHTML = oldLabel;
      if (game) {
        renderHand();
        updateControls();
        scheduleBot();
      }
    }
  });

  $("human-hand").addEventListener("click", (event) => {
    const card = event.target.closest("button[data-card-id]");
    if (!card || busy || !game.legal.can_play) return;
    const id = card.dataset.cardId;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    card.classList.toggle("selected", selected.has(id));
    card.setAttribute("aria-pressed", String(selected.has(id)));
    updateControls();
  });
  $("play-cards").onclick = () => {
    act("play", [...selected]);
  };
  $("pass-turn").onclick = () => {
    act("pass");
  };
  $("declare-bura").onclick = () => {
    act("bura");
  };
  $("resume-bots").onclick = () => {
    declinedBuraHand = handSignature();
    botError = false;
    updateControls();
    scheduleBot();
  };
  $("open-settings").onclick = () => {
    if (game) $("new-game-dialog").showModal();
    else showScreen("settings");
  };
  $("settings-back").onclick = () => {
    showScreen("lobby");
  };
  $("continue-game").onclick = () => {
    showScreen("game");
  };
  $("game-lobby").onclick = () => {
    if (!busy) {
      $("table-menu").close();
      showScreen("lobby");
    }
  };
  $("brand-home").onclick = (event) => {
    event.preventDefault();
    if (!busy) showScreen("lobby");
  };
  $("new-game").onclick = () => {
    if (!busy) {
      $("table-menu").close();
      $("new-game-dialog").showModal();
    }
  };
  $("multiplayer-placeholder").onclick = () => {
    toast("Мультиплеер появится позже. А пока боты готовы составить компанию.");
  };
  document.querySelectorAll(".rules-toggle").forEach((button) => {
    button.onclick = () => {
      $("table-menu").close();
      clearTimeout(botTimer);
      $("rules-dialog").showModal();
    };
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.onclick = () => {
      button.closest("dialog").close();
    };
  });
  $("table-menu-toggle").onclick = () => {
    clearTimeout(botTimer);
    $("table-menu").showModal();
  };
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("close", scheduleBot);
    dialog.addEventListener("click", (event) => {
      const bounds = dialog.getBoundingClientRect();
      if (
        event.target === dialog &&
        (event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom)
      )
        dialog.close();
    });
  });
  $("confirm-new-game").onclick = async () => {
    if (busy) return;
    busy = true;
    requestEpoch++;
    $("confirm-new-game").disabled = true;
    clearTimeout(botTimer);
    try {
      await api("DELETE", "/api/game", { game_id: game?.id });
      game = null;
      selected.clear();
      resultKey = "";
      declinedBuraHand = "";
      $("new-game-dialog").close();
      showScreen("settings");
    } catch (error) {
      if (error.game !== undefined) {
        game = error.game;
        selected.clear();
        if (game) {
          lastEventRevision = game.revision;
          if (screen === "game") renderGame();
        } else if (screen === "game") showScreen("lobby");
        $("continue-game").hidden = !game;
      }
      toast(error.message);
    } finally {
      busy = false;
      $("confirm-new-game").disabled = false;
      scheduleBot();
    }
  };
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      screen === "game" &&
      !busy &&
      !document.querySelector("dialog[open]")
    ) {
      selected.clear();
      renderHand();
      updateControls();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(botTimer);
    else scheduleBot();
  });

  async function initialize() {
    const epoch = requestEpoch;
    try {
      const data = await api("GET", "/api/game");
      if (epoch !== requestEpoch) return;
      game = data.game;
      if (game) lastEventRevision = game.revision;
      $("continue-game").hidden = !game;
    } catch (error) {
      toast(error.message);
    }
  }
  initialize();
})();
