/**
 * RoomManager.js — Fixed version
 * Key fixes:
 *  - peer-joined now also sends an offer (bidirectional negotiation)
 *  - _attachRemoteAudio uses ontrack callback directly, not timeout
 *  - audio element uses playsInline + muted unlock trick for iOS
 */

class RoomManager {
  constructor(engine, socket) {
    this.engine = engine;
    this.socket = socket;
    this.roomId = null;
    this.mySocketId = null;
    this.myUserId = null;
    this.userName = null;
    this.isHost = false;
    this.seats = Array(8).fill(null);
    this.peers = {};
    this.roomState = 'disconnected';
    this.eventHandlers = [];
    this._reconnectAttempts = 0;
    this._maxReconnect = 5;
    this._bindSocketEvents();
  }

  async signIn({ userName }) {
    this.userName = userName;
    await this.engine.init();
    await this.engine.startLocalStream();
    this._emit('onSignedIn', { userName });
    console.log(`[Room] Signed in as ${userName}`);
  }

  async loginRoom({ roomId, isHost = false }) {
    if (!this.userName) throw new Error('Call signIn() first');
    this.roomId = roomId;
    this.isHost = isHost;
    this.roomState = 'connecting';
    this._emit('onRoomStateChanged', { state: 'connecting', roomId });
    this.socket.emit('join-room', { roomId, userName: this.userName });
  }

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

  async autoTakeSeat0AsHost() {
    if (!this.isHost) return;
    await this.takeSeat(0);
    this._broadcastRoomSignal({ type: 'seat_update', seats: this.seats });
  }

  async takeSeat(seatIndex) {
    if (seatIndex < 0 || seatIndex > 7) return;
    if (this.seats[seatIndex]) { this._emit('onSeatTakeFailed', { seatIndex, reason: 'occupied' }); return; }
    const curIdx = this.seats.findIndex(s => s?.socketId === this.mySocketId);
    if (curIdx !== -1) this.seats[curIdx] = null;
    this.seats[seatIndex] = { socketId: this.mySocketId, userId: this.myUserId, userName: this.userName, muted: this.engine.micMuted };
    this._broadcastRoomSignal({ type: 'seat_update', seats: this.seats });
    this._emit('onSeatChanged', { seatIndex, user: this.seats[seatIndex] });
  }

  sendSeatInvite(targetSocketId, seatIndex) { this._sendCustomCommand(targetSocketId, { type: 'seat_invite', seatIndex }); }

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

  toggleMic() {
    const muted = this.engine.toggleMic();
    this.socket.emit('toggle-mute', { roomId: this.roomId, muted });
    const idx = this.seats.findIndex(s => s?.socketId === this.mySocketId);
    if (idx !== -1 && this.seats[idx]) this.seats[idx].muted = muted;
    this._broadcastRoomSignal({ type: 'seat_update', seats: this.seats });
    return muted;
  }

  muteAllRemote(muted) { this.engine.setAllRemoteMuted(muted); }
  setVoiceEffect(preset) { this.engine.setVoiceEffect(preset); }
  startSoundLevels() { this.engine.startSoundLevelMonitoring(); }
  stopSoundLevels() { this.engine.stopSoundLevelMonitoring(); }

  _broadcastRoomSignal(data) { this.socket.emit('barrage', { roomId: this.roomId, data }); }
  _sendCustomCommand(targetSocketId, data) { this.socket.emit('custom-command', { to: targetSocketId, data }); }

  createBGMPlayer() { return this.engine.createMediaPlayer(); }
  loadBGM(url) { this.engine.loadMedia(url); }
  playBGM() { this.engine.playMedia(); }
  pauseBGM() { this.engine.pauseMedia(); }
  stopBGM() { this.engine.stopMedia(); }
  setBGMVolume(v) { this.engine.setMediaVolume(v); }
  destroyBGMPlayer() { this.engine.destroyMediaPlayer(); }

  // FIX: register ontrack BEFORE creating offer so we never miss it
  async _startPublishingTo(socketId) {
    const pc = await this.engine.createPeerConnection(socketId, true);

    // attach audio as soon as track arrives
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      this.engine.remoteStreams[socketId] = stream;
      this.engine._setupRemoteAnalyser(socketId, stream);
      this.engine._emit('onRemoteStreamAdded', { socketId, stream });
      this._attachRemoteAudio(socketId, stream);
    };

