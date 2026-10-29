/**
 * 对花 · 双人联机
 *
 * 架构与五子棋一致：两端浏览器通过公共 MQTT 中转交换 JSON，
 * 没有后端。发牌由 roomId + round 确定性推导，所以「再来一局」
 * 只需要双方本地 round + 1，不用广播快照。
 */

import mqtt from './vendor/mqtt.esm.js';
import {
  SUITS, SUIT_GLYPHS,
  other, suitOf, rankOf, rankValue, rankLabel, isRed, cardName,
  legalFor, legalBeats, legalRelays, legalDumps,
  tableRankList, actorOf, applyAction, newGame, normalizeState,
  deckLeft, deriveRound,
} from './rules.js';

/* ══════════════ 配置 ══════════════ */

const BROKER = 'wss://broker.emqx.io:8084/mqtt';
const TOPIC_PREFIX = 'duihua/v1/';
const PROTO = 1;
const PING_MS = 5000;
const PEER_TIMEOUT_MS = 14000;
const REQUEST_TIMEOUT_MS = 20000;
const STORAGE_KEY = 'duihua.session.v1';
const DEBUG = new URLSearchParams(location.search).has('debug');

/* ══════════════ 工具 ══════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const safe = (fn) => { try { fn(); } catch (e) { console.error(e); } };

const randId = (n = 12) => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
};

const traceLog = [];
function trace(dir, t) {
  traceLog.push(`${dir}${t}`);
  if (traceLog.length > 120) traceLog.shift();
}

/* ══════════════ DOM ══════════════ */

const el = {
  screens: {
    home: $('#screen-home'),
    lobby: $('#screen-lobby'),
    game: $('#screen-game'),
  },
  btnCreate: $('#btn-create'),
  btnResume: $('#btn-resume'),
  btnRules: $('#btn-rules'),
  shareLink: $('#share-link'),
  btnCopy: $('#btn-copy'),
  lobbyStatus: $('#lobby-status'),
  roomChip: $('#room-chip'),
  lobbyTrump: $('#lobby-trump'),
  lobbyFirst: $('#lobby-first'),
  btnLeaveLobby: $('#btn-leave-lobby'),

  cardOpp: $('#card-opp'),
  oppTag: $('#opp-tag'),
  oppCount: $('#opp-count'),
  hudTrump: $('#hud-trump'),
  hudScore: $('#hud-score'),
  btnMenu: $('#btn-menu'),
  hudRound: $('#hud-round'),
  hudDeck: $('#hud-deck'),
  hudDiscard: $('#hud-discard'),
  hudPhase: $('#hud-phase'),

  tableScroll: $('#table-scroll'),
  tableCards: $('#table-cards'),
  tableEmpty: $('#table-empty'),
  nChips: $('#n-chips'),
  tableHint: $('#table-hint'),
  btnLog: $('#btn-log'),

  handScroll: $('#hand-scroll'),
  hand: $('#hand'),
  handTitle: $('#hand-title'),
  handCount: $('#hand-count'),
  btnExpand: $('#btn-expand'),

  actionBar: $('#action-bar'),
  turnBanner: $('#turn-banner'),

  overlay: $('#overlay'),
  dialogTitle: $('#dialog-title'),
  dialogText: $('#dialog-text'),
  dialogExtra: $('#dialog-extra'),
  dialogActions: $('#dialog-actions'),

  handSheet: $('#hand-sheet'),
  btnSheetClose: $('#btn-sheet-close'),
  sheetGrid: $('#sheet-grid'),
  sheetFoot: $('#sheet-foot'),

  toastWrap: $('#toast-wrap'),
};

/* ══════════════ 状态 ══════════════ */

const S = {
  session: null,
  game: null,
  net: null,
  conn: 'idle',
  peerId: null,
  guestId: null,
  peerSeen: 0,
  mySeq: 0,
  lastSeq: Object.create(null),
  pending: null,
  resultKey: null,
  sel: null,
  dumpSel: new Set(),
  log: [],
  syncTick: 0,
  sheetOpen: false,
  lastPhaseKey: '',
  handReset: true,
};

let currentScreen = 'home';
let dialogOpen = false;

/* ══════════════ 屏幕 ══════════════ */

function showScreen(name) {
  if (currentScreen === name) return;
  currentScreen = name;
  for (const [key, node] of Object.entries(el.screens)) {
    node.classList.toggle('hidden', key !== name);
  }
  if (name === 'game') {
    requestAnimationFrame(() => {
      el.tableScroll.scrollLeft = el.tableScroll.scrollWidth;
    });
  }
  if (name === 'home') refreshResumeButton();
}

/* ══════════════ 弹窗 / Toast ══════════════ */

function dialog({ title, text = '', actions = [], extra = null, dismissible = false }) {
  el.dialogTitle.textContent = title;
  el.dialogText.textContent = text;
  el.dialogText.classList.toggle('hidden', !text);
  el.dialogExtra.replaceChildren();
  if (extra) el.dialogExtra.appendChild(extra);

  el.dialogActions.replaceChildren();
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${action.kind || 'primary'}`;
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      if (!action.keepOpen) closeDialog();
      action.onClick?.();
    });
    el.dialogActions.appendChild(btn);
  }

  el.overlay.classList.remove('hidden');
  el.overlay.dataset.dismissible = dismissible ? '1' : '0';
  dialogOpen = true;
}

function closeDialog() {
  el.overlay.classList.add('hidden');
  dialogOpen = false;
}

el.overlay.addEventListener('click', (e) => {
  if (e.target === el.overlay && el.overlay.dataset.dismissible === '1') closeDialog();
});

function toast(text, ms = 2000) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = text;
  el.toastWrap.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 320);
  }, ms);
}

/* ══════════════ 房间与身份 ══════════════ */

function mySide() { return S.session?.role ?? 'host'; }
function oppSide() { return other(mySide()); }

function peerOnline() {
  return S.peerId !== null && Date.now() - S.peerSeen < PEER_TIMEOUT_MS;
}

function buildShareLink() {
  const base = location.origin + location.pathname;
  return `${base}#r=${S.session.roomId}`;
}

