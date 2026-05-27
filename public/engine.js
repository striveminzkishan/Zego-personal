/**
 * VoiceEngine.js — Fixed version
 * Key fixes:
 *  - ICE candidates queued until remote description is set
 *  - TURN servers added for Render/cloud deployment
 *  - ontrack fires immediately, audio attached reliably
 */

class VoiceEngine {
  constructor() {
    this.localStream = null;
    this.peerConnections = {};
    this.remoteStreams = {};
    this.audioContext = null;
    this.analyserNodes = {};
    this.micMuted = false;
    this.allRemoteMuted = false;
    this.voiceEffect = 'none';
    this.mediaPlayer = null;
    this.bgmMixSource = null;
    this.bgmGainNode = null;
    this.micMixSource = null;
    this.mixDestination = null;
    this.bgmLocalOnly = false;
    this.soundLevelTimer = null;
    this.eventHandlers = [];

    // FIX: queue ICE candidates per peer until remote desc is ready
    this._iceCandidateQueues = {};

    this.iceConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Free public TURN — works on Render/cloud
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

  async init() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await this.audioContext.resume();
    console.log('[Engine] AudioContext ready');
  }

  async startLocalStream() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000
        },
        video: false
      });
      this._setupLocalAnalyser();
      console.log('[Engine] Mic stream started, tracks:', this.localStream.getTracks().length);
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

  // FIX: tracks added BEFORE createOffer/createAnswer so they are in SDP
  async createPeerConnection(socketId, isInitiator) {
    // Close old connection if exists
    if (this.peerConnections[socketId]) {
      this.peerConnections[socketId].close();
    }

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections[socketId] = pc;
    this._iceCandidateQueues[socketId] = [];

    // FIX: Add local tracks right away so they appear in SDP
    const outboundTrack = this._getOutboundAudioTrack();
    if (outboundTrack && this.localStream) {
      pc.addTrack(outboundTrack, this.localStream);
      console.log(`[Engine] Added local track to ${socketId}:`, outboundTrack.kind);
    } else if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
        console.log(`[Engine] Added local track to ${socketId}:`, track.kind);
      });
    } else {
      console.warn('[Engine] No local stream when creating peer connection!');
    }

    // FIX: ontrack — store stream and attach audio immediately
    pc.ontrack = (e) => {
      console.log(`[Engine] Got remote track from ${socketId}:`, e.track.kind, 'streams:', e.streams.length);
      const stream = e.streams[0] || new MediaStream([e.track]);
      this.remoteStreams[socketId] = stream;
      this._setupRemoteAnalyser(socketId, stream);
      this._emit('onRemoteStreamAdded', { socketId, stream });
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._emit('onICECandidate', { socketId, candidate: e.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[Engine] ICE state ${socketId}:`, pc.iceConnectionState);
      this._emit('onPeerConnectionState', { socketId, state: pc.iceConnectionState });
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Engine] Connection state ${socketId}:`, pc.connectionState);
    };

    return pc;
  }

  async createOffer(socketId) {
    const pc = this.peerConnections[socketId];
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log(`[Engine] Created offer for ${socketId}`);
    return offer;
  }

  async handleOffer(socketId, offer) {
    const pc = this.peerConnections[socketId];
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    // FIX: flush queued ICE candidates after remote desc is set
    await this._flushIceCandidates(socketId);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log(`[Engine] Created answer for ${socketId}`);
    return answer;
  }

  async handleAnswer(socketId, answer) {
    const pc = this.peerConnections[socketId];
    if (!pc) return;
    if (pc.signalingState !== 'have-local-offer') {
      console.warn(`[Engine] Ignoring stale answer from ${socketId} (state: ${pc.signalingState})`);
      return;
    }
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    // FIX: flush queued ICE candidates after remote desc is set
    await this._flushIceCandidates(socketId);
    console.log(`[Engine] Set answer from ${socketId}`);
  }

  // FIX: queue candidates if remote description not ready yet
  async handleICECandidate(socketId, candidate) {
    const pc = this.peerConnections[socketId];
    if (!pc || !candidate) return;
    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      console.log(`[Engine] Queuing ICE candidate for ${socketId}`);
      if (!this._iceCandidateQueues[socketId]) this._iceCandidateQueues[socketId] = [];
      this._iceCandidateQueues[socketId].push(candidate);
    } else {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[Engine] ICE candidate error:', e.message);
      }
    }
  }

  async _flushIceCandidates(socketId) {
    const queue = this._iceCandidateQueues[socketId] || [];
    console.log(`[Engine] Flushing ${queue.length} queued ICE candidates for ${socketId}`);
    for (const candidate of queue) {
      try {
        await this.peerConnections[socketId].addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[Engine] Queued ICE error:', e.message);
      }
    }
    this._iceCandidateQueues[socketId] = [];
  }

  closePeerConnection(socketId) {
    if (this.peerConnections[socketId]) {
      this.peerConnections[socketId].close();
      delete this.peerConnections[socketId];
    }
    delete this.remoteStreams[socketId];
    delete this.analyserNodes[socketId];
    delete this._iceCandidateQueues[socketId];
  }

  closeAllPeerConnections() {
    Object.keys(this.peerConnections).forEach(sid => this.closePeerConnection(sid));
  }

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

  setAllRemoteMuted(muted) {
    this.allRemoteMuted = muted;
    document.querySelectorAll('audio[data-remote]').forEach(el => { el.muted = muted; });
    this._emit('onRemoteMuteChanged', { muted });
  }

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
    try {
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.analyserNodes[socketId] = analyser;
    } catch (e) {
      console.warn('[Engine] Remote analyser error:', e.message);
    }
  }

  setVoiceEffect(preset) {
    this.voiceEffect = preset;
    this._emit('onVoiceEffectChanged', { preset });
    console.log(`[Engine] Voice effect: ${preset}`);
  }

  createMediaPlayer() {
    this._teardownMixGraph();
    this.mediaPlayer = new Audio();
    this.mediaPlayer.loop = false;
    this.mediaPlayer.crossOrigin = 'anonymous';
    this.mediaPlayer.preload = 'auto';
    this._emit('onMediaPlayerCreated', {});
    return this.mediaPlayer;
  }

  async loadMedia(url) {
    if (!this.mediaPlayer) this.createMediaPlayer();
    this._teardownBgmMix();
    this.bgmLocalOnly = false;

    try {
      await this._loadMediaElement(url, 'anonymous');
      console.log('[Engine] BGM loaded (with CORS):', url);
    } catch {
      await this._loadMediaElement(url, null);
      this.bgmLocalOnly = true;
      console.warn('[Engine] BGM loaded without CORS — local playback only');
    }
  }

  _loadMediaElement(url, crossOriginMode) {
    const el = this.mediaPlayer;
    if (crossOriginMode) el.crossOrigin = crossOriginMode;
    else el.removeAttribute('crossorigin');
    el.src = url;
    return new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onErr = () => {
        cleanup();
        reject(new Error('Could not load audio'));
      };
      const cleanup = () => {
        el.removeEventListener('canplaythrough', onReady);
        el.removeEventListener('error', onErr);
      };
      el.addEventListener('canplaythrough', onReady, { once: true });
      el.addEventListener('error', onErr, { once: true });
      el.load();
    });
  }

  async playMedia() {
    if (!this.mediaPlayer) throw new Error('BGM player not ready');
    if (!this.mediaPlayer.src) throw new Error('Load a BGM URL or file first');
    if (!this.localStream) throw new Error('Microphone is not active');

    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume();
    }

    await this.mediaPlayer.play();
    this._mixBgmForPeers();
    this._emit('onMediaPlayerStateChanged', { state: 'playing' });
    console.log('[Engine] BGM playing');
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
    }
    this._teardownBgmMix();
    this._applyMicTrackToPeers();
    this._emit('onMediaPlayerStateChanged', { state: 'stopped' });
  }

  setMediaVolume(vol) {
    const v = Math.max(0, Math.min(1, Number(vol)));
    if (this.mediaPlayer) this.mediaPlayer.volume = v;
    if (this.bgmGainNode) this.bgmGainNode.gain.value = v;
  }

  destroyMediaPlayer() {
    this.stopMedia();
    this.mediaPlayer = null;
    this._teardownMixGraph();
    this._applyMicTrackToPeers();
    this._emit('onMediaPlayerDestroyed', {});
  }

  _getOutboundAudioTrack() {
    if (this.mixDestination) {
      return this.mixDestination.stream.getAudioTracks()[0] || null;
    }
    return this.localStream?.getAudioTracks()[0] || null;
  }

  _teardownBgmMix() {
    if (this.bgmMixSource) {
      this.bgmMixSource.disconnect();
      this.bgmMixSource = null;
    }
    if (this.bgmGainNode) {
      this.bgmGainNode.disconnect();
      this.bgmGainNode = null;
    }
  }

  _teardownMixGraph() {
    this._teardownBgmMix();
    if (this.micMixSource) {
      this.micMixSource.disconnect();
      this.micMixSource = null;
    }
    this.mixDestination = null;
  }

  _captureBgmStream() {
    if (!this.mediaPlayer) return null;
    if (typeof this.mediaPlayer.captureStream === 'function') {
      return this.mediaPlayer.captureStream();
    }
    if (typeof this.mediaPlayer.mozCaptureStream === 'function') {
      return this.mediaPlayer.mozCaptureStream();
    }
    return null;
  }

  _mixBgmForPeers() {
    if (!this.audioContext || !this.mediaPlayer || !this.localStream) return;

    if (this.bgmLocalOnly) {
      console.warn('[Engine] BGM plays locally only (URL has no CORS — use a local file for room-wide BGM)');
      return;
    }

    const captured = this._captureBgmStream();
    const bgmTrack = captured?.getAudioTracks?.()[0];
    if (!bgmTrack) {
      console.warn('[Engine] BGM plays locally only (captureStream unavailable)');
      return;
    }

    if (!this.mixDestination) {
      this.mixDestination = this.audioContext.createMediaStreamDestination();
    }

    if (!this.micMixSource) {
      this.micMixSource = this.audioContext.createMediaStreamSource(this.localStream);
      this.micMixSource.connect(this.mixDestination);
    }

    this._teardownBgmMix();

    if (!this.bgmGainNode) {
      this.bgmGainNode = this.audioContext.createGain();
      this.bgmGainNode.gain.value = this.mediaPlayer.volume;
    }

    const bgmStream = new MediaStream([bgmTrack]);
    this.bgmMixSource = this.audioContext.createMediaStreamSource(bgmStream);
    this.bgmMixSource.connect(this.bgmGainNode);
    this.bgmGainNode.connect(this.mixDestination);

    this._applyMixedTrackToPeers();
    console.log('[Engine] BGM mixed into voice stream for remote peers');
  }

  _applyMixedTrackToPeers() {
    const mixedTrack = this._getOutboundAudioTrack();
    if (!mixedTrack) return;
    Object.values(this.peerConnections).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) sender.replaceTrack(mixedTrack);
    });
  }

  _applyMicTrackToPeers() {
    const micTrack = this.localStream?.getAudioTracks()[0];
    if (!micTrack) return;
    Object.values(this.peerConnections).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) sender.replaceTrack(micTrack);
    });
  }

  addEventHandler(handler) { this.eventHandlers.push(handler); }
  removeEventHandler(handler) { this.eventHandlers = this.eventHandlers.filter(h => h !== handler); }
  _emit(event, data) { this.eventHandlers.forEach(h => { if (typeof h[event] === 'function') h[event](data); }); }

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
