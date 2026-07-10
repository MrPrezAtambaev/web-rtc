const joinPanel = document.getElementById('joinPanel');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const stageSection = document.getElementById('stageSection');
const stage = document.getElementById('stage');
const tileList = document.getElementById('tileList');
const controlsSection = document.getElementById('controlsSection');
const micBtn = document.getElementById('micBtn');
const camBtn = document.getElementById('camBtn');
const screenBtn = document.getElementById('screenBtn');
const stageFsBtn = document.getElementById('stageFsBtn');
const hangupBtn = document.getElementById('hangupBtn');
const statusEl = document.getElementById('status');

// getDisplayMedia is unavailable on iOS Safari — hide the button there.
if (!navigator.mediaDevices?.getDisplayMedia) {
  screenBtn.hidden = true;
}

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

let ws = null;
let localStream = null;
let screenStream = null;
let myId = null;

// Full mesh: one RTCPeerConnection per remote participant, each with its
// own perfect-negotiation state. The peer with the smaller id is polite.
const peers = new Map(); // peerId -> state

// Shared layout, synced over signaling. Tile ids: `${peerId}-cam` and
// `${peerId}-screen`. Rects are normalized to the stage: x, y — top-left;
// w — width fraction; z — stacking order; max — fill the whole stage.
const layout = {};
const tiles = new Map(); // tileId -> {el, video, label}

const camLabel = (id) => (id === myId ? 'Вы' : `Участник ${id}`);
const screenLabel = (id) => (id === myId ? 'Ваш экран' : `Экран участника ${id}`);

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function setStatus(text) {
  statusEl.textContent = text;
}

function updateCountStatus() {
  setStatus(`В комнате: ${peers.size + 1} участн.`);
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// --- Layout ---

function frontZ() {
  const zs = Object.values(layout).map((r) => r.z);
  return (zs.length ? Math.max(...zs) : 0) + 1;
}

function backZ() {
  const zs = Object.values(layout).map((r) => r.z);
  return (zs.length ? Math.min(...zs) : 0) - 1;
}

// Keeps z values compact and ≥ 1. A negative z-index would render the tile
// behind the stage background (the stage creates no stacking context), which
// looks like the tile vanished.
function renormalizeZ() {
  const ids = Object.keys(layout).sort((a, b) => layout[a].z - layout[b].z);
  ids.forEach((id, i) => {
    layout[id].z = i + 1;
  });
}

function defaultRect(tileId) {
  const [pidStr, kind] = tileId.split('-');
  const n = parseInt(pidStr, 10) || 0;
  if (kind === 'screen') {
    // Screens go big, behind the cameras — streamer style.
    return { x: 0.1, y: 0.05, w: 0.8, z: 1 + (n % 5), max: false };
  }
  // Cameras cascade in a 3-column grid by peer id.
  const idx = Math.max(0, n - 1);
  return {
    x: 0.04 + (idx % 3) * 0.33,
    y: 0.08 + (Math.floor(idx / 3) % 3) * 0.3,
    w: 0.28,
    z: 10 + n,
    max: false,
  };
}

function applyLayout() {
  for (const [id, tile] of tiles) {
    const rect = layout[id];
    if (!rect) continue;
    tile.el.style.left = `${rect.x * 100}%`;
    tile.el.style.top = `${rect.y * 100}%`;
    tile.el.style.width = `${rect.w * 100}%`;
    tile.el.style.zIndex = rect.z;
    tile.el.classList.toggle('max', Boolean(rect.max));
  }
}

function sendLayout(id) {
  wsSend({ type: 'layout', id, rect: layout[id] });
}

let layoutSendTimer = null;
function sendLayoutThrottled(id) {
  if (layoutSendTimer) return;
  layoutSendTimer = setTimeout(() => {
    layoutSendTimer = null;
    sendLayout(id);
  }, 50);
}

// --- Tiles ---

function upsertTile(id, stream, { muted, label }) {
  let tile = tiles.get(id);
  if (!tile) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset.id = id;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = muted;

    const lbl = document.createElement('span');
    lbl.className = 'tile-label';

    const bar = document.createElement('div');
    bar.className = 'tile-toolbar';
    bar.innerHTML =
      '<button data-act="front" title="Вперёд">▲</button>' +
      '<button data-act="back" title="Назад">▼</button>' +
      '<button data-act="max" title="На всё полотно">⛶</button>';

    const handle = document.createElement('div');
    handle.className = 'tile-handle';

    el.append(video, lbl, bar, handle);
    stage.appendChild(el);
    attachTileEvents(el);

    tile = { el, video, label };
    tiles.set(id, tile);
  }

  tile.label = label;
  tile.el.querySelector('.tile-label').textContent = label;
  if (tile.video.srcObject !== stream) {
    tile.video.srcObject = stream;
  }
  if (!layout[id]) {
    layout[id] = defaultRect(id);
    sendLayout(id);
  }
  applyLayout();
  renderTileList();
}

