/**
 * RoomManager.js
 * Replaces: ZEGOLiveAudioRoomManager + ZEGOSDKManager.loginRoom
 * Handles: seats, host logic, publish/play streams, room state, IM/signaling
 */

class RoomManager {
  constructor(engine, socket) {
    this.engine = engine;      // VoiceEngine instance
    this.socket = socket;      // Socket.io client

    this.roomId = null;
    this.mySocketId = null;
    this.myUserId = null;
    this.userName = null;
    this.isHost = false;

    // Seat map: seatIndex (0–7) → { socketId, userId, userName, muted }
    this.seats = Array(8).fill(null);
    this.peers = {};           // socketId → { userId, userName, muted }

    this.roomState = 'disconnected'; // disconnected | connecting | connected | reconnecting
    this.eventHandlers = [];
    this._reconnectAttempts = 0;
    this._maxReconnect = 5;

    this._bindSocketEvents();
  }

  // ── 1. SDK Bootstrap / Sign-in ────────────────────────────────────────────
  async signIn({ userName }) {
    this.userName = userName;
    await this.engine.init();
    await this.engine.startLocalStream();
    this._emit('onSignedIn', { userName });
    console.log(`[Room] Signed in as ${userName}`);
  }

  // ── 2. Room login / reconnect ─────────────────────────────────────────────
  async loginRoom({ roomId, isHost = false }) {
    if (!this.userName) throw new Error('Call signIn() first');
    this.roomId = roomId;
    this.isHost = isHost;
    this.roomState = 'connecting';
    this._emit('onRoomStateChanged', { state: 'connecting', roomId });

    this.socket.emit('join-room', { roomId, userName: this.userName });
  }

  // ── 2.1 Reconnect logic ───────────────────────────────────────────────────
  _attemptReconnect() {
    if (this._reconnectAttempts >= this._maxReconnect) {
      this.roomState = 'disconnected';
      this._emit('onRoomStateChanged', { state: 'reconnect_failed' });
      return;
    }
    this._reconnectAttempts++;
    this.roomState = 'reconnecting';
    this._emit('onRoomStateChanged', { state: 'reconnecting', attempt: this._reconnectAttempts });
    setTimeout(() => {
      if (this.roomId) this.socket.emit('join-room', { roomId: this.roomId, userName: this.userName });
    }, Math.min(1000 * this._reconnectAttempts, 8000));
  }

  // ── 3. Seat Management ────────────────────────────────────────────────────

  // 3.2 Auto-seat host at seat 0 + publish
  async autoTakeSeat0AsHost() {
    if (!this.isHost) return;
    await this.takeSeat(0);
    this._broadcastRoomSignal({ type: 'seat_update', seats: this.seats });
    console.log('[Room] Host auto-took seat 0');
  }

  // 3.3 Take / switch seat
  async takeSeat(seatIndex) {
    if (seatIndex < 0 || seatIndex > 7) return;
    if (this.seats[seatIndex]) {
      this._emit('onSeatTakeFailed', { seatIndex, reason: 'occupied' });
      return;
    }

    // Remove from current seat if any
    const curIdx = this.seats.findIndex(s => s?.socketId === this.mySocketId);
    if (curIdx !== -1) this.seats[curIdx] = null;

    this.seats[seatIndex] = {
      socketId: this.mySocketId,
      userId: this.myUserId,
      userName: this.userName,
      muted: this.engine.micMuted
    };

    this._broadcastRoomSignal({ type: 'seat_update', seats: this.seats });
    this._emit('onSeatChanged', { seatIndex, user: this.seats[seatIndex] });
    console.log(`[Room] Took seat ${seatIndex}`);
  }

  // 3.3 Invite user to seat (host sends invite)
  sendSeatInvite(targetSocketId, seatIndex) {
    this._sendCustomCommand(targetSocketId, { type: 'seat_invite', seatIndex });
  }

  // 3.4 Remove speaker from seat (host only)
  removeSpeakerFromSeat(seatIndex) {
    if (!this.isHost) return;
    const occupant = this.seats[seatIndex];
    if (!occupant) return;
    this.seats[seatIndex] = null;
    this._sendCustomCommand(occupant.socketId, { type: 'removed_from_seat', seatIndex });
    this._broadcastRoomSignal({ type: 'seat_update', seats: this.seats });
    this._emit('onSeatRemoved', { seatIndex, removedUser: occupant });
  }

