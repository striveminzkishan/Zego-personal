/**
 * VoiceEngine.js
 * Replaces: ZegoExpressEngine + ZEGOSDKManager.expressService
 * Handles: mic, streams, AEC, voice effects, sound levels, media player (BGM)
 */

class VoiceEngine {
  constructor() {
    this.localStream = null;
    this.peerConnections = {}; // socketId -> RTCPeerConnection
    this.remoteStreams = {};   // socketId -> MediaStream
    this.audioContext = null;
    this.gainNode = null;
    this.analyserNodes = {};   // socketId|'local' -> AnalyserNode
    this.micMuted = false;
    this.allRemoteMuted = false;
    this.voiceEffect = 'none';
    this.mediaPlayer = null;   // BGM player
    this.auxStream = null;     // BGM MediaElementSource
    this.soundLevelTimer = null;
    this.eventHandlers = [];   // registered IExpressEngineEventHandlers

    // ICE config — replace with your TURN server for production
    this.iceConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ]
    };
  }

  // ── 1. Init ────────────────────────────────────────────────────────────────
  async init() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await this.audioContext.resume();
    console.log('[Engine] AudioContext initialized');
  }

  // ── 2. Local stream (mic capture with AEC) ────────────────────────────────
  async startLocalStream() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,   // 4.4 AEC
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000
        },
        video: false
      });
      this._setupLocalAnalyser();
      console.log('[Engine] Local mic stream started');
      return this.localStream;
    } catch (e) {
      console.error('[Engine] Mic access failed:', e);
      throw e;
    }
  }

  stopLocalStream() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
  }

  // ── 3. Peer Connection (publish + play streams) ────────────────────────────
  async createPeerConnection(socketId, isInitiator) {
    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections[socketId] = pc;

    // Add local tracks → publish stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
    }

    // Receive remote stream → play stream
    pc.ontrack = (e) => {
      this.remoteStreams[socketId] = e.streams[0];
      this._setupRemoteAnalyser(socketId, e.streams[0]);
      this._emit('onRemoteStreamAdded', { socketId, stream: e.streams[0] });
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._emit('onICECandidate', { socketId, candidate: e.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      this._emit('onPeerConnectionState', { socketId, state: pc.connectionState });
    };

    return pc;
  }

  async createOffer(socketId) {
    const pc = this.peerConnections[socketId];
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(socketId, offer) {
    const pc = this.peerConnections[socketId];
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(socketId, answer) {
    const pc = this.peerConnections[socketId];
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async handleICECandidate(socketId, candidate) {
    const pc = this.peerConnections[socketId];
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  closePeerConnection(socketId) {
    if (this.peerConnections[socketId]) {
      this.peerConnections[socketId].close();
      delete this.peerConnections[socketId];
    }
    delete this.remoteStreams[socketId];
    delete this.analyserNodes[socketId];
  }

  closeAllPeerConnections() {
    Object.keys(this.peerConnections).forEach(sid => this.closePeerConnection(sid));
  }

  // ── 4.1 Mic mute/unmute ───────────────────────────────────────────────────
  setMicMuted(muted) {
    this.micMuted = muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    }
    this._emit('onMicStateChanged', { muted });
  }

  toggleMic() {
    this.setMicMuted(!this.micMuted);
    return this.micMuted;
  }

  // ── 4.2 Mute/unmute all remote streams ───────────────────────────────────
  setAllRemoteMuted(muted) {
    this.allRemoteMuted = muted;
    document.querySelectorAll('audio[data-remote]').forEach(el => { el.muted = muted; });
    this._emit('onRemoteMuteChanged', { muted });
  }

  // ── 4.3 Sound level monitoring ────────────────────────────────────────────
  startSoundLevelMonitoring(intervalMs = 200) {
    if (this.soundLevelTimer) return;
    this.soundLevelTimer = setInterval(() => {
      const levels = {};
      for (const [id, analyser] of Object.entries(this.analyserNodes)) {
        levels[id] = this._getLevel(analyser);
      }
      this._emit('onSoundLevelUpdate', { levels });
    }, intervalMs);
  }

  stopSoundLevelMonitoring() {
    clearInterval(this.soundLevelTimer);
    this.soundLevelTimer = null;
  }

  _getLevel(analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += Math.abs(v - 128);
    return Math.min(100, Math.round((sum / data.length) * 3));
  }

  _setupLocalAnalyser() {
    if (!this.audioContext || !this.localStream) return;
    const source = this.audioContext.createMediaStreamSource(this.localStream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    this.analyserNodes['local'] = analyser;
  }

  _setupRemoteAnalyser(socketId, stream) {
    if (!this.audioContext) return;
    const source = this.audioContext.createMediaStreamSource(stream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    this.analyserNodes[socketId] = analyser;
  }

  // ── 4.4 AEC — applied at getUserMedia level (see startLocalStream) ─────────

  // ── 4.5 Voice changer presets ────────────────────────────────────────────
  setVoiceEffect(preset) {
    // preset: 'none' | 'robot' | 'cave' | 'deep' | 'high'
    this.voiceEffect = preset;
    this._emit('onVoiceEffectChanged', { preset });
    // Note: real-time voice changing requires WebAudio pipeline with BiquadFilter/PitchShifter
    // For production, integrate a WebAudio voice processor node here
    console.log(`[Engine] Voice effect set to: ${preset}`);
  }

  // ── 7. Media Player (BGM / AUX mixing) ───────────────────────────────────
  createMediaPlayer() {
    this.mediaPlayer = new Audio();
    this.mediaPlayer.loop = false;
    this._emit('onMediaPlayerCreated', {});
    return this.mediaPlayer;
  }

  loadMedia(url) {
    if (!this.mediaPlayer) this.createMediaPlayer();
    this.mediaPlayer.src = url;
    this.mediaPlayer.load();
  }

  async playMedia() {
    if (!this.mediaPlayer) return;
    await this.mediaPlayer.play();
    this._mixAuxIntoStream();
    this._emit('onMediaPlayerStateChanged', { state: 'playing' });
  }

  pauseMedia() {
    if (this.mediaPlayer) {
      this.mediaPlayer.pause();
      this._emit('onMediaPlayerStateChanged', { state: 'paused' });
    }
  }

  stopMedia() {
    if (this.mediaPlayer) {
      this.mediaPlayer.pause();
      this.mediaPlayer.currentTime = 0;
      this._emit('onMediaPlayerStateChanged', { state: 'stopped' });
    }
  }

  setMediaVolume(vol) { // 0-1
    if (this.mediaPlayer) this.mediaPlayer.volume = vol;
  }

  destroyMediaPlayer() {
    this.stopMedia();
    this.mediaPlayer = null;
    if (this.auxStream) { this.auxStream.disconnect(); this.auxStream = null; }
    this._emit('onMediaPlayerDestroyed', {});
  }

  _mixAuxIntoStream() {
    if (!this.audioContext || !this.mediaPlayer || !this.localStream) return;
    if (this.auxStream) { this.auxStream.disconnect(); }
    const dest = this.audioContext.createMediaStreamDestination();
    const micSource = this.audioContext.createMediaStreamSource(this.localStream);
    const bgmSource = this.audioContext.createMediaElementSource(this.mediaPlayer);
    micSource.connect(dest);
    bgmSource.connect(dest);
    this.auxStream = bgmSource;
    // Replace local stream tracks with mixed output
    const mixedTrack = dest.stream.getAudioTracks()[0];
    Object.values(this.peerConnections).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender && mixedTrack) sender.replaceTrack(mixedTrack);
    });
  }

  // ── 9. Event handler registration/removal ─────────────────────────────────
  addEventHandler(handler) {
    this.eventHandlers.push(handler);
  }

  removeEventHandler(handler) {
    this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
  }

  _emit(event, data) {
    this.eventHandlers.forEach(h => { if (typeof h[event] === 'function') h[event](data); });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  destroy() {
    this.stopSoundLevelMonitoring();
    this.closeAllPeerConnections();
    this.stopLocalStream();
    this.destroyMediaPlayer();
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
    this.eventHandlers = [];
    console.log('[Engine] Destroyed');
  }
}

window.VoiceEngine = VoiceEngine;
