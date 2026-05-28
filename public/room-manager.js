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
    this._bindEngineEvents();
  }

  _bindEngineEvents() {
    this.engine.addEventHandler({
      onICECandidate: ({ socketId, candidate }) => {
        if (!candidate || !this.roomId) return;
        this.socket.emit('ice-candidate', {
          to: socketId,
          candidate: candidate.toJSON ? candidate.toJSON() : candidate
        });
      },
      onRemoteStreamAdded: ({ socketId, stream }) => {
        this._attachRemoteAudio(socketId, stream);
      }
    });
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
    this.socket.emit('join-room', { roomId, userName: this.userName, isHost });
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
      if (this.roomId) {
        this.socket.emit('join-room', {
          roomId: this.roomId,
          userName: this.userName,
          isHost: this.isHost
        });
      }
    }, Math.min(1000 * this._reconnectAttempts, 8000));
  }

  async autoTakeSeat0AsHost() {
    if (!this.isHost) return;
    this.takeSeat(0);
  }

  takeSeat(seatIndex) {
    if (seatIndex < 0 || seatIndex > 7 || !this.roomId) return;
    this.socket.emit('take-seat', { roomId: this.roomId, seatIndex });
  }

  _applySeats(seats) {
    if (!seats || !Array.isArray(seats)) return;
    this.seats = seats.map(s => s ? { ...s } : null);
    while (this.seats.length < 8) this.seats.push(null);
    this._emit('onSeatUpdate', { seats: this.seats });
  }

  sendSeatInvite(targetSocketId, seatIndex) { this._sendCustomCommand(targetSocketId, { type: 'seat_invite', seatIndex }); }

  removeSpeakerFromSeat(seatIndex) {
    if (!this.isHost || !this.roomId) return;
    this.socket.emit('remove-from-seat', { roomId: this.roomId, seatIndex });
  }

  leaveSeat() {
    if (!this.roomId) return;
    this.socket.emit('leave-seat', { roomId: this.roomId });
  }

  toggleMic() {
    const muted = this.engine.toggleMic();
    this.socket.emit('toggle-mute', { roomId: this.roomId, muted });
    return muted;
  }

  muteAllRemote(muted) { this.engine.setAllRemoteMuted(muted); }
  setVoiceEffect(preset) { this.engine.setVoiceEffect(preset); }
  startSoundLevels() { this.engine.startSoundLevelMonitoring(); }
  stopSoundLevels() { this.engine.stopSoundLevelMonitoring(); }

  _broadcastRoomSignal(data) { this.socket.emit('barrage', { roomId: this.roomId, data }); }
  _sendCustomCommand(targetSocketId, data) { this.socket.emit('custom-command', { to: targetSocketId, data }); }

  // Only one peer per pair sends the offer (avoids offer/answer glare).
  _shouldInitiate(remoteSocketId) {
    return this.mySocketId && this.mySocketId < remoteSocketId;
  }

  createBGMPlayer() { return this.engine.createMediaPlayer(); }
  loadBGM(url) { return this.engine.loadMedia(url); }
  playBGM() { return this.engine.playMedia(); }
  pauseBGM() { this.engine.pauseMedia(); }
  stopBGM() { this.engine.stopMedia(); }
  setBGMVolume(v) { this.engine.setMediaVolume(v); }
  destroyBGMPlayer() { this.engine.destroyMediaPlayer(); }

  async _startPublishingTo(socketId) {
    await this.engine.createPeerConnection(socketId, true);
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

    s.on('room-joined', async ({ roomId, userId, peers, seats }) => {
      this.mySocketId = s.id;
      this.myUserId = userId;
      this.roomState = 'connected';
      this._reconnectAttempts = 0;
      peers.forEach(p => { this.peers[p.socketId] = p; });
      this._applySeats(seats);
      this._emit('onRoomStateChanged', { state: 'connected', roomId });
      if (this.isHost) this.autoTakeSeat0AsHost();
      // Initiator sends offer; the other peer answers (one negotiation per pair).
      for (const peer of peers) {
        if (this._shouldInitiate(peer.socketId)) {
          await this._startPublishingTo(peer.socketId);
        }
      }
      this._emit('onRoomJoined', { roomId, peers });
    });

    s.on('peer-joined', async ({ socketId, userName }) => {
      this.peers[socketId] = { socketId, userName, muted: false };
      this._emit('onPeerJoined', { socketId, userName });
      if (this._shouldInitiate(socketId)) {
        await this._startPublishingTo(socketId);
      }
    });

    s.on('peer-left', ({ socketId }) => {
      const peer = this.peers[socketId];
      this.engine.closePeerConnection(socketId);
      const el = document.getElementById(`audio-${socketId}`);
      if (el) el.remove();
      delete this.peers[socketId];
      this._emit('onPeerLeft', { socketId, userName: peer?.userName });
    });

    s.on('seat-update', ({ seats }) => {
      this._applySeats(seats);
    });

    s.on('seat-take-failed', ({ seatIndex, reason }) => {
      this._emit('onSeatTakeFailed', { seatIndex, reason });
    });

    s.on('removed-from-seat', ({ seatIndex }) => {
      this._emit('onRemovedFromSeat', { seatIndex });
    });

    // FIX: answerer also needs to set up ontrack before handling offer
    s.on('offer', async ({ from, offer }) => {
      console.log(`[Room] Got offer from ${from}`);
      if (this._shouldInitiate(from)) {
        console.log(`[Room] Ignoring offer from ${from} (we are initiator for this pair)`);
        return;
      }
      await this.engine.createPeerConnection(from, false);
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
      this._emit('onPeerMuteChanged', { socketId, muted });
    });

    s.on('barrage', ({ from, data }) => {
      this._emit('onBarrageReceived', { from, data });
    });

    s.on('custom-command', ({ from, data }) => {
      if (data.type === 'seat_invite') this._emit('onSeatInviteReceived', { from, seatIndex: data.seatIndex });
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
    // Important: apply current "mute all" state to newly attached audio.
    // Otherwise Mute All only affects audio elements that already existed.
    el.muted = !!this.engine.allRemoteMuted;
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