function renderRoomMeta() {
  if (!S.session) return;
  el.roomChip.textContent = '房间 ' + S.session.roomId.slice(0, 6).toUpperCase();

  const round = S.game?.round ?? 0;
  const d = deriveRound(S.session.roomId, round);
  const trump = S.game?.trump ?? d.trump;
  const first = S.game?.first ?? d.first;

  el.lobbyTrump.textContent = '主花色 ' + SUIT_GLYPHS[trump];
  el.lobbyTrump.classList.toggle('red', trump === 'H' || trump === 'D');
  el.lobbyFirst.textContent = first === S.session.role ? '你先手' : '对手先手';
}

/* ══════════════ 持久化 ══════════════ */

function savePersist() {
  if (!S.session) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ session: S.session, game: S.game }));
  } catch {}
}

function loadPersist() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!raw || !raw.session?.roomId) return null;
    return raw;
  } catch {
    return null;
  }
}

function clearPersist() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

function refreshResumeButton() {
  const stored = loadPersist();
  el.btnResume.classList.toggle('hidden', !stored?.session);
}

/* ══════════════ 建房 / 进房 / 离开 ══════════════ */

function hostRoom() {
  S.session = { roomId: randId(20), role: 'host', playerId: randId(12) };
  S.game = null;
  S.guestId = null;
  S.peerId = null;
  S.peerSeen = 0;
  S.lastSeq = Object.create(null);
  S.mySeq = 0;
  S.pending = null;
  S.resultKey = null;
  S.sel = null;
  S.dumpSel.clear();
  S.log = [];
  S.handReset = true;

  savePersist();
  history.replaceState(null, '', `#r=${S.session.roomId}`);
  el.shareLink.value = buildShareLink();
  renderRoomMeta();
  showScreen('lobby');
  setConn('connecting');
  connect();
}

function joinRoom(roomId) {
  const stored = loadPersist();
  const same = stored?.session?.roomId === roomId;

  S.session = same
    ? { ...stored.session }
    : { roomId, role: 'guest', playerId: randId(12) };

  S.game = same && stored.game ? normalizeState(stored.game) : null;
  if (S.game && S.game.seed !== roomId) S.game = null;

  S.guestId = null;
  S.peerId = null;
  S.peerSeen = 0;
  S.lastSeq = Object.create(null);
  S.mySeq = 0;
  S.pending = null;
  S.resultKey = null;
  S.sel = null;
  S.dumpSel.clear();
  S.log = [];
  S.handReset = true;

  savePersist();
  history.replaceState(null, '', `#r=${roomId}`);
  el.shareLink.value = buildShareLink();
  renderRoomMeta();

  if (S.game) {
    showScreen('game');
    renderAll();
    maybeShowResult();
  } else {
    showScreen('lobby');
    el.lobbyStatus.textContent = S.session.role === 'host' ? '正在恢复房间…' : '正在进入房间…';
  }

  setConn('connecting');
  connect();
}

function leaveRoom() {
  endPresence();
  disconnect();
  clearPersist();

  S.session = null;
  S.game = null;
  S.peerId = null;
  S.guestId = null;
  S.pending = null;
  S.resultKey = null;
  S.sel = null;
  S.dumpSel.clear();
  S.log = [];

  closeSheet();
  closeDialog();
  history.replaceState(null, '', location.pathname);
  showScreen('home');
  refreshResumeButton();
  startPresence();
}

function confirmLeave() {
  dialog({
    title: '离开房间？',
    text: '离开后本局结束，房间和比分都会清空。',
    actions: [
      { label: '离开', kind: 'danger', onClick: leaveRoom },
      { label: '留下', kind: 'ghost' },
    ],
  });
}

/* ══════════════ 连接状态 ══════════════ */

function setConn(state) {
  S.conn = state;

  if (currentScreen === 'lobby') {
    const map = {
      connecting: '正在连接服务器…',
      online: S.peerId ? '对手已进入，准备开始' : '等待对手加入…',
      offline: '连接断开，正在重连…',
      idle: '未连接',
    };
    el.lobbyStatus.textContent = map[state] || '';
  }

  if (S.game) {
    renderHud();
    renderActions();
    renderTableHint();
  }
}

/* ══════════════ MQTT ══════════════ */

function send(msg) {
  if (!S.net || !S.net.connected || !S.session) {
    trace('✗', msg.t);
    return false;
  }
  const payload = { ...msg, from: S.session.playerId, seq: ++S.mySeq };
  S.net.publish(TOPIC_PREFIX + S.session.roomId, JSON.stringify(payload), { qos: 1 });
  trace('→', msg.t);
  return true;
}

function connect() {
  if (!S.session) return;
  disconnect();

  setConn('connecting');

  const client = mqtt.connect(BROKER, {
    clientId: 'dh_' + S.session.playerId,
    clean: true,
    keepalive: 25,
    reconnectPeriod: 2500,
    connectTimeout: 15000,
    protocolVersion: 4,
  });

  S.net = client;

  client.on('connect', () => {
    setConn('online');
    client.subscribe(TOPIC_PREFIX + S.session.roomId, { qos: 1 }, (err) => {
      if (err) { setConn('offline'); return; }
      send({ t: 'hello', proto: PROTO, role: S.session.role });
      if (S.game) setTimeout(() => { if (S.net === client) sendState(); }, 500);
    });
  });

  client.on('reconnect', () => setConn('connecting'));
  client.on('offline', () => setConn('offline'));
  client.on('error', (err) => {
    console.warn('[mqtt]', err?.message);
    setConn('offline');
  });

  client.on('message', (_topic, payload) => {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    handleMessage(msg);
  });
}