  leaveSeat() {
    const idx = this.seats.findIndex(s => s?.socketId === this.mySocketId);
    if (idx !== -1) {
      this.seats[idx] = null;
      this._broadcastRoomSignal({ type: 'seat_update', seats: this.seats });
      this._emit('onSeatChanged', { seatIndex: idx, user: null });
    }
  }

  // ── 4. Audio Controls ─────────────────────────────────────────────────────
  toggleMic() {
    const muted = this.engine.toggleMic();
    this.socket.emit('toggle-mute', { roomId: this.roomId, muted });
    // Sync seat state
    const idx = this.seats.findIndex(s => s?.socketId === this.mySocketId);
    if (idx !== -1 && this.seats[idx]) this.seats[idx].muted = muted;
    this._broadcastRoomSignal({ type: 'seat_update', seats: this.seats });
    return muted;
  }

  muteAllRemote(muted) {
    this.engine.setAllRemoteMuted(muted);
  }

  setVoiceEffect(preset) {
    this.engine.setVoiceEffect(preset);
  }

  startSoundLevels() { this.engine.startSoundLevelMonitoring(); }
  stopSoundLevels() { this.engine.stopSoundLevelMonitoring(); }

  // ── 5. IM / Barrage / Custom Commands ─────────────────────────────────────

  // 5.2 Send barrage (room-wide broadcast)
  _broadcastRoomSignal(data) {
    this.socket.emit('barrage', { roomId: this.roomId, data });
  }

  // 5.3 Send custom command (targeted)
  _sendCustomCommand(targetSocketId, data) {
    this.socket.emit('custom-command', { to: targetSocketId, data });
  }

  // 5.1 Barrage received → handled in _bindSocketEvents → onBarrageReceived
  // 5.3 Custom command received → handled in _bindSocketEvents → onCustomCommand

  // ── 7. Media Player (BGM) ─────────────────────────────────────────────────
  createBGMPlayer() { return this.engine.createMediaPlayer(); }
  loadBGM(url) { this.engine.loadMedia(url); }
  playBGM() { this.engine.playMedia(); }
  pauseBGM() { this.engine.pauseMedia(); }
  stopBGM() { this.engine.stopMedia(); }
  setBGMVolume(v) { this.engine.setMediaVolume(v); }
  destroyBGMPlayer() { this.engine.destroyMediaPlayer(); }

  // ── 8. Stream publish/play ────────────────────────────────────────────────
  async _startPublishingTo(socketId) {
    const pc = await this.engine.createPeerConnection(socketId, true);
    const offer = await this.engine.createOffer(socketId);
    this.socket.emit('offer', { to: socketId, offer });
  }

  // ── 9. Event handler registration ────────────────────────────────────────
  addEventHandler(handler) { this.engine.addEventHandler(handler); this.eventHandlers.push(handler); }
  removeEventHandler(handler) { this.engine.removeEventHandler(handler); this.eventHandlers = this.eventHandlers.filter(h => h !== handler); }

  // ── 10. Logout / disconnect ───────────────────────────────────────────────
  async leaveRoom() {
    this.leaveSeat();
    this.stopSoundLevels();
    this.engine.closeAllPeerConnections();
    this.engine.stopLocalStream();
    this.engine.destroyMediaPlayer();
    this.socket.emit('leave-room', { roomId: this.roomId });
    this.roomState = 'disconnected';
    this.seats = Array(8).fill(null);
    this.peers = {};
    this._emit('onRoomStateChanged', { state: 'disconnected' });
    this._emit('onLeftRoom', { roomId: this.roomId });
    console.log('[Room] Left room:', this.roomId);
  }

  async logout() {
    await this.leaveRoom();
    this.engine.destroy();
    this._emit('onSignedOut', {});
  }