    const offer = await this.engine.createOffer(socketId);
    this.socket.emit('offer', { to: socketId, offer });
    console.log(`[Room] Sent offer to ${socketId}`);
  }

  addEventHandler(handler) { this.engine.addEventHandler(handler); this.eventHandlers.push(handler); }
  removeEventHandler(handler) { this.engine.removeEventHandler(handler); this.eventHandlers = this.eventHandlers.filter(h => h !== handler); }

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
  }

  async logout() {
    await this.leaveRoom();
    this.engine.destroy();
    this._emit('onSignedOut', {});
  }

  _bindSocketEvents() {
    const s = this.socket;

    s.on('room-joined', async ({ roomId, userId, peers }) => {
      this.mySocketId = s.id;
      this.myUserId = userId;
      this.roomState = 'connected';
      this._reconnectAttempts = 0;
      peers.forEach(p => { this.peers[p.socketId] = p; });
      this._emit('onRoomStateChanged', { state: 'connected', roomId });
      if (this.isHost) await this.autoTakeSeat0AsHost();
      // Send offer to every existing peer
      for (const peer of peers) {
        await this._startPublishingTo(peer.socketId);
      }
      this._emit('onRoomJoined', { roomId, peers });
    });

    // FIX: when a new peer joins, the EXISTING users must also send them an offer
    // Previously this was missing — only the new joiner sent offers, not the existing peers
    s.on('peer-joined', async ({ socketId, userName }) => {
      this.peers[socketId] = { socketId, userName, muted: false };
      this._emit('onPeerJoined', { socketId, userName });
      // Existing peer sends offer to the newcomer
      await this._startPublishingTo(socketId);
    });

    s.on('peer-left', ({ socketId }) => {
      const peer = this.peers[socketId];
      this.engine.closePeerConnection(socketId);
      // Remove their audio element
      const el = document.getElementById(`audio-${socketId}`);
      if (el) el.remove();
      delete this.peers[socketId];
      const idx = this.seats.findIndex(s => s?.socketId === socketId);
      if (idx !== -1) { this.seats[idx] = null; }
      this._emit('onPeerLeft', { socketId, userName: peer?.userName });
      this._emit('onSeatUpdate', { seats: this.seats });
    });

    // FIX: answerer also needs to set up ontrack before handling offer
    s.on('offer', async ({ from, offer }) => {
      console.log(`[Room] Got offer from ${from}`);
      const pc = await this.engine.createPeerConnection(from, false);

      // FIX: attach ontrack on answerer side too
      pc.ontrack = (e) => {
        const stream = e.streams[0] || new MediaStream([e.track]);
        this.engine.remoteStreams[from] = stream;
        this.engine._setupRemoteAnalyser(from, stream);
        this.engine._emit('onRemoteStreamAdded', { socketId: from, stream });
        this._attachRemoteAudio(from, stream);
      };

      const answer = await this.engine.handleOffer(from, offer);
      s.emit('answer', { to: from, answer });
    });

    s.on('answer', async ({ from, answer }) => {
      console.log(`[Room] Got answer from ${from}`);
      await this.engine.handleAnswer(from, answer);
    });

    s.on('ice-candidate', async ({ from, candidate }) => {
      await this.engine.handleICECandidate(from, candidate);
    });

    s.on('peer-mute-changed', ({ socketId, muted }) => {
      if (this.peers[socketId]) this.peers[socketId].muted = muted;
      const idx = this.seats.findIndex(s => s?.socketId === socketId);
      if (idx !== -1 && this.seats[idx]) this.seats[idx].muted = muted;
      this._emit('onPeerMuteChanged', { socketId, muted });
    });

    s.on('barrage', ({ from, data }) => {
      if (data.type === 'seat_update') {
        this.seats = data.seats;
        this._emit('onSeatUpdate', { seats: this.seats });
      }
      this._emit('onBarrageReceived', { from, data });
    });

    s.on('custom-command', ({ from, data }) => {
      if (data.type === 'seat_invite') this._emit('onSeatInviteReceived', { from, seatIndex: data.seatIndex });
      if (data.type === 'removed_from_seat') { this.leaveSeat(); this._emit('onRemovedFromSeat', { seatIndex: data.seatIndex }); }
      this._emit('onCustomCommand', { from, data });
    });

    s.on('connect', () => {
      if (this.roomState === 'reconnecting') this.loginRoom({ roomId: this.roomId, isHost: this.isHost });
    });

    s.on('disconnect', () => {
      this.roomState = 'reconnecting';
      this._emit('onRoomStateChanged', { state: 'reconnecting' });
      this._attemptReconnect();
    });
  }

  // FIX: attach stream directly (no timeout), unlock autoplay for mobile
  _attachRemoteAudio(socketId, stream) {
    let el = document.getElementById(`audio-${socketId}`);
    if (!el) {
      el = document.createElement('audio');
      el.id = `audio-${socketId}`;
      el.setAttribute('data-remote', 'true');
      el.autoplay = true;
      el.playsInline = true;   // iOS fix
      el.controls = false;
      document.body.appendChild(el);
    }
    el.srcObject = stream;

    // FIX: browsers block autoplay — play() explicitly
    el.play().catch(err => {
      console.warn('[Room] Autoplay blocked, waiting for user gesture:', err.message);
      // Show unlock button if autoplay blocked
      this._showAutoplayUnlock(socketId, el);
    });

    console.log(`[Room] Audio attached for ${socketId}`);
    this._emit('onAudioAttached', { socketId });
  }

  _showAutoplayUnlock(socketId, el) {
    let btn = document.getElementById('autoplay-unlock-btn');
    if (btn) return;
    btn = document.createElement('button');
    btn.id = 'autoplay-unlock-btn';
    btn.textContent = '🔊 Tap to hear audio';
    btn.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;background:#6c63ff;color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:15px;cursor:pointer;';
    btn.onclick = () => {
      document.querySelectorAll('audio[data-remote]').forEach(a => a.play().catch(() => {}));
      btn.remove();
    };
    document.body.appendChild(btn);
  }

  _emit(event, data) { this.eventHandlers.forEach(h => { if (typeof h[event] === 'function') h[event](data); }); }
}

window.RoomManager = RoomManager;