function disconnect() {
  if (S.net) {
    safe(() => S.net.end(true));
    S.net = null;
  }
}

function sendState() {
  if (!S.game) return;
  send({ t: 'state', ...S.game });
}

function handleMessage(msg) {
  if (!msg || !S.session || msg.from === S.session.playerId) return;
  trace('←', msg.t);

  if (msg.t === 'hello') { onHello(msg); return; }
  if (msg.t === 'full') { onRoomFull(msg); return; }

  // 晚加入的一方可能错过了对方的 hello。
  // 整盘快照是幂等的，允许它反过来确立对手身份。
  if (msg.from !== S.peerId) {
    if (msg.t === 'state' && !S.peerId) {
      S.peerId = msg.from;
      S.peerSeen = Date.now();
      S.lastSeq[msg.from] = -1;
    } else {
      return;
    }
  }

  const seen = S.lastSeq[msg.from] ?? -1;
  if (typeof msg.seq === 'number') {
    if (msg.seq <= seen) return;
    S.lastSeq[msg.from] = msg.seq;
  }

  S.peerSeen = Date.now();

  switch (msg.t) {
    case 'state': onRemoteState(msg); break;
    case 'lead':
    case 'beat':
    case 'pickup':
    case 'relay':
    case 'stop':
    case 'dump':
    case 'resign':
      onRemoteAction(msg);
      break;
    case 'restart-req': onRestartRequest(msg); break;
    case 'restart-ack': onAck(msg); break;
    case 'ping': break;
    default: break;
  }
}

function onHello(msg) {
  if (!S.session) return;
  if (msg.proto !== PROTO) return;
  if (msg.role === S.session.role) return; // 同角色：可能是自己另一个标签页

  if (S.session.role === 'host') {
    if (S.guestId && S.guestId !== msg.from) {
      send({ t: 'full', to: msg.from });
      return;
    }
    S.guestId = msg.from;
  }

  S.lastSeq[msg.from] = -1; // 对方重连，序号从头计
  S.peerId = msg.from;
  S.peerSeen = Date.now();

  if (currentScreen === 'lobby') {
    el.lobbyStatus.textContent = '对手已进入，准备开始';
  }

  setConn(S.conn);

  if (S.game) {
    if (currentScreen !== 'game') {
      showScreen('game');
      renderAll();
    }
    sendState();
    if (S.game.status === 'ended') maybeShowResult();
  } else if (S.session.role === 'host') {
    startRound(0, true);
  }
}

function onRoomFull(msg) {
  if (msg?.to && msg.to !== S.session?.playerId) return;

  endPresence();
  disconnect();
  clearPersist();

  S.session = null;
  S.game = null;
  S.peerId = null;
  S.guestId = null;
  S.pending = null;
  S.sel = null;
  S.dumpSel.clear();
  S.log = [];

  closeSheet();
  closeDialog();
  history.replaceState(null, '', location.pathname);
  showScreen('home');
  refreshResumeButton();

  dialog({
    title: '房间已满',
    text: '这个房间已经有两个人了。让朋友新建一个房间再发给你吧。',
    actions: [{ label: '好的', kind: 'ghost' }],
  });

  startPresence();
}

/* ══════════════ 整盘快照 ══════════════ */

function onRemoteState(msg) {
  const incoming = normalizeState(msg);
  if (!incoming) { trace('!', 'bad-state'); return; }
  if (!S.session || incoming.seed !== S.session.roomId) return;

  const cur = S.game;
  let adopt = !cur;

  if (cur) {
    if (incoming.round < cur.round) return;

    if (incoming.round === cur.round) {
      if (incoming.rev < cur.rev) return;
      if (incoming.rev === cur.rev) {
        if (JSON.stringify(incoming) === JSON.stringify(cur)) return;
        if (S.session.role === 'host') return; // 同版本冲突以房主为准
        adopt = true;
      } else {
        adopt = true;
      }
    } else {
      adopt = true;
    }
  }

  if (!adopt) return;

  const roundChanged = !cur || incoming.round !== cur.round;
  if (roundChanged) {
    S.log = [];
    S.resultKey = null;
    S.handReset = true;
    clearPending(false);
  }

  S.game = incoming;
  S.sel = null;
  S.dumpSel.clear();
  savePersist();

  if (currentScreen !== 'game') showScreen('game');
  if (roundChanged || incoming.status !== 'ended') closeDialog();
  renderAll();
  maybeShowResult();
}

/* ══════════════ 开局 / 再来一局 ══════════════ */

function startRound(round, broadcast = false) {
  if (!S.session) return;

  const score = S.game?.score ?? { host: 0, guest: 0 };
  S.game = newGame(S.session.roomId, round, score);
  S.resultKey = null;
  S.sel = null;
  S.dumpSel.clear();
  S.log = [];
  S.handReset = true;
  clearPending(false);
  closeSheet();
  closeDialog();

  savePersist();
  if (broadcast && S.session.role === 'host') sendState();

  showScreen('game');
  renderAll();
}

function requestRestart() {
  if (!S.game) return;
  sendState();
  send({ t: 'restart-req', round: S.game.round });
  setPending('restart');

  dialog({
    title: '等待对手同意…',
    text: '对方接受后开始新一局，分数保留。',
    actions: [{
      label: '取消',
      kind: 'ghost',
      onClick: () => { clearPending(false); showResultDialog(); },
    }],
  });
}

