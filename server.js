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

// roomId -> { socketId: { userId, userName, muted } }
const rooms = {};
// roomId -> [8] seat slots (null or { socketId, userId, userName, muted })
const roomSeats = {};
// roomId -> host socket id
const roomHosts = {};

function emptySeats() {
  return Array(8).fill(null);
}

function getOrCreateSeats(roomId) {
  if (!roomSeats[roomId]) roomSeats[roomId] = emptySeats();
  return roomSeats[roomId];
}

function getRoomPeers(roomId, excludeSocketId = null) {
  if (!rooms[roomId]) return [];
  return Object.entries(rooms[roomId])
    .filter(([sid]) => sid !== excludeSocketId)
    .map(([sid, info]) => ({ socketId: sid, ...info }));
}

function clearUserFromSeats(roomId, socketId) {
  const seats = getOrCreateSeats(roomId);
  let changed = false;
  for (let i = 0; i < 8; i++) {
    if (seats[i]?.socketId === socketId) {
      seats[i] = null;
      changed = true;
    }
  }
  return changed;
}

function broadcastSeats(roomId) {
  io.to(roomId).emit('seat-update', { seats: getOrCreateSeats(roomId) });
}

function cleanupRoom(roomId) {
  if (rooms[roomId] && Object.keys(rooms[roomId]).length === 0) {
    delete rooms[roomId];
    delete roomSeats[roomId];
    delete roomHosts[roomId];
  }
}

function leaveRoomInternal(socket, roomId) {
  if (!rooms[roomId]?.[socket.id]) return;

  delete rooms[roomId][socket.id];
  if (roomHosts[roomId] === socket.id) delete roomHosts[roomId];

  const seatsChanged = clearUserFromSeats(roomId, socket.id);
  socket.to(roomId).emit('peer-left', { socketId: socket.id });
  socket.leave(roomId);

  if (seatsChanged) broadcastSeats(roomId);
  cleanupRoom(roomId);
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  socket.on('join-room', ({ roomId, userName, isHost }) => {
    if (!roomId || !userName) return;

    for (const [rid, peers] of Object.entries(rooms)) {
      if (peers[socket.id]) {
        leaveRoomInternal(socket, rid);
      }
    }

    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = {};

    const userId = socket.id;
    rooms[roomId][socket.id] = { userId, userName, muted: false };

    if (isHost) roomHosts[roomId] = socket.id;

    const existingPeers = getRoomPeers(roomId, socket.id);
    const seats = getOrCreateSeats(roomId);

    socket.emit('room-joined', { roomId, userId, peers: existingPeers, seats });
    socket.to(roomId).emit('peer-joined', { socketId: socket.id, userId, userName });

    console.log(`[Room ${roomId}] ${userName} joined. Peers: ${Object.keys(rooms[roomId]).length}`);
  });

  socket.on('take-seat', ({ roomId, seatIndex }) => {
    if (!rooms[roomId]?.[socket.id]) return;
    const seats = getOrCreateSeats(roomId);
    const idx = Number(seatIndex);
    if (idx < 0 || idx > 7) return;

    if (seats[idx]) {
      socket.emit('seat-take-failed', { seatIndex: idx, reason: 'occupied' });
      return;
    }

    clearUserFromSeats(roomId, socket.id);
    const peer = rooms[roomId][socket.id];
    seats[idx] = {
      socketId: socket.id,
      userId: peer.userId,
      userName: peer.userName,
      muted: peer.muted
    };
    broadcastSeats(roomId);
    console.log(`[Room ${roomId}] ${peer.userName} took seat ${idx}`);
  });

  socket.on('leave-seat', ({ roomId }) => {
    if (!rooms[roomId]?.[socket.id]) return;
    if (clearUserFromSeats(roomId, socket.id)) {
      broadcastSeats(roomId);
    }
  });

  socket.on('remove-from-seat', ({ roomId, seatIndex }) => {
    if (roomHosts[roomId] !== socket.id) return;
    const seats = getOrCreateSeats(roomId);
    const idx = Number(seatIndex);
    if (idx < 0 || idx > 7) return;

    const occupant = seats[idx];
    if (!occupant) return;

    seats[idx] = null;
    io.to(occupant.socketId).emit('removed-from-seat', { seatIndex: idx });
    broadcastSeats(roomId);
  });

  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('toggle-mute', ({ roomId, muted }) => {
    if (rooms[roomId]?.[socket.id]) {
      rooms[roomId][socket.id].muted = muted;
      const seats = getOrCreateSeats(roomId);
      let seatChanged = false;
      for (let i = 0; i < 8; i++) {
        if (seats[i]?.socketId === socket.id) {
          seats[i].muted = muted;
          seatChanged = true;
        }
      }
      socket.to(roomId).emit('peer-mute-changed', { socketId: socket.id, muted });
      if (seatChanged) broadcastSeats(roomId);
    }
  });

  socket.on('barrage', ({ roomId, data }) => {
    socket.to(roomId).emit('barrage', { from: socket.id, data });
  });

  socket.on('custom-command', ({ to, data }) => {
    io.to(to).emit('custom-command', { from: socket.id, data });
  });

  socket.on('leave-room', ({ roomId }) => {
    leaveRoomInternal(socket, roomId);
  });

  socket.on('disconnect', () => {
    for (const [rid, peers] of Object.entries(rooms)) {
      if (peers[socket.id]) {
        leaveRoomInternal(socket, rid);
        console.log(`[-] ${socket.id} left room ${rid}`);
      }
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });

  socket.on('get-room-info', ({ roomId }) => {
    const peers = rooms[roomId] ? Object.values(rooms[roomId]) : [];
    socket.emit('room-info', {
      roomId,
      peerCount: peers.length,
      peers,
      seats: getOrCreateSeats(roomId)
    });
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎙️  WebRTC Voice Server running on http://localhost:${PORT}\n`);
});
