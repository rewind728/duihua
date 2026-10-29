/**
 * 对花 · 纯规则逻辑
 *
 * 不碰 DOM，不碰网络，浏览器和 Node 共用。
 * 所有随机都来自 roomId（seed）+ round，保证两端发牌完全一致。
 */

/* ══════════════ 牌与常量 ══════════════ */

export const SUITS = ['S', 'H', 'C', 'D'];
export const SUIT_NAMES = { S: '黑桃', H: '红桃', C: '梅花', D: '方块' };
export const SUIT_GLYPHS = { S: '♠', H: '♥', C: '♣', D: '♦' };
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const RANK_LABELS = { T: '10' };
export const PLAYERS = ['host', 'guest'];
export const PHASES = ['lead', 'respond', 'relay', 'dump', 'ended'];

export const HAND_LIMIT = 10;
export const INITIAL_HAND = 10;
export const DECK_SIZE = 52;
export const DRAW_START = 20; // 每人 10 张，剩下 32 张进牌堆

export const FULL_DECK = SUITS.flatMap((s) => RANKS.map((r) => s + r));

/* ══════════════ 牌面工具 ══════════════ */

export const other = (p) => (p === 'host' ? 'guest' : 'host');

export const suitOf = (card) => card[0];
export const rankOf = (card) => card[1];
export const rankValue = (card) => RANKS.indexOf(card[1]);
export const rankLabel = (rank) => RANK_LABELS[rank] || rank;
export const isRed = (card) => card[0] === 'H' || card[0] === 'D';

export function isCard(card) {
  return typeof card === 'string'
    && card.length === 2
    && SUITS.includes(card[0])
    && RANKS.includes(card[1]);
}

export function cardName(card) {
  return SUIT_NAMES[suitOf(card)] + rankLabel(rankOf(card));
}

export function isTrumpCard(state, card) {
  return suitOf(card) === state.trump;
}

/* ══════════════ 确定性发牌 ══════════════ */

/** FNV-1a 32 位字符串哈希 */
export function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小而稳的 32 位 PRNG */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(cards, rng) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 从 seed + round 推导整局：洗牌、主花色、先手、双方手牌。
 * 同一个 seed/round 在任何设备上结果完全一致。
 */
export function deriveRound(seed, round) {
  const rng = mulberry32(fnv1a(String(seed) + ':' + round));
  const deck = shuffle(FULL_DECK, rng);
  const trump = SUITS[Math.floor(rng() * SUITS.length)];
  const first = rng() < 0.5 ? 'host' : 'guest';

  const hands = { host: [], guest: [] };
  for (let i = 0; i < INITIAL_HAND; i++) {
    hands.host.push(deck[i * 2]);
    hands.guest.push(deck[i * 2 + 1]);
  }

  return { deck, trump, first, hands, drawIndex: DRAW_START };
}

/* ══════════════ 状态创建 ══════════════ */

export function newGame(seed, round, score = { host: 0, guest: 0 }) {
  const d = deriveRound(seed, round);
  return {
    seed: String(seed),
    round,
    rev: 0,
    drawIndex: d.drawIndex,
    trump: d.trump,
    first: d.first,
    leader: d.first,
    phase: 'lead',
    hands: d.hands,
    table: [],
    discard: [],
    score: {
      host: (score && score.host) | 0,
      guest: (score && score.guest) | 0,
    },
    status: 'playing',
    winner: null,
    reason: '',
    dumpBy: null,
    pickupBy: null,
  };
}

export function cloneState(s) {
  return {
    ...s,
    hands: { host: s.hands.host.slice(), guest: s.hands.guest.slice() },
    table: s.table.map((e) => ({ ...e })),
    discard: s.discard.slice(),
    score: { ...s.score },
  };
}

/* ══════════════ 派生查询 ══════════════ */

export const deckLeft = (s) => Math.max(0, DECK_SIZE - s.drawIndex);
export const deckEmpty = (s) => s.drawIndex >= DECK_SIZE;

export function remainingDeck(s) {
  return deriveRound(s.seed, s.round).deck.slice(s.drawIndex);
}

export function allCards(s) {
  return [
    ...s.hands.host,
    ...s.hands.guest,
    ...s.table.map((e) => e.card),
    ...s.discard,
    ...remainingDeck(s),
  ];
}

export function currentEntry(s) {
  return s.table.length ? s.table[s.table.length - 1] : null;
}

export function currentCard(s) {
  const e = currentEntry(s);
  return e ? e.card : null;
}