function onRestartRequest(msg) {
  if (!S.game) return;
  if (msg.round !== S.game.round) return;

  // 先把本局结束状态推过去，确保双方比分/胜负一致，再问是否再来一局
  sendState();

  dialog({
    title: '对方想再来一局',
    text: '接受后立刻开始新一局，分数保留。',
    actions: [
      {
        label: '来！',
        kind: 'primary',
        onClick: () => {
          send({ t: 'restart-ack', ok: true, round: S.game.round });
          startRound((S.game?.round ?? 0) + 1, false);
        },
      },
      {
        label: '不打了',
        kind: 'ghost',
        onClick: () => send({ t: 'restart-ack', ok: false, round: S.game.round }),
      },
    ],
  });
}

function setPending(kind) {
  clearPending(false);
  S.pending = {
    kind,
    timer: setTimeout(() => {
      S.pending = null;
      closeDialog();
      toast('对方没有回应');
      if (S.game?.status === 'ended') showResultDialog();
    }, REQUEST_TIMEOUT_MS),
  };
}

function clearPending(notify = false) {
  if (!S.pending) return;
  clearTimeout(S.pending.timer);
  S.pending = null;
  if (notify) toast('请求已取消');
}

function onAck(msg) {
  if (!S.pending || S.pending.kind !== 'restart') return;
  if (S.game && msg.round !== S.game.round) return;
  clearPending(false);
  closeDialog();

  if (!msg.ok) {
    toast('对方暂时不想再来一局');
    if (S.game?.status === 'ended') showResultDialog();
    return;
  }

  startRound((S.game?.round ?? 0) + 1, false);
}

/* ══════════════ 动作 ══════════════ */

function sendAction(action) {
  const msg = { t: action.type, round: S.game.round };
  if (action.card !== undefined) msg.card = action.card;
  if (action.cards !== undefined) msg.cards = action.cards;
  send(msg);
}

function doAction(action, { force = false } = {}) {
  if (!S.game || S.game.status !== 'playing' || !S.session) return false;
  if (!force && !peerOnline()) { toast('对手还没连上'); return false; }
  if (action.by !== mySide()) return false;

  const res = applyAction(S.game, action);
  if (!res.ok) { toast(res.error || '操作无效'); return false; }

  S.game = res.state;
  S.sel = null;
  S.dumpSel.clear();
  savePersist();
  sendAction(action);

  if (navigator.vibrate) safe(() => navigator.vibrate(8));

  handleEvents(res.events);
  renderAll();
  maybeShowResult();
  return true;
}

function onRemoteAction(msg) {
  if (!S.game || S.game.status !== 'playing') return;
  if (msg.round !== S.game.round) return;

  const action = { type: msg.t, by: oppSide() };
  if (msg.t === 'lead' || msg.t === 'beat' || msg.t === 'relay') action.card = msg.card;
  if (msg.t === 'dump') action.cards = msg.cards;

  const res = applyAction(S.game, action);
  if (!res.ok) { trace('!', `${msg.t}:${res.error}`); return; }

  S.game = res.state;
  S.sel = null;
  S.dumpSel.clear();
  savePersist();
  handleEvents(res.events);
  renderAll();
  maybeShowResult();
}

function selectCard(card) {
  if (!S.game || S.game.status !== 'playing') return;
  if (!peerOnline()) return;

  const legal = legalFor(S.game, mySide());
  if (!legal || !legal.cards.includes(card)) return;

  if (S.game.phase === 'dump') {
    if (S.dumpSel.has(card)) S.dumpSel.delete(card);
    else S.dumpSel.add(card);
    renderHand();
    renderActions();
    if (S.sheetOpen) renderSheet();
    return;
  }

  S.sel = S.sel === card ? null : card;
  renderHand();
  renderActions();
  if (S.sheetOpen) closeSheet();
}

function confirmAction() {
  if (!S.game || S.game.status !== 'playing') return;

  if (S.game.phase === 'dump') {
    doAction({ type: 'dump', by: mySide(), cards: [...S.dumpSel] });
    return;
  }

  if (!S.sel) return;
  const type = { lead: 'lead', respond: 'beat', relay: 'relay' }[S.game.phase];
  if (!type) return;
  doAction({ type, by: mySide(), card: S.sel });
}

function doPickup() {
  if (!S.game || S.game.phase !== 'respond') return;

  const beats = legalBeats(S.game, mySide());
  if (beats.length) {
    dialog({
      title: '确定捡牌？',
      text: '你还有能压的牌。捡牌后对手可以塞牌。',
      actions: [
        { label: '确定捡牌', kind: 'danger', onClick: () => doAction({ type: 'pickup', by: mySide() }) },
        { label: '再想想', kind: 'ghost' },
      ],
    });
  } else {
    doAction({ type: 'pickup', by: mySide() });
  }
}

function doStop() {
  if (S.game?.phase === 'relay') doAction({ type: 'stop', by: mySide() });
}

function doDump(cards) {
  if (S.game?.phase === 'dump') doAction({ type: 'dump', by: mySide(), cards });
}

function requestResign() {
  if (!S.game || S.game.status !== 'playing') return;

  dialog({
    title: '确认认输？',
    text: '认输后本局判对方获胜，比分 +1。',
    actions: [
      {
        label: '确认认输',
        kind: 'danger',
        onClick: () => doAction({ type: 'resign', by: mySide() }, { force: true }),
      },
      { label: '再想想', kind: 'ghost' },
    ],
  });
}

/* ══════════════ 事件 → 日志 / 提示 ══════════════ */

function who(p) {
  return p === mySide() ? '你' : '对手';
}