function removeTile(id) {
  const tile = tiles.get(id);
  if (!tile) return;
  tile.el.remove();
  tiles.delete(id);
  delete layout[id];
  renderTileList();
}

function renderTileList() {
  tileList.innerHTML = '';
  const order = [...tiles.keys()].sort((a, b) => {
    const kindRank = (id) => (id.endsWith('-cam') ? 0 : 1);
    return kindRank(a) - kindRank(b) || parseInt(a, 10) - parseInt(b, 10);
  });
  for (const id of order) {
    const tile = tiles.get(id);
    const li = document.createElement('li');
    li.textContent = `${id.endsWith('-screen') ? '🖥' : '📷'} ${tile.label}`;
    li.title = 'Показать поверх остальных';
    li.addEventListener('click', () => {
      const rect = layout[id];
      if (!rect) return;
      rect.z = frontZ();
      renormalizeZ();
      applyLayout();
      wsSend({ type: 'layout-all', layout });
    });
    tileList.appendChild(li);
  }
  if (!tiles.size) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Пока никого нет';
    tileList.appendChild(li);
  }
}

function attachTileEvents(el) {
  let drag = null;

  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tile-toolbar')) return;
    const rect = layout[el.dataset.id];
    if (!rect || rect.max) return;

    const p = stagePoint(e);
    drag = {
      mode: e.target.classList.contains('tile-handle') ? 'resize' : 'move',
      startP: p,
      startRect: { ...rect },
      hNorm: el.offsetHeight / stage.clientHeight,
    };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const id = el.dataset.id;
    const rect = layout[id];
    const p = stagePoint(e);
    const dx = p.x - drag.startP.x;
    const dy = p.y - drag.startP.y;

    if (drag.mode === 'move') {
      rect.x = clamp(drag.startRect.x + dx, 0, Math.max(0, 1 - rect.w));
      rect.y = clamp(drag.startRect.y + dy, 0, Math.max(0, 1 - drag.hNorm));
    } else {
      rect.w = clamp(drag.startRect.w + dx, 0.08, 1);
      rect.x = clamp(rect.x, 0, Math.max(0, 1 - rect.w));
    }
    applyLayout();
    sendLayoutThrottled(id);
  });

  for (const type of ['pointerup', 'pointercancel']) {
    el.addEventListener(type, () => {
      if (!drag) return;
      drag = null;
      sendLayout(el.dataset.id);
    });
  }

  el.querySelector('.tile-toolbar').addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const id = el.dataset.id;
    const rect = layout[id];
    if (act === 'front') rect.z = frontZ();
    if (act === 'back') rect.z = backZ();
    if (act === 'max') rect.max = !rect.max;
    renormalizeZ(); // touches every tile's z, so broadcast the whole layout
    applyLayout();
    wsSend({ type: 'layout-all', layout });
  });
}

function stagePoint(e) {
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

// If autoplay with sound was blocked, any interaction with the stage
// unsticks the paused remote videos.
stage.addEventListener(
  'pointerdown',
  () => {
    for (const tile of tiles.values()) {
      if (tile.video.paused) tile.video.play().catch(() => {});
    }
  },
  true
);

// --- Peers (one connection per remote participant) ---

function peerState(id) {
  let p = peers.get(id);
  if (!p) {
    p = {
      id,
      pc: null,
      polite: false,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      screenSenders: [],
      streams: new Map(), // streamId -> MediaStream
      meta: {}, // streamId -> 'cam' | 'screen'
    };
    peers.set(id, p);
  }
  return p;
}

function createPeerConnection(p) {
  if (p.pc) return p.pc;

  // Deterministic politeness per pair: the earlier joiner (smaller id) yields.
  p.polite = myId < p.id;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  p.pc = pc;

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }
  if (screenStream) {
    p.screenSenders = screenStream.getTracks().map((t) => pc.addTrack(t, screenStream));
  }

  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
      wsSend({ type: 'description', to: p.id, description: pc.localDescription });
    } catch (err) {
      console.error('negotiation failed:', err);
    } finally {
      p.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) wsSend({ type: 'candidate', to: p.id, candidate });
  };

  pc.ontrack = ({ streams }) => {
    for (const stream of streams) {
      if (!p.streams.has(stream.id)) {
        p.streams.set(stream.id, stream);
        stream.addEventListener('removetrack', () => {
          if (stream.getTracks().length === 0) {
            p.streams.delete(stream.id);
            resolveRemoteTiles(p);
          }
        });
      }
    }
    resolveRemoteTiles(p);
    updateCountStatus();
  };

  pc.onconnectionstatechange = () => {
    if (p.pc && (p.pc.connectionState === 'failed' || p.pc.connectionState === 'disconnected')) {
      setStatus(`Участник ${p.id}: соединение ${p.pc.connectionState}`);
    }
  };

  return pc;
}