/** 本回合桌面上出现过的所有点数 */
export function tableRanks(s) {
  const set = new Set();
  for (const e of s.table) set.add(rankOf(e.card));
  return set;
}

export function tableRankList(s) {
  return Array.from(tableRanks(s)).sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b));
}

export function legalBeats(s, player) {
  const cur = currentEntry(s);
  if (!cur) return [];
  const hand = s.hands[player];
  const curSuit = suitOf(cur.card);
  const curVal = rankValue(cur.card);
  const curIsTrump = curSuit === s.trump;

  return hand.filter((card) => {
    const cardIsTrump = suitOf(card) === s.trump;
    if (cardIsTrump) {
      return curIsTrump ? rankValue(card) > curVal : true;
    }
    if (curIsTrump) return false;
    return suitOf(card) === curSuit && rankValue(card) > curVal;
  });
}

export function legalRelays(s, player) {
  const ranks = tableRanks(s);
  return s.hands[player].filter((card) => ranks.has(rankOf(card)));
}

export function legalDumps(s, player) {
  const ranks = tableRanks(s);
  return s.hands[player].filter((card) => ranks.has(rankOf(card)));
}

/**
 * 当前玩家可做的操作；不是他的阶段则返回 null。
 * 返回的 cards 是可选牌，canPickup/canStop/canSkip 是额外按钮。
 */
export function legalFor(s, player) {
  if (!s || s.status !== 'playing') return null;
  if (s.phase === 'lead' && player === s.leader) {
    return { type: 'lead', cards: s.hands[player].slice() };
  }
  if (s.phase === 'respond' && player === other(s.leader)) {
    return { type: 'respond', cards: legalBeats(s, player), canPickup: true };
  }
  if (s.phase === 'relay' && player === s.leader) {
    return { type: 'relay', cards: legalRelays(s, player), canStop: true };
  }
  if (s.phase === 'dump' && player === s.dumpBy) {
    return { type: 'dump', cards: legalDumps(s, player), canSkip: true };
  }
  return null;
}

export function actorOf(s) {
  if (!s || s.status !== 'playing') return null;
  if (s.phase === 'lead' || s.phase === 'relay' || s.phase === 'dump') return s.leader;
  if (s.phase === 'respond') return other(s.leader);
  return null;
}

/* ══════════════ 内部工具 ══════════════ */

const fail = (error) => ({ ok: false, error });

function finish(s, winner, reason) {
  if (s.status === 'ended') return;
  s.status = 'ended';
  s.phase = 'ended';
  s.winner = winner;
  s.reason = reason;
  s.dumpBy = null;
  s.pickupBy = null;
  if (winner === 'host' || winner === 'guest') {
    s.score[winner] = (s.score[winner] || 0) + 1;
  }
}

function removeCard(hand, card) {
  const i = hand.indexOf(card);
  if (i < 0) return false;
  hand.splice(i, 1);
  return true;
}

function checkImmediateWin(s, player) {
  if (s.status !== 'playing') return false;
  if (deckEmpty(s) && s.hands[player].length === 0) {
    finish(s, player, 'empty');
    return true;
  }
  return false;
}

/** 回合结束后补牌：领出方先摸，摸到 10 或牌堆空为止 */
function refill(s) {
  const events = [];
  const draws = { host: 0, guest: 0 };
  const order = [s.leader, other(s.leader)];

  for (const p of order) {
    const need = Math.max(0, HAND_LIMIT - s.hands[p].length);
    const avail = deckLeft(s);
    const n = Math.min(need, avail);
    if (n > 0) {
      const deck = deriveRound(s.seed, s.round).deck;
      const cards = deck.slice(s.drawIndex, s.drawIndex + n);
      s.drawIndex += n;
      s.hands[p].push(...cards);
      draws[p] += n;
    }
  }

  if (draws.host || draws.guest) events.push({ type: 'refill', draws });

  if (s.status === 'playing' && deckEmpty(s)) {
    const empty = PLAYERS.filter((p) => s.hands[p].length === 0);
    if (empty.length === 1) {
      finish(s, empty[0], 'empty');
      events.push({ type: 'win', winner: empty[0], reason: 'empty' });
    } else if (empty.length === 2) {
      // 极罕见：双方同时空手。最后摸牌的是领出方，另一方先出完，判另一方胜。
      const winner = other(s.leader);
      finish(s, winner, 'empty');
      events.push({ type: 'win', winner, reason: 'empty' });
    }
  }

  return events;
}

/* ══════════════ 动作 ══════════════ */