function formatEvent(e) {
  switch (e.type) {
    case 'lead': return `${who(e.by)} 领出 ${cardName(e.card)}`;
    case 'beat': return `${who(e.by)} 压 ${cardName(e.card)}`;
    case 'relay': return `${who(e.by)} 接力 ${cardName(e.card)}`;
    case 'stop': return `${who(e.by)} 停止接力`;
    case 'discard': return `桌上 ${e.cards.length} 张进弃牌堆`;
    case 'pickup': return `${who(e.by)} 捡牌`;
    case 'dump':
      return e.cards.length
        ? `${who(e.by)} 塞 ${e.cards.length} 张：${e.cards.map(cardName).join(' ')}`
        : `${who(e.by)} 不塞牌`;
    case 'pickupDone': return `${who(e.by)} 收下 ${e.cards.length} 张`;
    case 'refill': {
      const me = mySide();
      return `补牌：你 +${e.draws[me]}，对手 +${e.draws[other(me)]}`;
    }
    case 'handover': return `换手，${who(e.to)} 领出`;
    case 'resign': return `${who(e.by)} 认输`;
    case 'win':
      return e.reason === 'resign'
        ? `${who(e.winner)} 获胜（对方认输）`
        : `${who(e.winner)} 出完手牌，获胜`;
    default: return '';
  }
}

function handleEvents(events) {
  for (const e of events) {
    const line = formatEvent(e);
    if (line) {
      S.log.push(line);
      if (S.log.length > 80) S.log.shift();
    }

    if (e.type === 'pickup') toast(`${who(e.by)}捡牌`);
    else if (e.type === 'dump' && e.cards.length) toast(`${who(e.by)}塞了 ${e.cards.length} 张`);
    else if (e.type === 'resign') toast(`${who(e.by)}认输`);
  }
}

/* ══════════════ 渲染 ══════════════ */

function renderAll() {
  if (!S.game) return;
  renderHud();
  renderTable();
  renderHand();
  renderActions();
  renderTableHint();
  if (S.sheetOpen) renderSheet();
  flashBannerIfChanged();
}

function phaseLabel() {
  const g = S.game;
  if (!g) return '';
  if (!peerOnline()) return '对手掉线中';
  if (g.status === 'ended') return '本局结束';

  const me = mySide();
  if (g.phase === 'lead') return g.leader === me ? '轮到你领出' : '对手领出';
  if (g.phase === 'respond') return g.leader === me ? '等待对手压牌' : '轮到你压牌';
  if (g.phase === 'relay') return g.leader === me ? '你可以接力或停止' : '等待对手接力';
  if (g.phase === 'dump') return g.dumpBy === me ? '你可以塞牌' : '等待对手塞牌';
  return '';
}

function renderHud() {
  const g = S.game;
  if (!g) return;

  const me = mySide();
  const opp = oppSide();
  const online = peerOnline();
  const actor = actorOf(g);

  el.oppCount.textContent = g.hands[opp].length;
  el.oppTag.textContent = !online ? '掉线中' : (g.status === 'playing' && actor === opp ? '思考中' : '');
  el.oppTag.classList.toggle('warn', !online);

  el.hudTrump.textContent = SUIT_GLYPHS[g.trump] + ' 主';
  el.hudTrump.classList.toggle('red', g.trump === 'H' || g.trump === 'D');
  el.hudScore.textContent = `${g.score[me]} : ${g.score[opp]}`;
  el.hudRound.textContent = `第 ${g.round + 1} 局`;
  el.hudDeck.textContent = `牌堆 ${deckLeft(g)}`;
  el.hudDiscard.textContent = `弃牌 ${g.discard.length}`;
  el.hudPhase.textContent = phaseLabel();
}

function renderTable() {
  const g = S.game;
  if (!g) return;

  el.tableCards.replaceChildren();
  el.nChips.replaceChildren();

  for (const r of tableRankList(g)) {
    const chip = document.createElement('span');
    chip.className = 'n-chip';
    chip.textContent = rankLabel(r);
    el.nChips.appendChild(chip);
  }

  if (!g.table.length) {
    el.tableEmpty.classList.remove('hidden');
  } else {
    el.tableEmpty.classList.add('hidden');
    const last = g.table.length - 1;
    g.table.forEach((e, i) => {
      const item = document.createElement('div');
      item.className = 'table-item' + (i === last ? ' current' : '');
      const mini = miniCardEl(e.card);
      const label = document.createElement('span');
      label.className = 'table-label';
      label.textContent = `${kindLabel(e.kind)} · ${who(e.by)}`;
      item.append(mini, label);
      el.tableCards.appendChild(item);
    });
  }

  requestAnimationFrame(() => {
    el.tableScroll.scrollLeft = el.tableScroll.scrollWidth;
  });
}

function kindLabel(kind) {
  return { lead: '领出', beat: '压', relay: '接', dump: '塞' }[kind] || kind;
}

function renderTableHint() {
  const g = S.game;
  if (!g) return;

  const me = mySide();

  if (!peerOnline()) {
    el.tableHint.textContent = '对手掉线中，等待重连…';
    return;
  }
  if (g.status === 'ended') {
    el.tableHint.textContent = '本局结束。';
    return;
  }
  if (g.phase === 'lead') {
    el.tableHint.textContent = g.leader === me
      ? '选一张牌领出，任意牌都可以。'
      : '等待对手领出…';
    return;
  }
  if (g.phase === 'respond') {
    if (g.leader === me) {
      el.tableHint.textContent = '对手正在压你的牌…';
      return;
    }
    const beats = legalBeats(g, me);
    el.tableHint.textContent = beats.length
      ? '出同花色更大的牌，或用主花色毙；也可以捡牌。'
      : '没有能压的牌，只能捡牌。';
    return;
  }
  if (g.phase === 'relay') {
    if (g.leader !== me) {
      el.tableHint.textContent = '等待对手接力…';
      return;
    }
    const relays = legalRelays(g, me);
    el.tableHint.textContent = relays.length
      ? `可接点数：${tableRankList(g).map(rankLabel).join(' / ')}；也可以停止接力。`
      : '没有可接的牌，只能停止接力。';
    return;
  }
  if (g.phase === 'dump') {
    if (g.dumpBy !== me) {
      el.tableHint.textContent = '对手正在决定是否塞牌…';
      return;
    }
    const dumps = legalDumps(g, me);
    el.tableHint.textContent = dumps.length
      ? `可塞点数：${tableRankList(g).map(rankLabel).join(' / ')}；可以只塞一部分。`
      : '没有可塞的牌，点“不塞”继续。';
  }
}