// Creates/removes tiles for a peer's streams based on their stream-meta.
function resolveRemoteTiles(p) {
  for (const [sid, stream] of p.streams) {
    const kind = p.meta[sid];
    if (!kind) continue;
    upsertTile(`${p.id}-${kind}`, stream, {
      muted: false,
      label: kind === 'cam' ? camLabel(p.id) : screenLabel(p.id),
    });
  }
  // Drop this peer's tiles whose kind is no longer announced.
  for (const id of [...tiles.keys()]) {
    if (!id.startsWith(`${p.id}-`)) continue;
    const kind = id.split('-')[1];
    if (!Object.values(p.meta).includes(kind)) removeTile(id);
  }
}

function teardownPeer(id) {
  const p = peers.get(id);
  if (!p) return;
  if (p.pc) p.pc.close();
  peers.delete(id);
  for (const tileId of [...tiles.keys()]) {
    if (tileId.startsWith(`${id}-`)) removeTile(tileId);
  }
}

function sendMeta() {
  const streams = { [localStream.id]: 'cam' };
  if (screenStream) streams[screenStream.id] = 'screen';
  wsSend({ type: 'stream-meta', streams });
}

// --- Signaling ---

async function join() {
  const room = roomInput.value.trim();
  if (!room) {
    roomInput.focus();
    return;
  }

  joinBtn.disabled = true;
  setStatus('Запрос доступа к камере и микрофону…');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.warn('getUserMedia video+audio failed:', err.name, err.message);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setStatus(`Камера недоступна (${err.name}: ${err.message}) — звонок только со звуком.`);
    } catch (audioErr) {
      setStatus(`Нет доступа к камере/микрофону: ${audioErr.name}: ${audioErr.message}`);
      joinBtn.disabled = false;
      return;
    }
  }

  joinPanel.hidden = true;
  stageSection.hidden = false;
  controlsSection.hidden = false;

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${wsProto}://${location.host}`);

  ws.onopen = () => {
    setStatus(`Комната «${room}» — подключение…`);
    wsSend({ type: 'join', room });
  };

  ws.onmessage = (event) => handleSignal(JSON.parse(event.data));
  ws.onclose = () => setStatus('Соединение с сервером закрыто.');
}

async function handleSignal(msg) {
  switch (msg.type) {
    case 'joined':
      myId = msg.id;
      upsertTile(`${myId}-cam`, localStream, { muted: true, label: camLabel(myId) });
      if (msg.peers.length) {
        setStatus('Подключение к участникам…');
        for (const pid of msg.peers) {
          createPeerConnection(peerState(pid));
        }
        sendMeta();
      } else {
        setStatus('Ожидание собеседников…');
      }
      break;

    case 'room-full':
      setStatus('Комната заполнена (максимум 8 участников).');
      hangup();
      break;

    case 'peer-joined':
      setStatus(`Участник ${msg.id} подключается…`);
      createPeerConnection(peerState(msg.id));
      sendMeta();
      wsSend({ type: 'layout-all', layout });
      break;

    case 'description': {
      const p = peerState(msg.from);
      createPeerConnection(p);
      const desc = msg.description;
      const collision = desc.type === 'offer' && (p.makingOffer || p.pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) break;

      await p.pc.setRemoteDescription(desc);
      for (const c of p.pendingCandidates) {
        try {
          await p.pc.addIceCandidate(c);
        } catch (err) {
          console.warn('addIceCandidate (queued) failed:', err);
        }
      }
      p.pendingCandidates = [];

      if (desc.type === 'offer') {
        await p.pc.setLocalDescription();
        wsSend({ type: 'description', to: p.id, description: p.pc.localDescription });
      }
      break;
    }

    case 'candidate': {
      const p = peerState(msg.from);
      if (p.pc?.remoteDescription) {
        try {
          await p.pc.addIceCandidate(msg.candidate);
        } catch (err) {
          if (!p.ignoreOffer) console.warn('addIceCandidate failed:', err);
        }
      } else {
        p.pendingCandidates.push(msg.candidate);
      }
      break;
    }

    case 'stream-meta': {
      const p = peerState(msg.from);
      p.meta = msg.streams ?? {};
      resolveRemoteTiles(p);
      break;
    }

    case 'layout':
      layout[msg.id] = msg.rect;
      applyLayout();
      break;

    case 'layout-all':
      Object.assign(layout, msg.layout);
      applyLayout();
      break;

    case 'peer-left':
      teardownPeer(msg.id);
      updateCountStatus();
      break;
  }
}

