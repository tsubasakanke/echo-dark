'use strict';
/* ECHO DARK のページ側。
   - メニュー / ロビー / 試合中の表示(HTML)
   - 部屋の通信: 公開MQTTブローカーをリレーにして、全員が0.1秒ごとに自分の状態(presence)を配る
     (localhost で ?mock を付けると BroadcastChannel で同じブラウザ内だけで通信 = テスト用)
   - Unity とのやりとり: JS→C# は unityInstance.SendMessage、C#→JS は window.EchoNet / window.EchoUI */
(function () {
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  const TOPIC = 'echodark-nhs/v1/';
  const MAXP = 8;
  const PUB_GAP = 115; // 送信の最短間隔(ms)。毎秒約9回 = ブローカーの上限(約10回/秒)の内側
  const MODES = [
    { key: 'ffa', n: '個人戦', d: '全員が敵。1ライフで、最後まで生き残った人がラウンド獲得。3ラウンド先取で優勝。' },
    { key: 'team', n: 'チーム戦', d: '赤チーム vs 青チーム(入った順で自動で半分に分ける)。相手チームを全滅させたらラウンド獲得。3ラウンド先取。味方は撃てない。' },
    { key: 'oni', n: '鬼ごっこ', d: '鬼だけが銃を持っている。逃げる側は銃なしで、物陰に隠れて逃げ切れ。鬼は5秒遅れてスタート。ラウンドごとに鬼が交代(5人以上なら鬼2人)。つかまえた数+逃げ切った数のポイントで優勝を決める。' }
  ];

  const Q = new URLSearchParams(location.search);
  const $ = s => document.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = {
    unity: null, api: null, room: null, code: '', me: null, jt: 0,
    name: (Q.get('name') || store.get('echodark-name') || ('Player' + Math.floor(Math.random() * 900 + 100))).slice(0, 12),
    mode: 0, view: 'loading', inGame: false, lastGo: 0, go: null, game: null, roster: null,
    auto: Q.get('auto') === '1', autostart: Q.get('autostart'), minp: +(Q.get('minp') || 2), fast: Q.get('fast') === '1', autoStarted: false
  };

  // ================= 部屋の通信 =================

  async function getRoomApi() {
    if (S.api) return S.api;
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && Q.has('mock') && 'BroadcastChannel' in window) return (S.api = { join: async n => mockRoom(n) });
    if (window.mqtt) return (S.api = mqttRoomApi());
    return null;
  }

  function mqttRoomApi() {
    let client = null, connecting = null;
    async function getClient() {
      if (client) return client;
      if (connecting) return connecting;
      connecting = (async () => {
        for (const url of BROKERS) {
          status('リレーサーバーに接続中…(' + url.split('/')[2].split(':')[0] + ')');
          const c = await new Promise(res => {
            let cl;
            try { cl = mqtt.connect(url, { clientId: 'ed_' + Math.random().toString(36).slice(2, 12), keepalive: 30, clean: true, reconnectPeriod: 2000, connectTimeout: 6000 }); }
            catch (e) { res(null); return; }
            const to = setTimeout(() => { try { cl.end(true); } catch (e) { } res(null); }, 7000);
            cl.once('connect', () => { clearTimeout(to); res(cl); });
            cl.on('error', () => { });
          });
          if (c) { client = c; return c; }
        }
        throw new Error('net');
      })();
      try { return await connecting; } finally { connecting = null; }
    }
    return { join: async name => mqttRoom(await getClient(), name) };
  }

  function newId() { return 'm' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7); }

  function mqttRoom(cl, name) {
    const base = TOPIC + name + '/p/', myId = newId();
    let mine = {}, closed = false, snap = [];
    const table = new Map();
    const rebuild = () => {
      const arr = [{ peer: myId, isMe: true, presence: mine, at: Date.now() }];
      for (const [id, o] of table) arr.push({ peer: id, isMe: false, presence: o.presence, at: o.at });
      snap = arr;
    };
    const onMsg = (topic, payload) => {
      if (closed || !topic.startsWith(base)) return;
      const id = topic.slice(base.length);
      if (!id || id === myId || id.length > 24) return;
      if (!payload || payload.length === 0) { table.delete(id); rebuild(); return; }
      if (payload.length > 24000) return;
      let pr; try { pr = JSON.parse(payload.toString()); } catch (e) { return; }
      if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return;
      table.set(id, { presence: pr, at: Date.now() }); rebuild();
      if (room.onUpdate) room.onUpdate();
    };
    cl.on('message', onMsg);
    cl.subscribe(base + '+', { qos: 0 });
    // 公開ブローカーは1人あたり毎秒約10回までしか通さない(超えたぶんは捨てられて0.5秒ほど途切れる)。
    // なので送信は必ずここを通して、前回から PUB_GAP ms たっていなければ待ってから最新の状態を1回だけ送る
    let lastPub = 0, pending = null;
    const doPublish = () => {
      pending = null;
      if (closed || !cl.connected) return;
      lastPub = Date.now();
      try { cl.publish(base + myId, JSON.stringify(mine), { qos: 0, retain: false }); } catch (e) { }
    };
    const publish = () => {
      const wait = lastPub + PUB_GAP - Date.now();
      if (wait <= 0) doPublish();
      else if (!pending) pending = setTimeout(doPublish, wait);
    };
    const loop = setInterval(() => {
      if (closed) return;
      // 試合中は Unity からの送信(flush)で流れるので、しばらく送っていないときだけ送る
      if (Date.now() - lastPub > 100) publish();
      const now = Date.now(); let ch = false;
      for (const [id, o] of table) if (now - o.at > 6000) { table.delete(id); ch = true; }
      if (ch) rebuild();
    }, 100);
    rebuild();
    const room = {
      me: myId, set: p => { mine = p; rebuild(); }, flush: () => { if (!closed) publish(); }, peers: () => snap, connected: () => cl.connected, onUpdate: null,
      leave: () => {
        if (closed) return; closed = true; clearInterval(loop);
        try { cl.publish(base + myId, '', { qos: 0 }); cl.unsubscribe(base + '+'); } catch (e) { }
        cl.removeListener('message', onMsg);
      }
    };
    return room;
  }

  function mockRoom(name) {
    const ch = new BroadcastChannel('echodark-' + name), myId = newId();
    let mine = {}, snap = [], closed = false;
    const table = new Map();
    const rebuild = () => {
      const arr = [{ peer: myId, isMe: true, presence: mine, at: Date.now() }];
      for (const [id, o] of table) arr.push({ peer: id, isMe: false, presence: o.presence, at: o.at });
      snap = arr;
    };
    ch.onmessage = e => {
      const { id, p } = e.data || {}; if (!id || id === myId) return;
      if (!p) table.delete(id); else table.set(id, { presence: p, at: Date.now() });
      rebuild(); if (room.onUpdate) room.onUpdate();
    };
    let lastPub = 0;
    const publish = () => { lastPub = Date.now(); ch.postMessage({ id: myId, p: mine }); };
    const loop = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastPub > 90) publish();
      const now = Date.now(); for (const [id, o] of table) if (now - o.at > 4000) table.delete(id);
      rebuild();
    }, 100);
    rebuild();
    const room = {
      me: myId, set: p => { mine = p; rebuild(); }, flush: () => { if (!closed) publish(); }, peers: () => snap, connected: () => true, onUpdate: null,
      leave: () => { closed = true; clearInterval(loop); ch.postMessage({ id: myId, p: null }); ch.close(); }
    };
    return room;
  }

  // 部屋のメンバー(入った順に最大8人)
  function members() {
    if (!S.room) return [];
    return S.room.peers()
      .filter(p => p.isMe || (p.presence && p.presence.v === 1 && p.presence.rm === S.code))
      .map(p => p.isMe ? Object.assign({}, p, { presence: Object.assign({}, p.presence, { jt: S.jt, n: S.name }) }) : p)
      .sort((a, b) => (a.presence.jt - b.presence.jt) || (a.peer < b.peer ? -1 : 1))
      .slice(0, MAXP);
  }
  function leaderId() { const ids = members().map(p => p.peer).sort(); return ids[0] || S.me; }
  function isLeader() { return leaderId() === S.me; }

  async function joinRoom(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!code) { status('部屋コードを入れてね'); return; }
    status('接続中…');
    let api;
    try { api = await getRoomApi(); } catch (e) { api = null; }
    if (!api) { status('通信ライブラリを読み込めなかった。ページを再読み込みしてね'); return; }
    try { S.room = await api.join(code); }
    catch (e) { status('リレーサーバーに接続できなかった。少し待ってもう一度試してね'); return; }
    S.room.onUpdate = scheduleForward;
    S.code = code; S.me = S.room.me; S.jt = Date.now(); S.lastGo = 0; S.go = null; S.autoStarted = false;
    const url = new URL(location.href); url.searchParams.set('room', code); history.replaceState(null, '', url);
    show('lobby');
    setTimeout(() => {
      // 先に入っている8人で満員なら抜ける
      if (S.room && !members().some(p => p.isMe)) { leaveRoom(); status('部屋が満員(8人)だった'); }
    }, 1500);
  }

  function leaveRoom() {
    if (S.room) S.room.leave();
    S.room = null; S.code = ''; S.inGame = false;
    const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
    show('menu');
  }

  function buildPresence() {
    const pres = { v: 1, rm: S.code, n: S.name, jt: S.jt, st: S.inGame ? 'g' : 'l' };
    if (isLeader()) { pres.md = S.mode; if (S.go) pres.go = S.go; }
    if (S.inGame && S.game) pres.g = S.game;
    return pres;
  }

  // 試合中: 誰かの状態が届いたら、次の描画フレームでまとめて Unity に渡す(0.1秒待たない)
  let forwardQueued = false;
  function scheduleForward() {
    if (!S.inGame || forwardQueued) return;
    forwardQueued = true;
    requestAnimationFrame(() => { forwardQueued = false; forwardToUnity(); });
  }

  function forwardToUnity() {
    if (!S.room || !S.inGame) return;
    const peers = members();
    const inRoster = new Set(S.roster.map(r => r.id));
    const now = Date.now();
    const list = peers
      .filter(p => !p.isMe && inRoster.has(p.peer) && p.presence.st === 'g' && p.presence.g)
      .map(p => Object.assign({ id: p.peer, n: p.presence.n, age: Math.min(1, (now - p.at) / 1000) }, p.presence.g));
    const present = peers.filter(p => inRoster.has(p.peer) && (p.isMe || p.presence.st === 'g')).map(p => p.peer).sort();
    sendUnity('Net', 'OnPeers', JSON.stringify({ me: S.me, leader: present[0] || S.me, peers: list }));
  }

  // 0.1秒ごと: ロビーの状態を配る。試合中は Unity から届いた時点ですぐ送るので、ここは予備
  setInterval(() => {
    if (!S.room) return;
    S.room.set(buildPresence());

    const peers = members();
    if (!S.inGame) {
      const L = peers.find(p => p.peer === leaderId());
      if (L && !L.isMe) {
        S.mode = L.presence.md | 0;
        const go = L.presence.go;
        // リーダーの開始合図(自分が名簿に入っていて、まだ始めていないもの)
        if (go && go.t !== S.lastGo && Array.isArray(go.roster) && go.roster.some(r => r.id === S.me)) startGame(go);
      }
      if (isLeader() && S.autostart && !S.autoStarted && peers.length >= S.minp) {
        S.autoStarted = true;
        S.mode = Math.max(0, MODES.findIndex(m => m.key === S.autostart));
        leaderStart();
      }
      return;
    }
    forwardToUnity();
  }, 100);

  function leaderStart() {
    const roster = members().map(p => ({ id: p.peer, n: p.isMe ? S.name : String(p.presence.n || '?').slice(0, 12) }));
    if (roster.length < 2) return;
    S.go = { t: Date.now(), mode: S.mode, roster: roster, fast: S.fast ? 1 : 0 };
    startGame(S.go);
  }

  function startGame(go) {
    S.lastGo = go.t; S.inGame = true; S.roster = go.roster; S.game = null;
    show('game');
    sendUnity('Net', 'StartMatch', JSON.stringify({ me: S.me, mode: go.mode | 0, roster: go.roster, auto: S.auto ? 1 : 0, fast: go.fast | 0 }));
  }

  function sendUnity(obj, method, arg) {
    if (!S.unity) return;
    try { arg === undefined ? S.unity.SendMessage(obj, method) : S.unity.SendMessage(obj, method, arg); } catch (e) { console.error(e); }
  }

  // ================= 画面 =================

  function show(view) {
    S.view = view;
    $('#menu').classList.toggle('hidden', view !== 'menu');
    $('#lobby').classList.toggle('hidden', view !== 'lobby');
    $('#hud').classList.toggle('hidden', view !== 'game' && view !== 'solo');
    $('#loading').classList.toggle('hidden', view !== 'loading');
    if (view === 'lobby') renderLobby();
    status('');
  }

  function status(t) {
    const el = S.view === 'lobby' ? $('#lobbyStat') : $('#menuStat');
    if (el) el.textContent = t;
  }

  function renderLobby() {
    if (S.view !== 'lobby' || !S.room) return;
    const peers = members(), lead = leaderId(), amLeader = lead === S.me;
    $('#lcode').textContent = S.code;
    const url = new URL(location.href); url.search = '?room=' + S.code;
    if ($('#invite').value !== url.href) $('#invite').value = url.href;

    $('#players').innerHTML = peers.map(p =>
      '<div>' + (p.peer === lead ? '👑 ' : '') + esc(p.isMe ? S.name : p.presence.n) + (p.isMe ? '(あなた)' : '') +
      (p.presence.st === 'g' && !p.isMe ? ' — 試合中' : '') + '</div>').join('') +
      '<div style="color:var(--dim)">' + peers.length + ' / ' + MAXP + ' 人</div>';

    $('#modes').innerHTML = MODES.map((m, i) =>
      '<button class="btn' + (i === S.mode ? ' sel' : '') + '" data-mode="' + i + '"' + (amLeader ? '' : ' disabled') + '>' + m.n + '</button>').join('');
    $('#modeDesc').textContent = MODES[S.mode].d;

    const leaderInGame = peers.some(p => p.peer === lead && !p.isMe && p.presence.st === 'g');
    $('#start').classList.toggle('hidden', !amLeader);
    $('#start').disabled = peers.length < 2;
    let msg = '';
    if (leaderInGame) msg = '試合中… 終わったら次の試合に参加できる';
    else if (amLeader) msg = peers.length < 2 ? '2人以上でスタートできる。招待URLを友達に送ろう' : 'そろったらスタート';
    else msg = 'リーダー(👑)がスタートするのを待っています';
    $('#lobbyStat').textContent = msg;
  }
  setInterval(renderLobby, 300);

  function renderHud(h) {
    if (S.view !== 'game' && S.view !== 'solo') return;
    $('#tl').textContent = (h.tl || []).join('\n');
    $('#tr1').textContent = h.tr || '';
    $('#tr2').textContent = h.tr2 || '';
    $('#tr3').textContent = h.tr3 || '';
    $('#center').textContent = h.center || '';
    $('#sub').textContent = h.sub || '';
    $('#bottom').textContent = h.bottom || '';
    $('#cross').classList.toggle('hidden', !h.cross);
    const locked = document.pointerLockElement === $('#unity-canvas');
    $('#lockhint').classList.toggle('hidden', locked || S.auto);
    $('#exitGame').classList.toggle('hidden', locked);
  }

  // ================= ボタン =================

  function bind() {
    $('#name').value = S.name;
    $('#name').addEventListener('input', e => { S.name = e.target.value.trim().slice(0, 12) || 'Player'; store.set('echodark-name', S.name); });
    $('#solo').onclick = () => { show('solo'); sendUnity('Game', 'StartSolo'); $('#unity-canvas').focus(); };
    $('#create').onclick = () => joinRoom(Math.random().toString(36).slice(2, 7).toUpperCase());
    $('#join').onclick = () => joinRoom($('#joinCode').value);
    $('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('#joinCode').value); });
    $('#leave').onclick = leaveRoom;
    $('#start').onclick = () => { if (isLeader()) leaderStart(); };
    $('#modes').addEventListener('click', e => {
      const b = e.target.closest('[data-mode]'); if (!b || !isLeader()) return;
      S.mode = +b.dataset.mode; renderLobby();
    });
    $('#copy').onclick = async () => {
      const v = $('#invite').value;
      try { await navigator.clipboard.writeText(v); $('#copy').textContent = 'コピーした!'; }
      catch (e) { $('#invite').select(); document.execCommand('copy'); $('#copy').textContent = 'コピーした!'; }
      setTimeout(() => { $('#copy').textContent = '招待URLをコピー'; }, 1500);
    };
    $('#exitGame').onclick = () => {
      if (S.view === 'solo') { location.href = location.pathname; return; }
      sendUnity('Net', 'Leave');
    };
    // 画面クリックでキーボード入力を Unity に向ける(ロビーの入力欄と取り合わないように)
    $('#unity-canvas').addEventListener('mousedown', () => $('#unity-canvas').focus());
  }

  // ================= Unity から呼ばれる =================

  window.EchoNet = {
    // Unity が自分の状態を出した瞬間に中継へ流す(0.1秒待たない)
    fromUnity(json) {
      try { S.game = JSON.parse(json); } catch (e) { return; }
      if (S.room && S.inGame) { S.room.set(buildPresence()); S.room.flush(); }
    }
  };

  window.EchoUI = {
    progress(p) { $('#fill').style.width = Math.round(p * 100) + '%'; },
    ready(inst) {
      S.unity = inst;
      bind();
      show('menu');
      const room = Q.get('room');
      if (room) joinRoom(room);
    },
    fail(e) { $('#ltext').textContent = '読み込みに失敗した: ' + e; },
    hud(json) { try { renderHud(JSON.parse(json)); } catch (e) { } },
    event(ev) {
      if (ev === 'over') {
        S.inGame = false; S.game = null; S.go = null;
        if (document.exitPointerLock) document.exitPointerLock();
        show(S.room ? 'lobby' : 'menu');
      }
    }
  };

  // テスト用(localhost だけ)
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) window.__echo = S;
})();