function sortHand(hand, trump) {
  const order = [trump, ...SUITS.filter((s) => s !== trump)];
  return hand.slice().sort((a, b) => {
    const sa = order.indexOf(suitOf(a));
    const sb = order.indexOf(suitOf(b));
    if (sa !== sb) return sa - sb;
    return rankValue(a) - rankValue(b);
  });
}

function cardEl(card, { legal = false, dim = false, selected = false, corner = false } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  if (isRed(card)) btn.classList.add('red');
  if (S.game && suitOf(card) === S.game.trump) btn.classList.add('trump');
  if (legal) btn.classList.add('legal');
  if (dim) btn.classList.add('dim');
  if (selected) btn.classList.add('selected');
  if (corner) btn.classList.add('corner');
  btn.dataset.card = card;
  btn.disabled = dim;
  btn.setAttribute('aria-label', cardName(card));

  const rank = document.createElement('span');
  rank.className = 'rank';
  rank.textContent = rankLabel(rankOf(card));

  const suit = document.createElement('span');
  suit.className = 'suit';
  suit.textContent = SUIT_GLYPHS[suitOf(card)];

  btn.append(rank, suit);
  return btn;
}

function miniCardEl(card) {
  const div = document.createElement('div');
  div.className = 'mini-card';
  if (isRed(card)) div.classList.add('red');
  if (S.game && suitOf(card) === S.game.trump) div.classList.add('trump');

  const rank = document.createElement('span');
  rank.className = 'rank';
  rank.textContent = rankLabel(rankOf(card));

  const suit = document.createElement('span');
  suit.className = 'suit';
  suit.textContent = SUIT_GLYPHS[suitOf(card)];

  div.append(rank, suit);
  return div;
}

function renderHand() {
  const g = S.game;
  if (!g) return;

  const me = mySide();
  const hand = sortHand(g.hands[me], g.trump);
  const legal = legalFor(g, me);
  const online = peerOnline();
  const legalSet = new Set(legal?.cards ?? []);

  if (S.sel && !legalSet.has(S.sel)) S.sel = null;
  for (const c of [...S.dumpSel]) if (!legalSet.has(c)) S.dumpSel.delete(c);

  const keep = S.handReset ? 0 : el.handScroll.scrollLeft;
  if (S.handReset) S.handReset = false;

  el.hand.replaceChildren();

  if (!hand.length) {
    const empty = document.createElement('div');
    empty.className = 'table-empty';
    empty.textContent = '手牌已出完';
    el.hand.appendChild(empty);
  } else {
    const showLegal = g.phase !== 'lead';
    for (const card of hand) {
      const isLegal = !!legal && online && legalSet.has(card);
      const btn = cardEl(card, {
        legal: showLegal && isLegal,
        dim: !isLegal,
        selected: S.sel === card || S.dumpSel.has(card),
        corner: true,
      });
      el.hand.appendChild(btn);
    }
  }

  el.handCount.textContent = `${g.hands[me].length} 张`;

  requestAnimationFrame(() => {
    el.handScroll.scrollLeft = Math.min(keep, el.handScroll.scrollWidth);
  });
}