function applyLead(state, by, card) {
  if (state.phase !== 'lead') return fail('当前不是领出阶段');
  if (by !== state.leader) return fail('还没轮到你领出');
  if (!state.hands[by].includes(card)) return fail('这张牌不在手里');

  const s = cloneState(state);
  removeCard(s.hands[by], card);
  s.table.push({ by, card, kind: 'lead' });
  s.phase = 'respond';
  s.rev++;

  const events = [{ type: 'lead', by, card }];
  if (checkImmediateWin(s, by)) events.push({ type: 'win', winner: by, reason: 'empty' });
  return { ok: true, state: s, events };
}

function applyBeat(state, by, card) {
  if (state.phase !== 'respond') return fail('当前不是压牌阶段');
  if (by !== other(state.leader)) return fail('还没轮到你压牌');
  if (!state.hands[by].includes(card)) return fail('这张牌不在手里');
  if (!legalBeats(state, by).includes(card)) return fail('这张牌压不住');

  const s = cloneState(state);
  removeCard(s.hands[by], card);
  s.table.push({ by, card, kind: 'beat' });
  s.phase = 'relay';
  s.rev++;

  const events = [{ type: 'beat', by, card }];
  if (checkImmediateWin(s, by)) events.push({ type: 'win', winner: by, reason: 'empty' });
  return { ok: true, state: s, events };
}

function applyPickup(state, by) {
  if (state.phase !== 'respond') return fail('当前不是压牌阶段');
  if (by !== other(state.leader)) return fail('还没轮到你捡牌');

  const s = cloneState(state);
  s.phase = 'dump';
  s.dumpBy = s.leader;
  s.pickupBy = by;
  s.rev++;
  return { ok: true, state: s, events: [{ type: 'pickup', by }] };
}

function applyDump(state, by, cards) {
  if (state.phase !== 'dump') return fail('当前不是塞牌阶段');
  if (by !== state.dumpBy) return fail('还没轮到你塞牌');
  if (!Array.isArray(cards)) return fail('塞牌数据无效');

  const list = cards.slice();
  if (new Set(list).size !== list.length) return fail('不能重复塞同一张牌');

  const ranks = tableRanks(state);
  for (const c of list) {
    if (!isCard(c)) return fail('牌面无效');
    if (!state.hands[by].includes(c)) return fail('这张牌不在手里');
    if (!ranks.has(rankOf(c))) return fail('只能塞桌面上同点数的牌');
  }

  const s = cloneState(state);
  const pickupBy = s.pickupBy;

  for (const c of list) removeCard(s.hands[by], c);
  for (const c of list) s.table.push({ by, card: c, kind: 'dump' });

  const taken = s.table.map((e) => e.card);
  s.hands[pickupBy].push(...taken);
  s.table = [];
  s.phase = 'lead';
  s.dumpBy = null;
  s.pickupBy = null;
  s.rev++;

  const events = [
    { type: 'dump', by, cards: list },
    { type: 'pickupDone', by: pickupBy, cards: taken },
  ];

  if (!checkImmediateWin(s, by)) {
    events.push(...refill(s));
  } else {
    events.push({ type: 'win', winner: by, reason: 'empty' });
  }

  return { ok: true, state: s, events };
}

function applyRelay(state, by, card) {
  if (state.phase !== 'relay') return fail('当前不是接力阶段');
  if (by !== state.leader) return fail('还没轮到你接力');
  if (!state.hands[by].includes(card)) return fail('这张牌不在手里');
  if (!tableRanks(state).has(rankOf(card))) return fail('只能接桌面上同点数的牌');

  const s = cloneState(state);
  removeCard(s.hands[by], card);
  s.table.push({ by, card, kind: 'relay' });
  s.phase = 'respond';
  s.rev++;

  const events = [{ type: 'relay', by, card }];
  if (checkImmediateWin(s, by)) events.push({ type: 'win', winner: by, reason: 'empty' });
  return { ok: true, state: s, events };
}

function applyStop(state, by) {
  if (state.phase !== 'relay') return fail('当前不是接力阶段');
  if (by !== state.leader) return fail('还没轮到你停止');

  const s = cloneState(state);
  const discarded = s.table.map((e) => e.card);
  s.discard.push(...discarded);
  s.table = [];

  const from = s.leader;
  s.leader = other(s.leader);
  s.phase = 'lead';
  s.rev++;

  const events = [
    { type: 'stop', by },
    { type: 'discard', cards: discarded },
    { type: 'handover', from, to: s.leader },
    ...refill(s),
  ];
  return { ok: true, state: s, events };
}

