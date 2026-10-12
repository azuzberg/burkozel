/* Replay server events against a temporary state; never reveal future cards. */
(() => {
  "use strict";

  const copy = (value) => JSON.parse(JSON.stringify(value));
  const cardNodes = (selector) => [...document.querySelectorAll(selector)];
  const handSelector = (player) => `[data-player-hand="${player}"] .card`;
  const reducedMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const visualProperties = [
    "color",
    "background",
    "border",
    "border-radius",
    "box-shadow",
    "font",
    "letter-spacing",
    "line-height",
    "padding",
    "gap",
    "display",
    "position",
    "top",
    "right",
    "bottom",
    "left",
    "width",
    "height",
    "inset",
    "grid-template-columns",
    "grid-template-rows",
    "grid-auto-rows",
    "align-items",
    "justify-items",
    "place-items",
    "flex-direction",
    "transform",
    "transform-origin",
    "overflow",
    "opacity",
    "box-sizing",
  ];

  function pose(node) {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    let angle = 0;
    let scaleX = 1;
    let scaleY = 1;
    // A sideways open trump rotates its parent, not necessarily the card itself.
    for (
      let parent = node;
      parent instanceof Element;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      if (style.transform !== "none") {
        try {
          const matrix = new DOMMatrixReadOnly(style.transform);
          angle += (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
          scaleX *= Math.hypot(matrix.a, matrix.b);
          scaleY *= Math.hypot(matrix.c, matrix.d);
        } catch {
          /* A missing matrix parser must not interrupt a game. */
        }
      }
      if (style.rotate && style.rotate !== "none") {
        const rotation = parseFloat(style.rotate.split(" ").at(-1));
        if (Number.isFinite(rotation)) angle += rotation;
      }
      if (style.scale && style.scale !== "none") {
        const scales = style.scale.split(" ").map(Number);
        scaleX *= scales[0] || 1;
        scaleY *= scales[1] || scales[0] || 1;
      }
    }
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: node.offsetWidth * scaleX || rect.width,
      height: node.offsetHeight * scaleY || rect.height,
      angle,
    };
  }

  function frozenClone(node) {
    const clone = node.cloneNode(true);
    const originals = [node, ...node.querySelectorAll("*")];
    const clones = [clone, ...clone.querySelectorAll("*")];
    originals.forEach((original, index) => {
      const style = getComputedStyle(original);
      const target = clones[index];
      // Descendants keep their exact artwork even outside a hand/table selector.
      for (const property of visualProperties) {
        target.style.setProperty(property, style.getPropertyValue(property));
      }
      target.removeAttribute("id");
      target.removeAttribute("data-card-id");
      target.removeAttribute("data-hand-player");
      target.removeAttribute("data-hand-index");
      target.removeAttribute("data-table-player");
      target.removeAttribute("aria-pressed");
      target.removeAttribute("aria-label");
      target.setAttribute("aria-hidden", "true");
      if (target instanceof HTMLButtonElement) target.disabled = true;
    });
    clone.classList.remove("selected", "is-trump");
    return clone;
  }

  function snapshot(node) {
    const bounds = pose(node);
    return bounds ? { ...bounds, clone: frozenClone(node), node } : null;
  }

  function handPositions(artwork = true, onlyPlayer = null) {
    const result = new Map();
    cardNodes(
      onlyPlayer === null
        ? "[data-player-hand] .card"
        : handSelector(onlyPlayer),
    ).forEach((node) => {
      const player = node.closest("[data-player-hand]").dataset.playerHand;
      const key = node.dataset.cardId
        ? `card:${node.dataset.cardId}`
        : `bot:${player}:${node.dataset.handIndex}`;
      const bounds = pose(node);
      const value = bounds
        ? { ...bounds, node, ...(artwork ? { clone: frozenClone(node) } : {}) }
        : null;
      if (value) result.set(key, value);
    });
    return result;
  }

  class CardAnimator {
    constructor() {
      this.active = null;
      this.sequence = 0;
    }

    cancel() {
      const session = this.active;
      if (!session) return;
      session.cancelled = true;
      this._finish(session);
    }

    _finish(session) {
      if (session.finished) return;
      session.finished = true;
      session.animations.forEach((animation) => animation.cancel());
      session.timers.forEach((entry) => {
        clearTimeout(entry.id);
        entry.resolve();
      });
      session.hidden.forEach((visibility, node) => {
        node.style.visibility = visibility;
      });
      session.layer?.remove();
      window.removeEventListener("resize", session.interrupt);
      window.removeEventListener("scroll", session.scroll, true);
      document.removeEventListener("visibilitychange", session.visibility);
      session.media?.removeEventListener?.("change", session.interrupt);
      if (this.active === session) {
        this.active = null;
        if (!session.finalRendered)
          session.render(session.next, { staged: false });
      }
    }

    _hide(session, node) {
      if (!node) return;
      if (!session.hidden.has(node))
        session.hidden.set(node, node.style.visibility);
      node.style.visibility = "hidden";
    }

    _show(session, node) {
      if (node && session.hidden.has(node)) {
        node.style.visibility = session.hidden.get(node);
        session.hidden.delete(node);
      }
    }

    _pause(session, milliseconds) {
      if (session.cancelled) return Promise.resolve();
      return new Promise((resolve) => {
        const entry = { resolve, id: null };
        entry.id = setTimeout(() => {
          session.timers.delete(entry);
          resolve();
        }, milliseconds);
        session.timers.add(entry);
      });
    }

    _animate(session, node, frames, options) {
      const animation = node.animate(frames, { ...options, fill: "both" });
      session.animations.add(animation);
      return animation.finished
        .catch(() => {})
        .finally(() => {
          session.animations.delete(animation);
        });
    }

    _back() {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = window.BurkozelCards.backHtml();
      return wrapper.firstElementChild;
    }

    _prepareFace(node) {
      Object.assign(node.style, {
        position: "absolute",
        left: "0",
        top: "0",
        right: "auto",
        bottom: "auto",
        width: "100%",
        height: "100%",
        margin: "0",
        transform: "none",
        visibility: "visible",
        opacity: "1",
        transition: "none",
        animation: "none",
        pointerEvents: "none",
        backfaceVisibility: "hidden",
        boxSizing: "border-box",
      });
      node.style.setProperty("--rotation", "0deg");
      node.style.setProperty("--lift", "0px");
      return node;
    }

    async _flight(session, from, to, options = {}) {
      if (!from || !to || session.cancelled) return;
      const duration = options.duration || 300;
      const artwork = options.artPose || (to.clone ? to : from);
      const endScaleX = to.width / artwork.width;
      const endScaleY = to.height / artwork.height;
      const wrapper = document.createElement("div");
      wrapper.className = "card-motion";
      Object.assign(wrapper.style, {
        position: "absolute",
        left: `${to.x - artwork.width / 2}px`,
        top: `${to.y - artwork.height / 2}px`,
        width: `${artwork.width}px`,
        height: `${artwork.height}px`,
        transformOrigin: "center",
        pointerEvents: "none",
        perspective: "800px",
        zIndex: String(options.zIndex || 10),
      });
      const turner = document.createElement("div");
      Object.assign(turner.style, {
        width: "100%",
        height: "100%",
        position: "relative",
        transformStyle: "preserve-3d",
      });
      wrapper.append(turner);
      const front = this._prepareFace((to.clone || from.clone).cloneNode(true));
      if (options.reveal) {
        const back = this._prepareFace(this._back());
        back.style.transform = "rotateY(180deg)";
        turner.append(front, back);
      } else if (options.conceal) {
        const visible = this._prepareFace(from.clone.cloneNode(true));
        Object.assign(visible.style, {
          width: `${from.width}px`,
          height: `${from.height}px`,
          transformOrigin: "0 0",
          transform: `scale(${artwork.width / from.width},${artwork.height / from.height})`,
        });
        front.style.transform = "rotateY(180deg)";
        turner.append(visible, front);
      } else turner.append(front);
      session.layer.append(wrapper);
      this._hide(session, to.node);
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      const sx = from.width / artwork.width;
      const sy = from.height / artwork.height;
      const transform = (x, y, angle, scaleX, scaleY) =>
        `translate(${x}px,${y}px) rotate(${angle}deg) scale(${scaleX},${scaleY})`;
      const motion = this._animate(
        session,
        wrapper,
        [
          { transform: transform(dx, dy, from.angle || 0, sx, sy) },
          {
            transform: transform(
              dx * 0.45,
              dy * 0.45 - (options.arc === false ? 0 : 12),
              (from.angle || 0) * 0.45 + (to.angle || 0) * 0.55,
              sx * 0.45 + endScaleX * 0.55,
              sy * 0.45 + endScaleY * 0.55,
            ),
            offset: 0.55,
          },
          { transform: transform(0, 0, to.angle || 0, endScaleX, endScaleY) },
        ],
        { duration, easing: "cubic-bezier(.25,.72,.3,1)" },
      );
      let flip = Promise.resolve();
      if (options.reveal || options.conceal) {
        flip = this._animate(
          session,
          turner,
          [
            { transform: `rotateY(${options.reveal ? 180 : 0}deg)`, offset: 0 },
            {
              transform: `rotateY(${options.reveal ? 180 : 0}deg)`,
              offset: 0.3,
            },
            { transform: `rotateY(${options.reveal ? 0 : 180}deg)`, offset: 1 },
          ],
          { duration, easing: "ease-in-out" },
        );
      }
      await Promise.all([motion, flip]);
      wrapper.remove();
      this._show(session, to.node);
    }

    _moveHands(session, before, duration = 230) {
      const after = handPositions(false);
      return Promise.all(
        [...after].flatMap(([key, to]) => {
          const from = before.get(key);
          if (
            !from ||
            Math.abs(from.x - to.x) +
              Math.abs(from.y - to.y) +
              Math.abs(from.angle - to.angle) <
              0.5
          )
            return [];
          return [
            this._flight(
              session,
              from,
              { ...to, clone: from.clone },
              { duration, arc: false, zIndex: 5 },
            ),
          ];
        }),
      );
    }

    _render(session) {
      if (!session.cancelled) session.render(session.state, { staged: true });
    }

    _initialState(previous, next, events) {
      if (previous && !events.some((event) => event.type === "deal"))
        return copy(previous);
      const state = copy(next);
      state.table = [];
      state.table_cards = [];
      state.winner = null;
      state.result = null;
      state.deck_count =
        next.deck_count +
        events
          .filter((event) => event.type === "deal")
          .reduce((sum, event) => sum + (event.count || 1), 0);
      state.open_trump = null;
      state.players.forEach((player) => {
        player.hand = [];
        player.hand_count = 0;
        player.round_points = 0;
        player.tricks_count = 0;
      });
      return state;
    }

    async _incoming(session, event) {
      const player = session.state.players.find(
        (value) => value.id === event.player,
      );
      for (let index = 0; index < (event.count || 1); index++) {
        if (session.cancelled) return;
        const before = handPositions(true, event.player);
        const deckSource =
          session.state.deck_count === 2
            ? document.querySelector(".open-trump .card")
            : session.state.deck_count === 1
              ? document.querySelector(".hidden-trump-card .card")
              : null;
        const source = snapshot(
          deckSource ||
            document.querySelector("[data-deck]") ||
            document.getElementById("deck-card"),
        );
        const card =
          event.player === 0
            ? event.cards?.[index] || session.incoming.shift()
            : null;
        if (event.player === 0 && card && !card.hidden) {
          // Remove an explicitly supplied card from the legacy fallback queue too.
          session.incoming = session.incoming.filter(
            (value) => value.id !== card.id,
          );
          player.hand.push(copy(card));
        }
        player.hand_count++;
        session.state.deck_count = Math.max(0, session.state.deck_count - 1);
        if (session.state.deck_count < 2) session.state.open_trump = null;
        if (!session.state.deck_count) session.state.hidden_trump = false;
        this._render(session);
        const destinations = cardNodes(handSelector(event.player));
        const targetNode =
          event.player === 0 && card?.id
            ? destinations.find((node) => node.dataset.cardId === card.id)
            : destinations.at(-1);
        const target = snapshot(targetNode);
        await Promise.all([
          this._moveHands(session, before, event.type === "deal" ? 170 : 230),
          this._flight(session, source, target, {
            duration: event.type === "deal" ? 190 : 250,
            reveal:
              event.player === 0 &&
              Boolean(card?.id) &&
              !deckSource?.matches(".open-trump .card"),
            conceal:
              event.player !== 0 &&
              Boolean(deckSource?.matches(".open-trump .card")),
          }),
        ]);
      }
    }

    async _playCards(session, event) {
      const before = handPositions(true, event.player);
      const player = session.state.players.find(
        (value) => value.id === event.player,
      );
      const hand = cardNodes(handSelector(event.player));
      const cards = event.cards || [];
      const removed = [];
      const sources = cards.map((card, index) => {
        const known = card.id
          ? player.hand.find((value) => value.id === card.id)
          : session.removed.shift();
        if (known) removed.push(known.id);
        const node =
          event.player === 0
            ? hand.find((value) => value.dataset.cardId === known?.id)
            : hand[Math.max(0, hand.length - cards.length) + index];
        return snapshot(node);
      });
      player.hand = player.hand.filter((card) => !removed.includes(card.id));
      player.hand_count = Math.max(0, player.hand_count - cards.length);
      const entry = {
        player: event.player,
        kind: event.kind,
        face_down: Boolean(event.face_down),
        cards: copy(cards),
      };
      session.state.table.push(entry);
      if (event.kind !== "discard") {
        session.state.table_cards = copy(cards);
        session.state.winner = event.player;
      }
      this._render(session);
      const tableEntries = cardNodes(
        "[data-table-cards] .table-entry, #table-cards .table-entry",
      );
      const destinations = [
        ...(tableEntries.at(-1)?.querySelectorAll(".card") || []),
      ];
      await Promise.all([
        this._moveHands(session, before, 280),
        ...cards.map((card, index) =>
          this._flight(session, sources[index], snapshot(destinations[index]), {
            duration: 350,
            reveal: event.player !== 0 && !event.face_down && !card.hidden,
            conceal: event.player === 0 && Boolean(event.face_down),
            zIndex: 10 + index,
          }),
        ),
      ]);
    }

    async _collect(session, event) {
      // Keep the completed trick readable before moving every card together.
      await this._pause(session, 470);
      if (session.cancelled) return;
      const sources = cardNodes("[data-table-cards] .card, #table-cards .card")
        .map(snapshot)
        .filter(Boolean);
      const anchor = document.querySelector(
        `[data-player-pile="${event.player}"]`,
      );
      const pile =
        pose(anchor) ||
        pose(document.querySelector(`[data-player-hand="${event.player}"]`));
      if (pile) {
        const width = innerWidth < 640 ? 35 : 48;
        await Promise.all(
          sources.map((source, index) => {
            this._hide(session, source.node);
            return this._flight(
              session,
              source,
              {
                x: pile.x + Math.min(index, 5) * 1.4,
                y: pile.y,
                width,
                height: width * 1.4,
                angle: 0,
                clone: source.clone,
              },
              {
                duration: 440,
                arc: false,
                artPose: source,
                zIndex: 10 + index,
              },
            );
          }),
        );
      }
      if (session.cancelled) return;
      const player = session.state.players.find(
        (value) => value.id === event.player,
      );
      player.tricks_count++;
      // Only the final server response knows points of hidden discards.
      player.round_points = session.next.players.find(
        (value) => value.id === event.player,
      ).round_points;
      session.state.table = [];
      session.state.table_cards = [];
      session.state.winner = null;
      this._render(session);
    }

    async play({ previous, next, events = next?.events || [], render }) {
      this.cancel();
      if (
        !next ||
        !events.length ||
        document.hidden ||
        reducedMotion() ||
        typeof Element.prototype.animate !== "function" ||
        !window.BurkozelCards
      ) {
        render(next, { staged: false });
        return;
      }
      const layer = document.createElement("div");
      layer.className = "card-animation-layer";
      layer.setAttribute("aria-hidden", "true");
      Object.assign(layer.style, {
        position: "fixed",
        inset: "0",
        pointerEvents: "none",
        zIndex: "1000",
        overflow: "visible",
      });
      document.body.append(layer);
      const initialIds = new Set(
        previous?.players[0]?.hand.map((card) => card.id) || [],
      );
      const finalIds = new Set(next.players[0].hand.map((card) => card.id));
      const session = {
        id: ++this.sequence,
        next,
        render,
        layer,
        state: this._initialState(previous, next, events),
        animations: new Set(),
        hidden: new Map(),
        timers: new Set(),
        cancelled: false,
        initialScroll: { x: window.scrollX, y: window.scrollY },
        incoming: next.players[0].hand.filter(
          (card) => !initialIds.has(card.id),
        ),
        removed: (previous?.players[0]?.hand || []).filter(
          (card) => !finalIds.has(card.id),
        ),
      };
      this.active = session;
      session.interrupt = () => this.cancel();
      session.scroll = (event) => {
        const viewport = event.target === window || event.target === document;
        // Screen navigation can queue a scroll event after the viewport already reached zero.
        // Only a real viewport change invalidates the fixed animation coordinates.
        if (
          !viewport ||
          window.scrollX !== session.initialScroll.x ||
          window.scrollY !== session.initialScroll.y
        ) {
          this.cancel();
        }
      };
      session.visibility = () => {
        if (document.hidden) this.cancel();
      };
      session.media = window.matchMedia("(prefers-reduced-motion: reduce)");
      window.addEventListener("resize", session.interrupt, { passive: true });
      window.addEventListener("scroll", session.scroll, {
        passive: true,
        capture: true,
      });
      document.addEventListener("visibilitychange", session.visibility);
      session.media.addEventListener?.("change", session.interrupt);
      try {
        this._render(session);
        for (const event of events) {
          if (session.cancelled) break;
          if (event.type === "deal" || event.type === "draw")
            await this._incoming(session, event);
          else if (event.type === "play") await this._playCards(session, event);
          else if (event.type === "collect")
            await this._collect(session, event);
          else if (event.type === "trump") {
            session.state.trump = event.suit;
            this._render(session);
            const badge = document.getElementById("deck-area");
            if (badge)
              await this._animate(
                session,
                badge,
                [{ opacity: 0.45 }, { opacity: 1 }],
                { duration: 200 },
              );
          }
        }
        if (!session.cancelled) {
          const before = handPositions(true, 0);
          // Final hands are sorted by the server. FLIP preserves identity while reordering.
          render(next, { staged: false });
          await this._moveHands(session, before, 280);
          if (!session.cancelled) session.finalRendered = true;
        }
      } finally {
        this._finish(session);
      }
    }
  }

  window.CardAnimator = CardAnimator;
})();
