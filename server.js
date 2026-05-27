const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));

// Track rooms: { roomId: { socketId: { userId, userName, muted } } }
const rooms = {};

function getRoomPeers(roomId, excludeSocketId = null) {
  if (!rooms[roomId]) return [];
  return Object.entries(rooms[roomId])
    .filter(([sid]) => sid !== excludeSocketId)
    .map(([sid, info]) => ({ socketId: sid, ...info }));
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Join Room ──────────────────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, userName }) => {
    if (!roomId || !userName) return;

    // Leave any previous room
    for (const [rid, peers] of Object.entries(rooms)) {
      if (peers[socket.id]) {
        delete peers[socket.id];
        socket.to(rid).emit('peer-left', { socketId: socket.id });
        socket.leave(rid);
        if (Object.keys(peers).length === 0) delete rooms[rid];
      }
    }

    // Join new room
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = {};

    const userId = socket.id;
    rooms[roomId][socket.id] = { userId, userName, muted: false };

    // Send existing peers to the new joiner
    const existingPeers = getRoomPeers(roomId, socket.id);
    socket.emit('room-joined', { roomId, userId, peers: existingPeers });

    // Notify others
    socket.to(roomId).emit('peer-joined', { socketId: socket.id, userId, userName });

    console.log(`[Room ${roomId}] ${userName} joined. Peers: ${Object.keys(rooms[roomId]).length}`);
  });

  // ── WebRTC Signaling ───────────────────────────────────────────────────────
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ── Mute/Unmute ────────────────────────────────────────────────────────────
  socket.on('toggle-mute', ({ roomId, muted }) => {
    if (rooms[roomId]?.[socket.id]) {
      rooms[roomId][socket.id].muted = muted;
      socket.to(roomId).emit('peer-mute-changed', { socketId: socket.id, muted });
    }
  });

  // ── 5. Barrage (room-wide IM) ──────────────────────────────────────────────
  socket.on('barrage', ({ roomId, data }) => {
    socket.to(roomId).emit('barrage', { from: socket.id, data });
  });

  // ── 5. Custom command (targeted) ──────────────────────────────────────────
  socket.on('custom-command', ({ to, data }) => {
    io.to(to).emit('custom-command', { from: socket.id, data });
  });

  // ── Leave room (explicit) ─────────────────────────────────────────────────
  socket.on('leave-room', ({ roomId }) => {
    if (rooms[roomId]?.[socket.id]) {
      delete rooms[roomId][socket.id];
      socket.to(roomId).emit('peer-left', { socketId: socket.id });
      socket.leave(roomId);
      if (Object.keys(rooms[roomId]).length === 0) delete rooms[roomId];
    }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    for (const [rid, peers] of Object.entries(rooms)) {
      if (peers[socket.id]) {
        delete peers[socket.id];
        socket.to(rid).emit('peer-left', { socketId: socket.id });
        if (Object.keys(peers).length === 0) delete rooms[rid];
        console.log(`[-] ${socket.id} left room ${rid}`);
      }
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });

  // ── Room Info ──────────────────────────────────────────────────────────────
  socket.on('get-room-info', ({ roomId }) => {
    const peers = rooms[roomId] ? Object.values(rooms[roomId]) : [];
    socket.emit('room-info', { roomId, peerCount: peers.length, peers });
  });
});

// Health check endpoint
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎙️  WebRTC Voice Server running on http://localhost:${PORT}\n`);
});