// --- Screen sharing ---

async function startScreenShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      // Screen/tab audio. On macOS Chrome this only works when sharing a tab
      // (the "share tab audio" checkbox); whole-screen audio is Windows-only.
      audio: true,
      systemAudio: 'include',
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      setStatus(`Демонстрация экрана не удалась: ${err.name}: ${err.message}`);
    }
    return;
  }

  screenStream = stream;
  for (const p of peers.values()) {
    if (p.pc) {
      // addTrack fires negotiationneeded — renegotiation happens automatically.
      p.screenSenders = stream.getTracks().map((t) => p.pc.addTrack(t, stream));
    }
  }

  // Local preview tile is always muted, otherwise tab audio would echo.
  upsertTile(`${myId}-screen`, stream, { muted: true, label: screenLabel(myId) });
  sendMeta();

  stream.getVideoTracks()[0].addEventListener('ended', () => stopScreenShare());

  screenBtn.classList.add('off');
  screenBtn.textContent = '🖥 Стоп';
  setStatus('Экран добавлен на полотно.');
}

function stopScreenShare() {
  if (!screenStream) return;

  for (const p of peers.values()) {
    if (!p.pc) continue;
    for (const sender of p.screenSenders) {
      try {
        p.pc.removeTrack(sender); // fires negotiationneeded
      } catch {
        // pc may already be closed
      }
    }
    p.screenSenders = [];
  }

  for (const track of screenStream.getTracks()) track.stop();
  screenStream = null;

  removeTile(`${myId}-screen`);
  sendMeta();

  screenBtn.classList.remove('off');
  screenBtn.textContent = '🖥 Экран';
  setStatus('Демонстрация экрана завершена.');
}

// --- Controls ---

function toggleTrack(kind, btn, onLabel, offLabel) {
  const track = localStream?.getTracks().find((t) => t.kind === kind);
  if (!track) {
    setStatus(kind === 'video' ? 'Видеотрека нет: камера не была получена при входе.' : 'Аудиотрека нет.');
    return;
  }
  track.enabled = !track.enabled;
  btn.classList.toggle('off', !track.enabled);
  btn.textContent = track.enabled ? onLabel : offLabel;
}

function toggleStageFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (stage.requestFullscreen) {
    stage.requestFullscreen();
  } else if (stage.webkitRequestFullscreen) {
    stage.webkitRequestFullscreen();
  }
}

function hangup() {
  for (const id of [...peers.keys()]) teardownPeer(id);

  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  if (screenStream) {
    for (const track of screenStream.getTracks()) track.stop();
    screenStream = null;
  }
  if (localStream) {
    for (const track of localStream.getTracks()) track.stop();
    localStream = null;
  }

  for (const id of [...tiles.keys()]) removeTile(id);
  for (const id of Object.keys(layout)) delete layout[id];
  myId = null;

  stageSection.hidden = true;
  controlsSection.hidden = true;
  joinPanel.hidden = false;
  joinBtn.disabled = false;
  micBtn.classList.remove('off');
  camBtn.classList.remove('off');
  micBtn.textContent = '🎤 Микрофон';
  camBtn.textContent = '📷 Камера';
  screenBtn.classList.remove('off');
  screenBtn.textContent = '🖥 Экран';
  setStatus('Не подключено');
}

joinBtn.addEventListener('click', join);
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});
micBtn.addEventListener('click', () => toggleTrack('audio', micBtn, '🎤 Микрофон', '🎤 Выкл'));
camBtn.addEventListener('click', () => toggleTrack('video', camBtn, '📷 Камера', '📷 Выкл'));
screenBtn.addEventListener('click', () => (screenStream ? stopScreenShare() : startScreenShare()));
stageFsBtn.addEventListener('click', toggleStageFullscreen);
hangupBtn.addEventListener('click', hangup);
