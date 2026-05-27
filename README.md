# VoiceRoom — Self-Hosted WebRTC Voice App
> Drop-in replacement for Zegocloud SDK · No third-party SDK required

---

## Feature Coverage

| Zegocloud Feature | This App |
|---|---|
| 1. SDK bootstrap + ZIM sign-in | `RoomManager.signIn()` |
| 2. Room login / reconnect | `RoomManager.loginRoom()` + auto-reconnect |
| 3. LiveAudioRoom seat management | `takeSeat / switchSeat / removeSpeaker` |
| 3.2 Auto-seat host + publish | `autoTakeSeat0AsHost()` |
| 3.3 Take / switch seat + invite | `takeSeat()` + `sendSeatInvite()` |
| 3.4 Remove speaker from seat | `removeSpeakerFromSeat()` (host only) |
| 3.5 Leave room cleanup | `leaveRoom()` / `logout()` |
| 4. ExpressEngine audio controls | `VoiceEngine` class |
| 4.1 Mic mute/unmute | `toggleMic()` |
| 4.2 Mute/unmute all remote | `muteAllRemote()` |
| 4.3 Sound level monitoring | `startSoundLevelMonitoring()` |
| 4.4 AEC (echo cancellation) | Built into `getUserMedia` constraints |
| 4.5 Voice changer presets | `setVoiceEffect(preset)` |
| 4.6 Audio config + monitoring | AudioContext + AnalyserNode |
| 5. IM / Barrage / Custom Command | Socket.io barrage + custom-command events |
| 5.1 Receive barrage | `onBarrageReceived` handler |
| 5.2 Send barrage | `_broadcastRoomSignal()` |
| 5.3 Custom command | `_sendCustomCommand()` |
| 6. Room state callbacks | `onRoomStateChanged` (connected / reconnecting / failed) |
| 7. MediaPlayer BGM/AUX mixing | `VoiceEngine.createMediaPlayer()` + WebAudio aux mix |
| 8. Publish & play streams | RTCPeerConnection tracks + `<audio>` elements |
| 9. Event handler registration | `addEventHandler / removeEventHandler` |
| 10. Logout / disconnect | `logout()` → destroys engine + socket |

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
npm start
# or for development with auto-reload:
npm run dev
```

### 3. Open in browser
```
http://localhost:3000
```

---

## Project Structure

```
webrtc-voice/
├── server.js           # Signaling server (Socket.io)
├── package.json
└── public/
    ├── index.html      # Full UI (lobby + room)
    ├── engine.js       # VoiceEngine (replaces ZegoExpressEngine)
    └── room-manager.js # RoomManager (replaces ZEGOLiveAudioRoomManager)
```

---

## Deploying on Your Server

### Option A — Direct Node.js
```bash
# Install PM2 for process management
npm install -g pm2

# Start and keep alive
pm2 start server.js --name voiceroom
pm2 save
pm2 startup
```

### Option B — Behind Nginx (HTTPS — required for mic access in production)
```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";  # required for WebSockets
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Get a free SSL cert with:
```bash
sudo certbot --nginx -d yourdomain.com
```

### Option C — Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t voiceroom .
docker run -d -p 3000:3000 --name voiceroom voiceroom
```

---

## Production: Add a TURN Server

For users behind strict NAT/firewalls, add a TURN server. The cheapest option is **Coturn** (free, self-hosted):

```bash
# Install Coturn on your Linux server
sudo apt install coturn

# Edit /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
user=myuser:mypassword
realm=yourdomain.com
```

Then update `iceConfig` in `engine.js`:
```js
this.iceConfig = {
  iceServers: [
    { urls: 'stun:yourdomain.com:3478' },
    {
      urls: 'turn:yourdomain.com:3478',
      username: 'myuser',
      credential: 'mypassword'
    }
  ]
};
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |

```bash
PORT=8080 node server.js
```

---

## Browser Support
Chrome 80+, Firefox 78+, Safari 14+, Edge 80+

> ⚠️ Microphone access requires **HTTPS** in production (localhost is fine for dev).