function addAction(label, kind, onClick, disabled = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn ${kind}`;
  btn.textContent = label;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  el.actionBar.appendChild(btn);
}

function waitText(text) {
  const span = document.createElement('span');
  span.className = 'wait-text';
  span.textContent = text;
  return span;
}

function renderActions() {
  el.actionBar.replaceChildren();

  const g = S.game;
  if (!g) return;

  const me = mySide();

  if (g.status === 'ended') {
    addAction('再来一局', 'primary', requestRestart);
    addAction('离开房间', 'ghost', confirmLeave);
    return;
  }

  if (!peerOnline()) {
    el.actionBar.appendChild(waitText('对手掉线中，等待重连…'));
    return;
  }

  if (actorOf(g) !== me) {
    el.actionBar.appendChild(waitText('等待对手…'));
    return;
  }

  if (g.phase === 'lead') {
    addAction('出牌', 'primary', confirmAction, !S.sel);
  } else if (g.phase === 'respond') {
    const beats = legalBeats(g, me);
    if (beats.length) {
      addAction('压', 'primary', confirmAction, !S.sel);
      addAction('捡牌', 'ghost', doPickup);
    } else {
      addAction('捡牌', 'primary', doPickup);
    }
  } else if (g.phase === 'relay') {
    const relays = legalRelays(g, me);
    if (relays.length) {
      addAction('接力', 'primary', confirmAction, !S.sel);
      addAction('停止接力', 'ghost', doStop);
    } else {
      addAction('停止接力', 'primary', doStop);
    }
  } else if (g.phase === 'dump') {
    const dumps = legalDumps(g, me);
    if (dumps.length) {
      addAction(S.dumpSel.size ? `塞 ${S.dumpSel.size} 张` : '塞牌', 'primary', confirmAction, S.dumpSel.size === 0);
      addAction('不塞', 'ghost', () => doDump([]));
    } else {
      addAction('不塞', 'primary', () => doDump([]));
    }
  }
}

function flashBannerIfChanged() {
  const g = S.game;
  if (!g) return;

  const key = `${g.round}:${g.status}:${g.phase}:${g.leader}:${g.dumpBy}`;
  if (S.lastPhaseKey === key) return;
  S.lastPhaseKey = key;

  const text = phaseLabel();
  if (!text) return;

  el.turnBanner.textContent = text;
  el.turnBanner.classList.add('show');
  clearTimeout(el.turnBanner._t);
  el.turnBanner._t = setTimeout(() => el.turnBanner.classList.remove('show'), 1600);
}

/* ══════════════ 手牌展开 ══════════════ */

function openSheet() {
  S.sheetOpen = true;
  renderSheet();
  el.handSheet.classList.remove('hidden');
}

function closeSheet() {
  S.sheetOpen = false;
  el.handSheet.classList.add('hidden');
}

function renderSheet() {
  const g = S.game;
  if (!g) return;

  const me = mySide();
  const hand = sortHand(g.hands[me], g.trump);
  const legal = legalFor(g, me);
  const online = peerOnline();
  const legalSet = new Set(legal?.cards ?? []);

  el.sheetGrid.replaceChildren();

  for (const card of hand) {
    const isLegal = !!legal && online && legalSet.has(card);
    const btn = cardEl(card, {
      legal: g.phase !== 'lead' && isLegal,
      dim: !isLegal,
      selected: S.sel === card || S.dumpSel.has(card),
    });
    el.sheetGrid.appendChild(btn);
  }

  el.sheetFoot.replaceChildren();

  const info = document.createElement('span');
  info.textContent = g.phase === 'dump'
    ? `已选 ${S.dumpSel.size} 张`
    : '点牌选择，关闭后确认';
  el.sheetFoot.appendChild(info);

  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn tiny primary';
  done.textContent = '完成';
  done.addEventListener('click', closeSheet);
  el.sheetFoot.appendChild(done);
}

/* ══════════════ 结算 ══════════════ */

function maybeShowResult() {
  const g = S.game;
  if (!g || g.status !== 'ended') return;

  const key = `${g.round}:${g.winner}:${g.reason}`;
  if (S.resultKey === key) return;
  S.resultKey = key;

  setTimeout(() => {
    if (!S.game || S.game.status !== 'ended') return;
    showResultDialog();
  }, 850);
}

function resultHand(title, cards) {
  const wrap = document.createElement('div');
  wrap.className = 'result-hand';

  const h = document.createElement('h4');
  h.textContent = `${title}（${cards.length} 张）`;
  wrap.appendChild(h);

  if (!cards.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '已出完';
    wrap.appendChild(empty);
  } else {
    const row = document.createElement('div');
    row.className = 'cards';
    for (const c of cards) row.appendChild(miniCardEl(c));
    wrap.appendChild(row);
  }

  return wrap;
}

function showResultDialog() {
  const g = S.game;
  if (!g || g.status !== 'ended') return;

  const me = mySide();
  const opp = oppSide();
  const won = g.winner === me;

  const title = won ? '你赢了' : '你输了';
  const reasonText = g.reason === 'resign'
    ? (won ? '对手认输了。' : '你认输了。')
    : (won ? '你先出完了手牌。' : '对手先出完了手牌。');

  const text = `${reasonText}\n本房间比分：你 ${g.score[me]} : ${g.score[opp]} 对手`;

  const extra = document.createElement('div');
  extra.className = 'result-hands';
  extra.appendChild(resultHand('你的手牌', g.hands[me]));
  extra.appendChild(resultHand('对手的手牌', g.hands[opp]));

  closeSheet();

  dialog({
    title,
    text,
    extra,
    dismissible: false,
    actions: [
      { label: '再来一局', kind: 'primary', onClick: requestRestart },
      { label: '离开房间', kind: 'ghost', onClick: confirmLeave },
    ],
  });
}

/* ══════════════ 玩法 / 记录 / 菜单 ══════════════ */

function showRules() {
  const div = document.createElement('div');
  div.className = 'rules';
  div.innerHTML = `
    <h4>目标</h4>
    <p>牌堆摸完后，先出完手牌的一方获胜。</p>

    <h4>准备</h4>
    <p>52 张牌，随机主花色；每人 10 张，牌堆 32 张；随机决定先手。</p>

    <h4>牌力</h4>
    <p>2 &lt; 3 &lt; … &lt; A。主花色大于任意副花色；主花色之间比点数；主花色 A 无敌。</p>

    <h4>一个回合</h4>
    <ul>
      <li><b>领出</b>：领出方出任意一张牌。</li>
      <li><b>压</b>：防守方出同花色更大的牌，或用任意主花色毙；主花色领出时只能出更大的主花色。</li>
      <li><b>接力</b>：压住后，领出方可出任意一张“点数在桌面上出现过”的牌，也可以停止。</li>
      <li><b>捡牌</b>：防守方压不住（或主动）捡走桌面所有牌；领出方可把手里同点数的牌塞给对手，塞的牌不能压。</li>
      <li><b>补牌</b>：回合结束，领出方先补到 10，牌堆不足摸完为止。</li>
    </ul>

    <h4>胜负</h4>
    <p>牌堆空后，手牌为 0 立即胜。最后一张打出即胜，最后一压也即胜。每局胜者 +1 分，分数跨局保留。</p>
  `;
  dialog({ title: '玩法', extra: div, actions: [{ label: '知道了', kind: 'primary' }] });
}

function showLog() {
  const div = document.createElement('div');
  div.className = 'log-list';

  if (!S.log.length) {
    const p = document.createElement('div');
    p.className = 'log-empty';
    p.textContent = '还没有记录。';
    div.appendChild(p);
  } else {
    for (const line of S.log.slice(-40)) {
      const row = document.createElement('div');
      row.className = 'log-line';
      row.textContent = line;
      div.appendChild(row);
    }
  }

  dialog({ title: '对局记录', extra: div, actions: [{ label: '关闭', kind: 'ghost' }] });
}

function showMenu() {
  dialog({
    title: '菜单',
    actions: [
      { label: '玩法', kind: 'ghost', onClick: showRules },
      { label: '对局记录', kind: 'ghost', onClick: showLog },
      { label: '认输', kind: 'danger', onClick: requestResign },
      { label: '离开房间', kind: 'ghost', onClick: confirmLeave },
      { label: '取消', kind: 'ghost' },
    ],
  });
}

/* ══════════════ 心跳与在线 ══════════════ */

let heartbeat = null;

function startPresence() {
  endPresence();
  heartbeat = setInterval(() => {
    if (!S.session) return;

    send({ t: 'ping', ts: Date.now() });

    if (currentScreen === 'lobby') {
      send({ t: 'hello', proto: PROTO, role: S.session.role });
    }

    if (S.game) {
      S.syncTick = (S.syncTick + 1) % 3;
      if (S.syncTick === 0) {
        // 先 hello 重置对方 lastSeq，再推快照，防止对方刷新后丢消息
        send({ t: 'hello', proto: PROTO, role: S.session.role });
        sendState();
      }
    }

    if (S.peerId && Date.now() - S.peerSeen > PEER_TIMEOUT_MS) {
      renderHud();
      renderHand();
      renderActions();
      renderTableHint();
    }
  }, PING_MS);
}

function endPresence() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/* ══════════════ 事件绑定 ══════════════ */

el.btnCreate.addEventListener('click', hostRoom);

el.btnResume.addEventListener('click', () => {
  const stored = loadPersist();
  if (stored?.session?.roomId) joinRoom(stored.session.roomId);
});

el.btnRules.addEventListener('click', showRules);

el.btnCopy.addEventListener('click', async () => {
  const link = el.shareLink.value;
  try {
    await navigator.clipboard.writeText(link);
    toast('链接已复制，发给朋友吧');
  } catch {
    el.shareLink.select();
    el.shareLink.setSelectionRange(0, 9999);
    try {
      document.execCommand('copy');
      toast('链接已复制');
    } catch {
      toast('复制失败，请长按链接手动复制');
    }
  }
});

el.btnLeaveLobby.addEventListener('click', confirmLeave);

el.btnLog.addEventListener('click', showLog);
el.btnMenu.addEventListener('click', showMenu);
el.btnExpand.addEventListener('click', openSheet);
el.btnSheetClose.addEventListener('click', closeSheet);

el.hand.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-card]');
  if (btn) selectCard(btn.dataset.card);
});

el.sheetGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-card]');
  if (btn) selectCard(btn.dataset.card);
});

el.handSheet.addEventListener('click', (e) => {
  if (e.target === el.handSheet) closeSheet();
});

/* 切到后台再回来：立刻重建连接（iOS 会挂起 WebSocket） */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!S.session) return;

  if (S.net && S.net.connected) {
    send({ t: 'hello', proto: PROTO, role: S.session.role });
    if (S.game) sendState();
    maybeShowResult();
  } else {
    setConn('connecting');
    connect();
  }
});

window.addEventListener('resize', () => {
  if (currentScreen === 'game') {
    requestAnimationFrame(() => {
      el.tableScroll.scrollLeft = el.tableScroll.scrollWidth;
    });
  }
});

window.addEventListener('hashchange', () => {
  const hash = new URLSearchParams(location.hash.slice(1));
  const roomId = hash.get('r');
  if (!roomId || !/^[a-z0-9]{8,32}$/i.test(roomId)) return;
  if (roomId.toLowerCase() === S.session?.roomId) return;
  joinRoom(roomId.toLowerCase());
});

window.addEventListener('beforeunload', () => {
  safe(() => S.net?.end(true));
});

window.addEventListener('error', (e) => trace('!', 'error:' + e.message));
window.addEventListener('unhandledrejection', (e) => {
  trace('!', 'reject:' + (e.reason?.message || e.reason));
});

/* ══════════════ 调试钩子 ══════════════ */

window.__duihua = {
  get snapshot() {
    const g = S.game;
    const me = mySide();
    const opp = oppSide();

    return {
      screen: currentScreen,
      conn: S.conn,
      peer: S.peerId,
      online: peerOnline(),
      session: S.session,
      actor: g ? actorOf(g) : null,
      legal: g ? legalFor(g, me) : null,
      game: g && {
        ...g,
        hands: DEBUG
          ? { host: g.hands.host.slice(), guest: g.hands.guest.slice() }
          : {
              [me]: g.hands[me].slice(),
              [opp]: g.hands[opp].map(() => '??'),
            },
      },
    };
  },
  lead(card) { return doAction({ type: 'lead', by: mySide(), card }); },
  beat(card) { return doAction({ type: 'beat', by: mySide(), card }); },
  pickup() { return doAction({ type: 'pickup', by: mySide() }); },
  relay(card) { return doAction({ type: 'relay', by: mySide(), card }); },
  stop() { return doAction({ type: 'stop', by: mySide() }); },
  dump(cards) { return doAction({ type: 'dump', by: mySide(), cards }); },
  resign() { return doAction({ type: 'resign', by: mySide() }, { force: true }); },
  restart() { requestRestart(); },
  legal() { return S.game ? legalFor(S.game, mySide()) : null; },
  actor() { return S.game ? actorOf(S.game) : null; },
  layout() {
    const rect = (sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        bottom: Math.round(r.bottom),
        right: Math.round(r.right),
      };
    };
    return {
      viewport: { w: innerWidth, h: innerHeight },
      hud: rect('.hud'),
      table: rect('.table-wrap'),
      hand: rect('.hand-wrap'),
      actions: rect('.action-bar'),
      overflow: document.documentElement.scrollHeight > innerHeight + 1,
    };
  },
  get trace() { return traceLog.slice(); },
};

/* ══════════════ 启动 ══════════════ */

function boot() {
  refreshResumeButton();

  const hash = new URLSearchParams(location.hash.slice(1));
  const roomId = hash.get('r');

  if (roomId && /^[a-z0-9]{8,32}$/i.test(roomId)) {
    joinRoom(roomId.toLowerCase());
  } else {
    showScreen('home');
  }

  startPresence();
}

boot();