function applyResign(state, by) {
  const s = cloneState(state);
  const winner = other(by);
  finish(s, winner, 'resign');
  s.rev++;
  return {
    ok: true,
    state: s,
    events: [
      { type: 'resign', by },
      { type: 'win', winner, reason: 'resign' },
    ],
  };
}

export function applyAction(state, action) {
  if (!state || state.status !== 'playing') return fail('本局已结束');
  if (!action || !PLAYERS.includes(action.by)) return fail('玩家无效');

  switch (action.type) {
    case 'lead': return applyLead(state, action.by, action.card);
    case 'beat': return applyBeat(state, action.by, action.card);
    case 'pickup': return applyPickup(state, action.by);
    case 'relay': return applyRelay(state, action.by, action.card);
    case 'stop': return applyStop(state, action.by);
    case 'dump': return applyDump(state, action.by, action.cards);
    case 'resign': return applyResign(state, action.by);
    default: return fail('未知动作');
  }
}

/* ══════════════ 快照校验 ══════════════ */

export function isValidState(s) {
  if (!s || typeof s !== 'object') return false;
  if (typeof s.seed !== 'string' || !s.seed) return false;
  if (!Number.isInteger(s.round) || s.round < 0) return false;
  if (!Number.isInteger(s.rev) || s.rev < 0) return false;
  if (!Number.isInteger(s.drawIndex) || s.drawIndex < DRAW_START || s.drawIndex > DECK_SIZE) return false;
  if (!SUITS.includes(s.trump)) return false;
  if (!PLAYERS.includes(s.first) || !PLAYERS.includes(s.leader)) return false;
  if (!PHASES.includes(s.phase)) return false;
  if (!s.hands || !Array.isArray(s.hands.host) || !Array.isArray(s.hands.guest)) return false;
  if (!Array.isArray(s.table) || !Array.isArray(s.discard)) return false;
  if (!s.score || !Number.isInteger(s.score.host) || s.score.host < 0) return false;
  if (!Number.isInteger(s.score.guest) || s.score.guest < 0) return false;
  if (s.status !== 'playing' && s.status !== 'ended') return false;

  if (s.status === 'ended') {
    if (s.phase !== 'ended') return false;
    if (!PLAYERS.includes(s.winner)) return false;
    if (!s.reason) return false;
  } else {
    if (s.phase === 'ended') return false;
    if (s.winner) return false;
  }

  const seen = new Set();
  const add = (arr) => {
    for (const c of arr) {
      if (!isCard(c) || seen.has(c)) return false;
      seen.add(c);
    }
    return true;
  };

  if (!add(s.hands.host) || !add(s.hands.guest)) return false;

  for (const e of s.table) {
    if (!e || !PLAYERS.includes(e.by) || !isCard(e.card)) return false;
    if (!['lead', 'beat', 'relay', 'dump'].includes(e.kind)) return false;
    if (seen.has(e.card)) return false;
    seen.add(e.card);
  }

  if (!add(s.discard)) return false;

  const total = s.hands.host.length + s.hands.guest.length
    + s.table.length + s.discard.length + (DECK_SIZE - s.drawIndex);
  if (total !== DECK_SIZE) return false;

  if (s.phase === 'lead') {
    if (s.table.length !== 0) return false;
  } else if (s.phase === 'respond' || s.phase === 'relay') {
    if (s.table.length === 0) return false;
  } else if (s.phase === 'dump') {
    if (s.table.length === 0) return false;
    if (!PLAYERS.includes(s.dumpBy) || !PLAYERS.includes(s.pickupBy)) return false;
    if (s.dumpBy === s.pickupBy) return false;
    if (s.dumpBy !== s.leader) return false;
    if (s.pickupBy !== other(s.leader)) return false;
  }

  return true;
}

export function normalizeState(obj) {
  if (!isValidState(obj)) return null;
  return {
    seed: String(obj.seed),
    round: obj.round,
    rev: obj.rev,
    drawIndex: obj.drawIndex,
    trump: obj.trump,
    first: obj.first,
    leader: obj.leader,
    phase: obj.phase,
    hands: { host: obj.hands.host.slice(), guest: obj.hands.guest.slice() },
    table: obj.table.map((e) => ({ by: e.by, card: e.card, kind: e.kind })),
    discard: obj.discard.slice(),
    score: { host: obj.score.host, guest: obj.score.guest },
    status: obj.status,
    winner: obj.winner || null,
    reason: obj.reason || '',
    dumpBy: obj.dumpBy || null,
    pickupBy: obj.pickupBy || null,
  };
}
