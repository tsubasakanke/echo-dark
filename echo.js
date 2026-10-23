'use strict';
/* ECHO DARK のページ側。
   - メニュー / ロビー / 試合中の表示(HTML)
   - 部屋の通信: 公開MQTTブローカーをリレーにして、全員が0.1秒ごとに自分の状態(presence)を配る
     (localhost で ?mock を付けると BroadcastChannel で同じブラウザ内だけで通信 = テスト用)
   - Unity とのやりとり: JS→C# は unityInstance.SendMessage、C#→JS は window.EchoNet / window.EchoUI */
(function () {
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  const TOPIC = 'echodark-nhs/v1/';
  const MAXP = 8;        // 人間の上限
  const MAX_TOTAL = 12;  // 人間+NPC の上限
  const PUB_GAP = 115; // 送信の最短間隔(ms)。毎秒約9回 = ブローカーの上限(約10回/秒)の内側
  const MODES = [
    { key: 'ffa', n: '個人戦', d: '全員が敵。1ライフで、最後まで生き残った人がラウンド獲得。3ラウンド先取で優勝。NPCも入れられる。' },
    { key: 'team', n: 'チーム戦', d: '赤チーム vs 青チーム。人間は入った順で半分に分ける(「人間は全員赤」にすると NPC チームと対戦)。相手チームを全滅させたらラウンド獲得。3ラウンド先取。味方は撃てない。' },
    { key: 'oni', n: '鬼ごっこ', d: '鬼だけが銃を持っている。逃げる側は銃なしで、物陰に隠れて逃げ切れ。鬼は5秒遅れてスタート。ラウンドごとに鬼が交代(5人以上なら鬼2人)。つかまえた数+逃げ切った数のポイントで優勝を決める。' }
  ];

  // マウス固定(pointer lock)の要求はクリック直後でないと断られる。断られてもクリックすれば固定できるので問題ないが、
  // Unity の読み込み処理はこれを「重大なエラー」扱いして警告ダイアログを出してしまう。
  // このファイルは Unity より先に読み込まれるので、ここで先に受け取って止める
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason, msg = String((r && (r.message || r.name)) || r);
    if (/pointer ?lock/i.test(msg) || (r && /^(NotAllowedError|WrongDocumentError|SecurityError)$/.test(r.name) && /lock/i.test(msg))) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  });

  // アセンブル(C# の Weapons.cs と同じ順番)
  const WEAPONS = [
    { n: 'P90', d: '連射が速い・弾50発', st: '威力22 / 銃声 中' },
    { n: 'アサルトライフル', d: 'バランス型・遠くも当たる', st: '威力30 / 銃声 やや大' },
    { n: 'ショットガン', d: '近距離で8発ばらまく', st: '威力15×8 / 銃声 やや大' },
    { n: 'スナイパー', d: '1発で倒せる。ズーム(右クリック)しないとブレる', st: '威力100 / 銃声 超大(全体にバレる)' },
    { n: 'サプレッサー拳銃', d: '銃声がとても小さい。隠密向き', st: '威力34 / 銃声 極小' }
  ];
  const STAGES = ['高台', '迷路', '市街地', '工場', '平原']; // C# の MapBuilder.StageNames と同じ順番。-1 = ランダム
  const SKILLS = [
    { n: 'ハイジャンプ', d: '高台や塔に飛び乗れる', cd: 8 },
    { n: 'スキャン', d: '20m以内の敵が2.5秒、壁越しに光る', cd: 18 },
    { n: 'ダッシュ', d: '1.2秒、足音なしで速く動く', cd: 10 },
    { n: 'デコイ', d: '狙った場所でニセの銃声を鳴らす', cd: 14 }
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
    // NPC の設定(リーダーが決める): nf = 個人戦のNPC数、nr/nb = 赤/青チームのNPC数、ar = 人間を全員赤チームに
    cfg: { nf: +(Q.get('nf') || 0), nr: +(Q.get('nr') || 0), nb: +(Q.get('nb') || 0), ar: Q.get('ar') === '1' ? 1 : 0, st: Q.has('st') ? +Q.get('st') : +(store.get('echodark-stage') || -1) },
    lo: loadLoadout(), tp: -1, ghost: store.get('echodark-ghost') !== '0', // ghost = 反響の残像を出すか // tp = 選んだチーム(0=赤 1=青 -1=おまかせ)
    auto: Q.get('auto') === '1', autostart: Q.get('autostart'), minp: +(Q.get('minp') || 2), fast: Q.get('fast') === '1', autoStarted: false
  };

  function loadLoadout() {
    let lo = null;
    try { lo = JSON.parse(store.get('echodark-lo') || 'null'); } catch (e) { }
    if (!lo || typeof lo !== 'object') lo = { w: 0, s1: 0, s2: 1 };
    lo.w = Math.min(4, Math.max(0, lo.w | 0)); lo.s1 = Math.min(3, Math.max(0, lo.s1 | 0)); lo.s2 = Math.min(3, Math.max(0, lo.s2 | 0));
    if (Q.has('w')) lo.w = Math.min(4, Math.max(0, +Q.get('w') | 0)); // テスト用
    if (lo.s1 === lo.s2) lo.s2 = (lo.s1 + 1) % 4;
    return lo;
  }

  // 人間のチーム分け(C# の AssignTeams と同じやり方): 選んだ人はそのチーム、おまかせは少ないほうへ
  function humanTeams(tps, allRed) {
    let red = 0, blue = 0;
    for (const t of tps) if (allRed || t === 0) red++; else if (t === 1) blue++;
    if (!allRed) for (const t of tps) if (t !== 0 && t !== 1) { if (red <= blue) red++; else blue++; }
    return { red, blue };
  }

  // 今の設定で、チームごとの人数(人間+NPC)
  function teamCounts(humans, tps) {
    const c = S.cfg;
    if (MODES[S.mode].key === 'ffa') return { total: humans + c.nf };
    if (MODES[S.mode].key === 'oni') return { total: humans };
    const h = humanTeams(tps || new Array(humans).fill(-1), !!c.ar);
    const red = h.red + c.nr, blue = h.blue + c.nb;
    return { total: red + blue, red, blue };
  }
  function memberTps() { return members().map(p => p.isMe ? S.tp : (p.presence.tp == null ? -1 : p.presence.tp)); }

  // スタートできるか(できないなら理由)
  function startProblem(humans) {
    const k = teamCounts(humans, memberTps()), key = MODES[S.mode].key;
    if (k.total > MAX_TOTAL) return 'NPCを入れすぎ(人間+NPCで' + MAX_TOTAL + '人まで)';
    if (key === 'oni' && humans < 2) return '鬼ごっこは2人以上(NPCなし)';
    if (key === 'ffa' && k.total < 2) return 'ひとりならNPCを入れてね';
    if (key === 'team' && (k.red < 1 || k.blue < 1)) return '両チームに1人以上必要(NPCを入れてね)';
    return '';
  }

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
    const pres = { v: 1, rm: S.code, n: S.name, jt: S.jt, st: S.inGame ? 'g' : 'l', lo: S.lo, tp: S.tp };
    if (isLeader()) { pres.md = S.mode; pres.cfg = S.cfg; if (S.go) pres.go = S.go; }
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
        if (L.presence.cfg) S.cfg = L.presence.cfg;
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
    const roster = members().map(p => {
      const lo = p.isMe ? S.lo : (p.presence.lo || {});
      const tp = p.isMe ? S.tp : (p.presence.tp == null ? -1 : p.presence.tp);
      return { id: p.peer, n: p.isMe ? S.name : String(p.presence.n || '?').slice(0, 12), w: lo.w | 0, s1: lo.s1 | 0, s2: lo.s2 == null ? 1 : lo.s2 | 0, tp: tp | 0 };
    });
    if (startProblem(roster.length)) return;
    // seed = マップの種(全員が同じランダムマップを作る)
    const st = S.cfg.st >= 0 ? S.cfg.st : Math.floor(Math.random() * STAGES.length); // ランダムはここで1つに決めて全員に配る
    S.go = { t: Date.now(), mode: S.mode, roster: roster, fast: S.fast ? 1 : 0, seed: Math.floor(Math.random() * 1e6) + 1, st: st, cfg: Object.assign({}, S.cfg) };
    startGame(S.go);
  }

  function startGame(go) {
    S.lastGo = go.t; S.inGame = true; S.roster = go.roster; S.game = null;
    show('game');
    const c = go.cfg || {};
    sendUnity('Net', 'StartMatch', JSON.stringify({
      me: S.me, mode: go.mode | 0, roster: go.roster, auto: S.auto ? 1 : 0, fast: go.fast | 0, seed: go.seed | 0, st: go.st | 0,
      nf: c.nf | 0, nr: c.nr | 0, nb: c.nb | 0, ar: c.ar | 0
    }));
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

    const isTeam = MODES[S.mode].key === 'team';
    $('#players').innerHTML = peers.map(p => {
      const lo = p.isMe ? S.lo : (p.presence.lo || {}), tp = p.isMe ? S.tp : p.presence.tp;
      const team = !isTeam || S.cfg.ar ? '' : tp === 0 ? ' <span style="color:#ff8a80">[赤]</span>' : tp === 1 ? ' <span style="color:#82b7ff">[青]</span>' : ' [おまかせ]';
      return '<div>' + (p.peer === lead ? '👑 ' : '') + esc(p.isMe ? S.name : p.presence.n) + (p.isMe ? '(あなた)' : '') + team +
        ' <span style="color:var(--dim)">— ' + esc((WEAPONS[lo.w | 0] || WEAPONS[0]).n) + '</span>' +
        (p.presence.st === 'g' && !p.isMe ? ' — 試合中' : '') + '</div>';
    }).join('') +
      '<div style="color:var(--dim)">' + peers.length + ' / ' + MAXP + ' 人</div>';

    $('#modes').innerHTML = MODES.map((m, i) =>
      '<button class="btn' + (i === S.mode ? ' sel' : '') + '" data-mode="' + i + '"' + (amLeader ? '' : ' disabled') + '>' + m.n + '</button>').join('');
    $('#modeDesc').textContent = MODES[S.mode].d;
    renderNpc(amLeader, peers.length);
    renderStages(amLeader);
    // チーム選択(チーム戦のときだけ、だれでも自分のぶんを選べる)
    const tpHtml = isTeam && !S.cfg.ar
      ? '<span style="align-self:center;font-size:14px">あなたのチーム</span>' +
        [[0, '赤', 'red'], [1, '青', 'blue'], [-1, 'おまかせ', '']].map(([v, n, c]) => '<button class="btn small ' + c + (S.tp === v ? ' sel' : '') + '" data-tp="' + v + '">' + n + '</button>').join('')
      : '';
    if ($('#teampick').innerHTML !== tpHtml) $('#teampick').innerHTML = tpHtml;

    const leaderInGame = peers.some(p => p.peer === lead && !p.isMe && p.presence.st === 'g');
    const problem = startProblem(peers.length);
    $('#start').classList.toggle('hidden', !amLeader);
    $('#start').disabled = !!problem;
    let msg = '';
    if (leaderInGame) msg = '試合中… 終わったら次の試合に参加できる';
    else if (amLeader) msg = problem || 'そろったらスタート(招待URLで友達も呼べる)';
    else msg = 'リーダー(👑)がスタートするのを待っています';
    $('#lobbyStat').textContent = msg;
  }

  // ステージ選択(メニュー = ソロ用、ロビー = リーダーが決める)
  function renderStages(amLeader) {
    const btns = (sel, dis) => [-1, 0, 1, 2, 3, 4].map(i =>
      '<button class="btn' + (sel === i ? ' sel' : '') + '" data-st="' + i + '"' + (dis ? ' disabled' : '') + '>' + (i < 0 ? 'ランダム' : STAGES[i]) + '</button>').join('');
    const m = btns(S.cfg.st, false), l = btns(S.cfg.st, !amLeader);
    if ($('#stageMenu').innerHTML !== m) $('#stageMenu').innerHTML = m;
    if ($('#stageLobby').innerHTML !== l) $('#stageLobby').innerHTML = l;
  }

  // アセンブル(武器1つ + スキル2つ)。メニューとロビーの両方に同じものを出す。ロビーでいつでも変えられる
  function renderAsm() {
    const lo = S.lo;
    const html = '<h3>アセンブル(武器とスキル)</h3>' +
      '<div class="grid">' + WEAPONS.map((w, i) =>
        '<button class="btn' + (lo.w === i ? ' sel' : '') + '" data-w="' + i + '">' + esc(w.n) + '<small>' + esc(w.d) + '<br>' + esc(w.st) + '</small></button>').join('') + '</div>' +
      '<div class="desc">スキルを2つ(Q / E で使う)</div>' +
      '<div class="grid">' + SKILLS.map((k, i) => {
        const slot = lo.s1 === i ? 'Q' : lo.s2 === i ? 'E' : '';
        return '<button class="btn' + (slot ? ' sel' : '') + '" data-s="' + i + '">' + (slot ? '[' + slot + '] ' : '') + esc(k.n) + '<small>' + esc(k.d) + '(待ち' + k.cd + '秒)</small></button>';
      }).join('') + '</div>';
    document.querySelectorAll('.asm').forEach(el => { if (el.innerHTML !== html) el.innerHTML = html; });
  }

  function onAsmClick(e) {
    const b = e.target.closest('[data-w],[data-s]');
    if (!b) return;
    if (b.dataset.w != null) S.lo.w = +b.dataset.w;
    else {
      const k = +b.dataset.s;
      if (k !== S.lo.s1 && k !== S.lo.s2) { S.lo.s1 = S.lo.s2; S.lo.s2 = k; } // 古いほうを外して入れ替え
    }
    store.set('echodark-lo', JSON.stringify(S.lo));
    renderAsm();
    renderStages(true);
    // 反響の残像のオン・オフ(メニューとロビーの両方。Unity にも伝える)
    const setGhost = on => {
      S.ghost = on; store.set('echodark-ghost', on ? '1' : '0');
      document.querySelectorAll('.ghostOpt').forEach(el => { el.checked = on; });
      sendUnity('Net', 'SetGhosts', on ? '1' : '0');
    };
    document.querySelectorAll('.ghostOpt').forEach(el => el.addEventListener('change', e => setGhost(e.target.checked)));
    setGhost(S.ghost);
    S._setGhost = setGhost;
    const onStage = e => {
      const b = e.target.closest('[data-st]'); if (!b) return;
      if (S.room && !isLeader()) return;
      S.cfg.st = +b.dataset.st; store.set('echodark-stage', String(S.cfg.st));
      renderStages(!S.room || isLeader()); renderLobby();
    };
    $('#stageMenu').addEventListener('click', onStage);
    $('#stageLobby').addEventListener('click', onStage);
    renderLobby();
  }

  // NPC の設定欄(リーダーだけ操作できる。鬼ごっこは NPC なし)
  function renderNpc(amLeader, humans) {
    const key = MODES[S.mode].key, c = S.cfg, dis = amLeader ? '' : ' disabled';
    const counter = (field, label) =>
      '<div class="npcrow"><span>' + label + '</span>' +
      '<button class="btn small" data-npc="' + field + '" data-d="-1"' + dis + '>−</button>' +
      '<b>' + (c[field] | 0) + '</b>' +
      '<button class="btn small" data-npc="' + field + '" data-d="1"' + dis + '>+</button></div>';
    let html = '';
    if (key === 'ffa') html = counter('nf', 'NPC');
    else if (key === 'team') {
      const k = teamCounts(humans, memberTps());
      html = counter('nr', '赤チームのNPC') + counter('nb', '青チームのNPC') +
        '<label class="npcrow"><input type="checkbox" data-ar' + (c.ar ? ' checked' : '') + dis + '> 人間は全員赤チーム(NPCチームと対戦)</label>' +
        '<div class="desc">赤 ' + k.red + '人 / 青 ' + k.blue + '人</div>';
    }
    else html = '<div class="desc">鬼ごっこは NPC なし</div>';
    if ($('#npc').innerHTML !== html) $('#npc').innerHTML = html;
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
    // ゲーム中に V キーで切り替えたら、設定にも反映して覚えておく
    if (h.ghost != null && h.ghost !== S.ghost && S._setGhost) S._setGhost(h.ghost);
    // HP・弾・スキル・キルログ
    const hasHp = h.hp != null && h.hp >= 0;
    $('#hpbox').classList.toggle('hidden', !hasHp);
    if (hasHp) { $('#hpnum').textContent = 'HP ' + h.hp; $('#hpfill').style.width = h.hp + '%'; $('#hpfill').classList.toggle('low', h.hp <= 30); }
    $('#ammo').textContent = h.ammo || '';
    $('#skills').textContent = (h.skills || []).join('\n');
    $('#feed').textContent = (h.feed || []).slice(-4).join('\n');
    // 音の方向: 照準のまわりに、聞こえた音の向きを色つきの弧で出す(上 = 前、右 = 右)
    const SND_COLOR = { 0: '#6fd3ff', 1: '#6fd3ff', 3: '#ff5a4e', 4: '#ffa64f', 5: '#c58cff', 7: '#ffffff' };
    const snd = h.snd || [], box = $('#snd');
    let html = '';
    for (let i = 0; i + 2 < snd.length; i += 3) {
      const ang = snd[i], kind = snd[i + 1], a = snd[i + 2];
      const col = SND_COLOR[kind] || '#cfe9ff';
      html += '<i class="' + (kind === 3 ? 'big' : '') + '" style="background:' + col + ';opacity:' + a + ';box-shadow:0 0 8px ' + col +
        ';transform:rotate(' + ang + 'deg) translateY(-' + (kind === 3 ? 92 : 78) + 'px)"></i>';
    }
    box.innerHTML = html;
    // 自分の音の大きさ
    const nz = Math.max(0, Math.min(1, h.noise || 0));
    $('#noisebox').classList.toggle('hidden', !(h.hp != null && h.hp >= 0));
    $('#noisefill').style.width = Math.round(nz * 100) + '%';
    $('#noiselabel').textContent = nz < 0.05 ? '静か' : nz < 0.4 ? '小' : nz < 0.65 ? '中' : nz < 0.9 ? '大' : '超大';

    // 一瞬の演出(数字が増えたらアニメーションをやり直す)
    const kick = (id, seq, key) => { if (seq != null && seq !== S[key]) { if (S[key] != null) { const el = $(id); el.classList.remove('go'); void el.offsetWidth; el.classList.add('go'); } S[key] = seq; } };
    if (h.pop) $('#pop').textContent = h.pop;
    kick('#pop', h.popSeq, '_pop'); kick('#hitmark', h.hitSeq, '_hit'); kick('#dmg', h.dmgSeq, '_dmg');
    const locked = document.pointerLockElement === $('#unity-canvas');
    $('#lockhint').classList.toggle('hidden', locked || S.auto);
    $('#exitGame').classList.toggle('hidden', locked);
  }

  // ================= ボタン =================

  function bind() {
    $('#name').value = S.name;
    $('#name').addEventListener('input', e => { S.name = e.target.value.trim().slice(0, 12) || 'Player'; store.set('echodark-name', S.name); });
    $('#solo').onclick = () => {
      const st = S.cfg.st >= 0 ? S.cfg.st : Math.floor(Math.random() * STAGES.length);
      show('solo'); sendUnity('Net', 'StartSolo', JSON.stringify(Object.assign({}, S.lo, { st }))); $('#unity-canvas').focus();
    };
    document.querySelectorAll('.asm').forEach(el => el.addEventListener('click', onAsmClick));
    $('#teampick').addEventListener('click', e => {
      const b = e.target.closest('[data-tp]'); if (!b) return;
      S.tp = +b.dataset.tp; renderLobby();
    });
    renderAsm();
    renderStages(true);
    // 反響の残像のオン・オフ(メニューとロビーの両方。Unity にも伝える)
    const setGhost = on => {
      S.ghost = on; store.set('echodark-ghost', on ? '1' : '0');
      document.querySelectorAll('.ghostOpt').forEach(el => { el.checked = on; });
      sendUnity('Net', 'SetGhosts', on ? '1' : '0');
    };
    document.querySelectorAll('.ghostOpt').forEach(el => el.addEventListener('change', e => setGhost(e.target.checked)));
    setGhost(S.ghost);
    S._setGhost = setGhost;
    const onStage = e => {
      const b = e.target.closest('[data-st]'); if (!b) return;
      if (S.room && !isLeader()) return;
      S.cfg.st = +b.dataset.st; store.set('echodark-stage', String(S.cfg.st));
      renderStages(!S.room || isLeader()); renderLobby();
    };
    $('#stageMenu').addEventListener('click', onStage);
    $('#stageLobby').addEventListener('click', onStage);
    $('#create').onclick = () => joinRoom(Math.random().toString(36).slice(2, 7).toUpperCase());
    $('#join').onclick = () => joinRoom($('#joinCode').value);
    $('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('#joinCode').value); });
    $('#leave').onclick = leaveRoom;
    $('#start').onclick = () => { if (isLeader()) leaderStart(); };
    $('#modes').addEventListener('click', e => {
      const b = e.target.closest('[data-mode]'); if (!b || !isLeader()) return;
      S.mode = +b.dataset.mode; renderLobby();
    });
    $('#npc').addEventListener('click', e => {
      if (!isLeader()) return;
      const b = e.target.closest('[data-npc]');
      if (b) {
        const f = b.dataset.npc, next = Math.max(0, (S.cfg[f] | 0) + (+b.dataset.d));
        const before = S.cfg[f]; S.cfg[f] = next;
        if (teamCounts(members().length, memberTps()).total > MAX_TOTAL) S.cfg[f] = before; // 12人を超える分は増やさない
        renderLobby();
      }
    });
    $('#npc').addEventListener('change', e => {
      if (!isLeader() || !e.target.matches('[data-ar]')) return;
      S.cfg.ar = e.target.checked ? 1 : 0; renderLobby();
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
