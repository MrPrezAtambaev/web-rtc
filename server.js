import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      // The client and signaling protocol evolve together — a stale cached
      // main.js can't talk to the current server, so always revalidate.
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

// --- Signaling ---
// Rooms hold up to MAX_PEERS peers (full mesh on the clients, so keep it
// small). Each peer gets a unique numeric id; the id doubles as a stable
// identity for shared-layout tile ids. The server only relays messages:
// messages with `to` go to that peer, the rest are broadcast to the room.
// `from` is stamped by the server so clients can't spoof it.
const MAX_PEERS = 8;
const rooms = new Map(); // roomId -> Map<peerId, WebSocket>
let nextPeerId = 1;

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.peerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const roomId = String(msg.room || '').slice(0, 64);
      if (!roomId || ws.peerId !== null) return;

      const room = rooms.get(roomId) ?? new Map();
      if (room.size >= MAX_PEERS) {
        ws.send(JSON.stringify({ type: 'room-full' }));
        return;
      }

      const id = nextPeerId++;
      room.set(id, ws);
      rooms.set(roomId, room);
      ws.roomId = roomId;
      ws.peerId = id;

      ws.send(JSON.stringify({ type: 'joined', id, peers: [...room.keys()].filter((p) => p !== id) }));
      for (const [pid, peer] of room) {
        if (pid !== id && peer.readyState === peer.OPEN) {
          peer.send(JSON.stringify({ type: 'peer-joined', id }));
        }
      }
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room) return;
    msg.from = ws.peerId;
    const data = JSON.stringify(msg);

    if (msg.to != null) {
      const target = room.get(msg.to);
      if (target && target.readyState === target.OPEN) target.send(data);
      return;
    }
    for (const [pid, peer] of room) {
      if (pid !== ws.peerId && peer.readyState === peer.OPEN) peer.send(data);
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room || room.get(ws.peerId) !== ws) return;
    room.delete(ws.peerId);
    if (room.size === 0) {
      rooms.delete(ws.roomId);
      return;
    }
    const data = JSON.stringify({ type: 'peer-left', id: ws.peerId });
    for (const peer of room.values()) {
      if (peer.readyState === peer.OPEN) peer.send(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`WebRTC demo running at http://localhost:${PORT}`);
});
