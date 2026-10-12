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
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
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
        ? '<path d="M7 12 11 4 18 10 24 3 30 10 37 4 41 12 39 18H9Z" fill="currentColor"/><path d="M11 15H37" stroke="#fffefa" stroke-width="1"/>'
        : rank === "Q"
          ? '<path d="M10 14 13 7 20 12 24 5 28 12 35 7 38 14 36 18H12Z" fill="currentColor"/>'
          : '<path d="M10 14Q13 3 27 6L39 14 35 18H12Z" fill="currentColor"/>';
    return `<svg class="royal-art" viewBox="0 0 48 76" aria-hidden="true"><rect x="1" y="1" width="46" height="74" rx="2" fill="none" stroke="currentColor" stroke-width=".5" opacity=".6"/><g>${crown}<path d="M15 19H33L32 28 26 34 18 29Z" fill="#ecdcca" stroke="currentColor" stroke-width=".7"/><path d="M20 23H22M28 23H30M24 23 23 27H26M22 30H28" fill="none" stroke="currentColor" stroke-width=".7"/><path d="M17 30 9 35 9 43H39V35L31 30 25 36Z" fill="currentColor"/><path d="M12 37 23 43M36 37 25 43" stroke="#fffefa" stroke-width="1"/><path d="M25 34V43" stroke="#cfb278" stroke-width="2"/></g><g transform="translate(48 76) rotate(180)">${crown}<path d="M15 19H33L32 28 26 34 18 29Z" fill="#ecdcca" stroke="currentColor" stroke-width=".7"/><path d="M20 23H22M28 23H30M24 23 23 27H26M22 30H28" fill="none" stroke="currentColor" stroke-width=".7"/><path d="M17 30 9 35 9 43H39V35L31 30 25 36Z" fill="currentColor"/><path d="M12 37 23 43M36 37 25 43" stroke="#fffefa" stroke-width="1"/><path d="M25 34V43" stroke="#cfb278" stroke-width="2"/></g><text x="24" y="43" text-anchor="middle" font-family="Georgia,serif" font-size="13" fill="#fffefa">${symbol}</text></svg>`;
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
      const pairedCount = count % 2 ? count - 1 : count;
      const pips = Array.from(
        { length: pairedCount },
        (_, index) =>
          `<span class="${index >= pairedCount / 2 ? "pip-upside" : ""}">${symbol}</span>`,
      ).join("");
      middle = `<span class="card-pips count-${count}">${pips}${count % 2 ? `<span class="pip-center">${symbol}</span>` : ""}</span>`;
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

  function showScreen(next) {
    clearTimeout(botTimer);
    screen = next;
    ["lobby", "settings", "game"].forEach((name) => {
      $(`${name}-screen`).hidden = name !== next;
    });
    $("continue-game").hidden = !game;
    if (next === "game" && game) {
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
    const human = player.id === 0;
    const turn = game.turn === player.id && activePhases.includes(game.phase);
    return `<div class="player-heading ${turn ? "is-turn" : ""}"><span class="player-avatar ${human ? "human-avatar" : ""}">${icons[player.id]}</span><div><span class="player-name">${escapeHtml(player.name)}</span><span class="player-subtitle">${human ? `${player.round_points} ${plural(player.round_points, ["очко", "очка", "очков"])} · ${player.tricks_count} ${plural(player.tricks_count, ["взятка", "взятки", "взяток"])}` : turn ? "Сейчас ходит" : "За вашим столом"}</span></div><span class="player-penalty" title="Штрафные очки: проигрыш при 12">${player.penalty}<small>/12</small></span></div>`;
  }

  function renderOpponents() {
    const players = game.players.slice(1);
    $("opponents").classList.toggle("one-opponent", players.length === 1);
    $("opponents").innerHTML = players
      .map((player) => {
        const count = player.hand_count;
        const cards = Array.from({ length: count }, (_, index) => {
          const rotation = (index - (count - 1) / 2) * 6;
          return backHtml(
            `data-hand-player="${player.id}" data-hand-index="${index}" style="--rotation:${rotation}deg"`,
          );
        }).join("");
        return `<div class="opponent" data-player="${player.id}">${playerHeading(player)}<div class="opponent-hand">${cards}</div><span class="opponent-points">${player.round_points} ${plural(player.round_points, ["очко", "очка", "очков"])} · ${player.tricks_count} ${plural(player.tricks_count, ["взятка", "взятки", "взяток"])}</span></div>`;
      })
      .join("");
  }

  function renderDeck() {
    let html = game.deck_count
      ? `<div class="deck-cards">${backHtml('data-deck-layer="bottom"')}${backHtml('data-deck-layer="middle"')}${backHtml('id="deck-card"')}</div>`
      : '<div class="empty-deck" id="deck-card">♧</div>';
    if (game.hidden_trump)
      html += `<div class="hidden-trump-card" title="Скрытый козырь">${backHtml()}</div>`;
    if (game.open_trump)
      html += `<div class="open-trump">${cardHtml(game.open_trump)}</div>`;
    html += `<div class="deck-caption"><span>${game.deck_count ? `В колоде <strong>${game.deck_count}</strong>` : "Колода закончилась"}</span><span>Козырь <span class="trump-symbol ${isRed(game.trump) ? "red" : ""}">${suits[game.trump]}</span> ${suitNames[game.trump]}</span>${game.hidden_trump ? '<span class="hidden-trump-note">+ скрытый козырь</span>' : ""}</div>`;
    $("deck-area").innerHTML = html;
  }

  function renderTable() {
    const table = game.table;
    if (!table.length) {
      $("table-cards").innerHTML =
        '<div class="empty-table-note">Новый заход — новый шанс.</div>';
      return;
    }
    const lastWinnerIndex = table
      .map((entry) => entry.kind)
      .lastIndexOf("beat");
    const topIndex = lastWinnerIndex >= 0 ? lastWinnerIndex : 0;
    let beatDepth = 0;
    let discardDepth = 0;
    $("table-cards").innerHTML = table
      .map((entry, index) => {
        const discard = entry.kind === "discard";
        if (entry.kind === "beat") beatDepth++;
        if (discard) discardDepth++;
        const depth = discard ? discardDepth : beatDepth;
        const offsetX = discard ? -18 - depth * 5 : depth * 9;
        const offsetY = discard ? 18 + depth * 4 : -depth * 5;
        const z = discard ? index + 1 : 50 + index;
        const title = `${game.players[entry.player].name} · ${entry.kind === "lead" ? "заход" : entry.kind === "beat" ? "перекрыл" : "сброс"}`;
        const cards = entry.cards
          .map((card, position) =>
            cardHtml(card, {
              faceDown: entry.face_down,
              attributes: `data-table-player="${entry.player}" style="--rotation:${(position - (entry.cards.length - 1) / 2) * 3}deg"`,
            }),
          )
          .join("");
        return `<div class="table-entry kind-${entry.kind} ${index !== topIndex ? "obscured" : ""}" data-entry-index="${index}" style="margin-left:${offsetX}px;top:${offsetY}px;z-index:${z}"><span class="table-entry-label">${escapeHtml(title)}</span>${cards}</div>`;
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
            const rotation = (index - (hand.length - 1) / 2) * 3;
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
    const isHumanTurn = game.turn === 0;
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
      ? "Повторить ход бота →"
      : "Продолжить без буры →";
    let title, description;
    if (!active) {
      title =
        game.phase === "match_over" ? "Игра завершена" : "Раздача завершена";
      description = "Результаты уже за столом.";
    } else if (busy) {
      title = "Карты на стол…";
      description = "Играем без спешки.";
    } else if (buraPending()) {
      title = "У вас бура!";
      description = "Объявите её до следующего захода или продолжите игру.";
    } else if (isHumanTurn && game.phase === "lead") {
      title = legal.can_bura ? "Ваш ход. И у вас бура!" : "Ваш ход";
      description = `Выберите от 1 до ${legal.max_lead} карт одной масти.`;
    } else if (isHumanTurn && game.phase === "reply") {
      title = "Ваш ответ";
      description = `Выберите ${legal.required_count} ${legal.required_count === 1 ? "карту" : "карты"}: перекройте или сбросьте.`;
    } else if (isHumanTurn && game.phase === "cover") {
      title = "Можно сбить поверх";
      description = `Перекройте ${legal.required_count} ${legal.required_count === 1 ? "карту" : "карты"} или нажмите «Не крыть».`;
    } else {
      title = `${game.players[game.turn]?.name || "Соперник"} обдумывает ход`;
      description = "Ваша очередь скоро. Следите за козырями.";
    }
    $("turn-title").textContent = title;
    $("turn-title").classList.toggle(
      "loading-dots",
      active && !isHumanTurn && !buraPending() && !botError,
    );
    $("turn-description").textContent =
      (!busy && isHumanTurn && selectionDescription()) || description;
    $("table-status").textContent =
      game.table.length && game.winner !== null
        ? `Сейчас взятка у ${game.winner === 0 ? "вас" : game.players[game.winner].name.toLowerCase()}`
        : "";
  }

  function renderGame() {
    if (!game) return;
    $("round-label").textContent = `Раздача ${game.round}`;
    $("game-settings-label").textContent =
      `${game.settings.players} игрока · ${game.settings.hand_size} ${plural(game.settings.hand_size, ["карта", "карты", "карт"])}`;
    renderOpponents();
    renderDeck();
    renderTable();
    renderHand();
    updateControls();
  }

  function capturePositions() {
    const cards = new Map();
    const table = [];
    document.querySelectorAll("#game-table [data-card-id]").forEach((node) => {
      cards.set(node.dataset.cardId, node.getBoundingClientRect());
    });
    document.querySelectorAll("#table-cards .card").forEach((node) => {
      table.push({ rect: node.getBoundingClientRect(), html: node.outerHTML });
    });
    const players = new Map();
    document.querySelectorAll("[data-player]").forEach((node) => {
      players.set(Number(node.dataset.player), node.getBoundingClientRect());
    });
    const human = $("human-player").getBoundingClientRect();
    players.set(0, human);
    const deck =
      $("deck-card")?.getBoundingClientRect() ||
      $("deck-area").getBoundingClientRect();
    return { cards, table, players, deck };
  }

  function rectForPlayer(player, positions, index = 0) {
    const position = positions.players.get(player);
    if (!position) return positions.deck;
    return {
      left: position.left + position.width / 2 - 27 + index * 3,
      top: position.top + (player === 0 ? 47 : 46),
      width: 54,
      height: 76,
    };
  }

  function tableDestination(index, count) {
    const bounds = $("table-cards").getBoundingClientRect();
    const width =
      innerWidth <= 380
        ? 48
        : innerWidth <= 620
          ? 53
          : innerWidth <= 850
            ? 63
            : 69;
    return {
      left:
        bounds.left +
        bounds.width / 2 -
        (count * (width + 7)) / 2 +
        index * (width + 7),
      top: bounds.top,
      width,
      height: width * 1.4,
    };
  }

  function createFlyingCard(html, from, to, duration = 300, keep = false) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    const node = wrapper.firstElementChild;
    node.classList.add("card-flight");
    node.removeAttribute("style");
    node.style.width = `${to.width || 60}px`;
    node.style.height = `${to.height || 84}px`;
    node.style.left = `${to.left}px`;
    node.style.top = `${to.top}px`;
    $("animation-layer").appendChild(node);
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const startScale = (from.width || to.width) / to.width;
    const animation = node.animate(
      [
        {
          transform: `translate(${dx}px,${dy}px) scale(${startScale}) rotate(-9deg)`,
          opacity: 0.95,
        },
        {
          transform: `translate(${dx * 0.4}px,${dy * 0.35 - 20}px) scale(1.08) rotate(3deg)`,
          offset: 0.55,
          opacity: 1,
        },
        { transform: "translate(0,0) scale(1) rotate(0)", opacity: 1 },
      ],
      { duration, easing: "cubic-bezier(.2,.75,.3,1)", fill: "forwards" },
    );
    const promise = animation.finished
      .catch(() => {})
      .then(() => {
        if (!keep) node.remove();
      });
    return { node, promise, rect: to };
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function animateEvents(events, previous, oldGame) {
    if (reducedMotion || !events?.length || screen !== "game") return;
    const current = capturePositions();
    const transient = [];
    const flights = [];
    const dealt = new Map(game.players.map((player) => [player.id, 0]));
    const incoming = new Map(
      game.players.map((player) => [
        player.id,
        events
          .filter(
            (event) =>
              ["deal", "draw"].includes(event.type) &&
              event.player === player.id,
          )
          .reduce((sum, event) => sum + event.count, 0),
      ]),
    );
    const addedHuman = game.players[0].hand.filter(
      (card) => !oldGame?.players[0].hand.some((old) => old.id === card.id),
    );
    const hiddenNodes = [];
    addedHuman.forEach((card) => {
      const node = $("human-hand").querySelector(`[data-card-id="${card.id}"]`);
      if (node) {
        node.style.visibility = "hidden";
        hiddenNodes.push(node);
      }
    });
    game.players.slice(1).forEach((player) => {
      const start = Math.max(0, player.hand_count - incoming.get(player.id));
      for (let index = start; index < player.hand_count; index++) {
        const node = document.querySelector(
          `[data-hand-player="${player.id}"][data-hand-index="${index}"]`,
        );
        if (node) {
          node.style.visibility = "hidden";
          hiddenNodes.push(node);
        }
      }
    });
    const playEvents = events.filter((event) => event.type === "play");
    const entries = [...document.querySelectorAll(".table-entry")];
    for (const event of playEvents) {
      const entry = [...entries].reverse().find((node) => {
        const data = game.table[Number(node.dataset.entryIndex)];
        return data.player === event.player && data.kind === event.kind;
      });
      if (entry) {
        entry.style.visibility = "hidden";
        hiddenNodes.push(entry);
      }
    }
    try {
      for (const event of events) {
        if (event.type === "deal" || event.type === "draw") {
          for (let index = 0; index < event.count; index++) {
            const number = dealt.get(event.player);
            dealt.set(event.player, number + 1);
            let node, to;
            if (event.player === 0) {
              const card = addedHuman[number];
              node =
                card &&
                $("human-hand").querySelector(`[data-card-id="${card.id}"]`);
              to =
                node?.getBoundingClientRect() ||
                rectForPlayer(event.player, current, number);
            } else {
              const count = game.players[event.player].hand_count;
              const nodeIndex =
                Math.max(0, count - incoming.get(event.player)) + number;
              node = document.querySelector(
                `[data-hand-player="${event.player}"][data-hand-index="${nodeIndex}"]`,
              );
              to =
                node?.getBoundingClientRect() ||
                rectForPlayer(event.player, current, number);
            }
            if (node) {
              node.style.visibility = "hidden";
              hiddenNodes.push(node);
            }
            const flight = createFlyingCard(backHtml(), current.deck, to, 280);
            flights.push(
              flight.promise.then(() => {
                if (node) node.style.visibility = "";
              }),
            );
            await delay(event.type === "deal" ? 65 : 75);
          }
        } else if (event.type === "play") {
          const playFlights = event.cards.map((card, index) => {
            const from =
              (card.id && previous.cards.get(card.id)) ||
              rectForPlayer(event.player, previous, index);
            const tableNode =
              card.id &&
              $("table-cards").querySelector(`[data-card-id="${card.id}"]`);
            const to =
              tableNode?.getBoundingClientRect() ||
              tableDestination(index, event.cards.length);
            const flight = createFlyingCard(
              cardHtml(card, { faceDown: event.face_down }),
              from,
              to,
              320,
              true,
            );
            transient.push(flight);
            return flight.promise;
          });
          await Promise.all(playFlights);
          for (const node of hiddenNodes.filter((item) =>
            item.classList.contains("table-entry"),
          ))
            node.style.visibility = "";
        } else if (event.type === "collect") {
          await delay(130);
          const all = previous.table.concat(
            transient.map((flight) => ({
              rect: flight.rect,
              html: flight.node.outerHTML,
            })),
          );
          const pile = all.slice(0, event.count);
          const destination = rectForPlayer(event.player, current);
          await Promise.all(
            pile.map(
              (card, index) =>
                createFlyingCard(
                  card.html,
                  card.rect,
                  {
                    ...destination,
                    left: destination.left + index * 2,
                    width: 45,
                    height: 63,
                  },
                  330,
                ).promise,
            ),
          );
          transient.forEach((flight) => flight.node.remove());
        } else if (event.type === "trump") {
          $("deck-area").classList.remove("trump-flash");
          void $("deck-area").offsetWidth;
          $("deck-area").classList.add("trump-flash");
          toast(
            `Новый козырь — ${suits[event.suit]} ${suitNames[event.suit]}. Скрытая карта раскрыта.`,
          );
          await delay(330);
        } else if (event.type === "round_end") await delay(150);
      }
      await Promise.all(flights);
    } finally {
      hiddenNodes.forEach((node) => {
        node.style.visibility = "";
      });
      transient.forEach((flight) => flight.node.remove());
      $("animation-layer").replaceChildren();
    }
  }

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
    const positions = capturePositions();
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
      renderGame();
      const events = game.revision !== lastEventRevision ? game.events : [];
      lastEventRevision = game.revision;
      await animateEvents(events, positions, oldGame);
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
      botError
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
      showScreen("game");
      lastEventRevision = game.revision;
      await animateEvents(game.events, capturePositions(), null);
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
    if (!busy) showScreen("lobby");
  };
  $("brand-home").onclick = (event) => {
    event.preventDefault();
    if (!busy) showScreen("lobby");
  };
  $("new-game").onclick = () => {
    if (!busy) $("new-game-dialog").showModal();
  };
  $("multiplayer-placeholder").onclick = () => {
    toast("Мультиплеер появится позже. А пока боты готовы составить компанию.");
  };
  document.querySelectorAll(".rules-toggle").forEach((button) => {
    button.onclick = () => {
      $("rules-dialog").showModal();
    };
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.onclick = () => {
      button.closest("dialog").close();
    };
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
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