  // ── Socket Event Bindings ─────────────────────────────────────────────────
  _bindSocketEvents() {
    const s = this.socket;

    // Room joined → get existing peers, setup connections
    s.on('room-joined', async ({ roomId, userId, peers }) => {
      this.mySocketId = s.id;
      this.myUserId = userId;
      this.roomState = 'connected';
      this._reconnectAttempts = 0;
      peers.forEach(p => { this.peers[p.socketId] = p; });
      this._emit('onRoomStateChanged', { state: 'connected', roomId });

      // If host, auto-take seat 0
      if (this.isHost) await this.autoTakeSeat0AsHost();

      // Start publishing to all existing peers
      for (const peer of peers) {
        await this._startPublishingTo(peer.socketId);
      }

      this._emit('onRoomJoined', { roomId, peers });
    });

    // New peer joined → answer their offer
    s.on('peer-joined', ({ socketId, userName }) => {
      this.peers[socketId] = { socketId, userName, muted: false };
      this._emit('onPeerJoined', { socketId, userName });
    });

    // Peer left
    s.on('peer-left', ({ socketId }) => {
      const peer = this.peers[socketId];
      this.engine.closePeerConnection(socketId);
      delete this.peers[socketId];
      // Free their seat
      const idx = this.seats.findIndex(s => s?.socketId === socketId);
      if (idx !== -1) { this.seats[idx] = null; }
      this._emit('onPeerLeft', { socketId, userName: peer?.userName });
      this._emit('onSeatUpdate', { seats: this.seats });
    });

    // WebRTC signaling
    s.on('offer', async ({ from, offer }) => {
      const pc = await this.engine.createPeerConnection(from, false);
      const answer = await this.engine.handleOffer(from, offer);
      s.emit('answer', { to: from, answer });
      this._attachRemoteAudio(from);
    });

    s.on('answer', async ({ from, answer }) => {
      await this.engine.handleAnswer(from, answer);
      this._attachRemoteAudio(from);
    });

    s.on('ice-candidate', async ({ from, candidate }) => {
      await this.engine.handleICECandidate(from, candidate);
    });

    // Peer mute
    s.on('peer-mute-changed', ({ socketId, muted }) => {
      if (this.peers[socketId]) this.peers[socketId].muted = muted;
      const idx = this.seats.findIndex(s => s?.socketId === socketId);
      if (idx !== -1 && this.seats[idx]) this.seats[idx].muted = muted;
      this._emit('onPeerMuteChanged', { socketId, muted });
    });

    // 5.1 Barrage received
    s.on('barrage', ({ from, data }) => {
      if (data.type === 'seat_update') {
        this.seats = data.seats;
        this._emit('onSeatUpdate', { seats: this.seats });
      }
      this._emit('onBarrageReceived', { from, data });
    });

    // 5.3 Custom command received
    s.on('custom-command', ({ from, data }) => {
      if (data.type === 'seat_invite') {
        this._emit('onSeatInviteReceived', { from, seatIndex: data.seatIndex });
      }
      if (data.type === 'removed_from_seat') {
        this.leaveSeat();
        this._emit('onRemovedFromSeat', { seatIndex: data.seatIndex });
      }
      this._emit('onCustomCommand', { from, data });
    });

    // 6. Room state callbacks
    s.on('connect', () => {
      if (this.roomState === 'reconnecting') {
        this.loginRoom({ roomId: this.roomId, isHost: this.isHost });
      }
    });

    s.on('disconnect', () => {
      this.roomState = 'reconnecting';
      this._emit('onRoomStateChanged', { state: 'reconnecting' });
      this._attemptReconnect();
    });
  }

  _attachRemoteAudio(socketId) {
    setTimeout(() => {
      const stream = this.engine.remoteStreams[socketId];
      if (!stream) return;
      let el = document.getElementById(`audio-${socketId}`);
      if (!el) {
        el = document.createElement('audio');
        el.id = `audio-${socketId}`;
        el.setAttribute('data-remote', 'true');
        el.autoplay = true;
        document.body.appendChild(el);
      }
      el.srcObject = stream;
    }, 300);
  }

  _emit(event, data) {
    this.eventHandlers.forEach(h => { if (typeof h[event] === 'function') h[event](data); });
  }
}

window.RoomManager = RoomManager;
