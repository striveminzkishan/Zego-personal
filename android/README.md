# Android Native SDK (Option B)

Java WebRTC client that talks to the same `server.js` as the web app. Replaces Zego Express / Live Audio Room SDK.

## Open in Android Studio

1. Install [Android Studio](https://developer.android.com/studio) (Hedgehog or newer).
2. **File → Open** → select the `android` folder.
3. Wait for Gradle sync.
4. Start your Node server: `npm start` (from repo root).
5. Run the **app** configuration on a device or emulator.

## Server URL

| Device | Server URL in app |
|--------|-------------------|
| Android Emulator | `http://10.0.2.2:3000` (default) |
| Physical phone | `http://YOUR_PC_LAN_IP:3000` |
| Production | `https://your-domain.com` |

Phone and PC must be on the same Wi‑Fi when testing locally.

## Project layout

```
android/app/src/main/java/
  com/voiceroom/sdk/          ← Copy into your chat app (or depend on module)
    VoiceConfig.java
    VoiceEventListener.java
    SignalingClient.java
    WebRtcVoiceEngine.java
    VoiceRoomManager.java       ← Main API (replaces Zego)
  com/voiceroom/demo/
    VoiceChatActivity.java      ← Example UI
```

## Replace Zego in your chat app

### 1. Copy SDK package

Copy `com.voiceroom.sdk` into your project, or move it to a library module.

### 2. Gradle dependencies (`app/build.gradle`)

```gradle
implementation 'io.getstream:stream-webrtc-android:1.3.8'
implementation('io.socket:socket.io-client:2.1.0') {
    exclude group: 'org.json', module: 'json'
}
implementation 'org.json:json:20240303'
```

### 3. Permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

### 4. Launch voice from chat

```java
Intent intent = new Intent(this, VoiceChatActivity.class);
// Or use VoiceRoomManager directly in your own Activity:
intent.putExtra("serverUrl", "https://voice.yourapp.com");
intent.putExtra("userName", currentUser.getName());
intent.putExtra("roomId", chatRoomId);
intent.putExtra("isHost", isRoomHost);
startActivity(intent);
```

### 5. Programmatic API (no demo UI)

```java
VoiceConfig config = new VoiceConfig("https://voice.yourapp.com");
VoiceRoomManager room = new VoiceRoomManager(context, config, listener);

room.signIn(userName, () -> room.loginRoom(roomId, isHost), this::showError);

// Later
room.toggleMic();
room.takeSeat(0);
room.leaveRoom(() -> { /* cleanup UI */ });
room.logout(() -> { /* exit */ });
```

## Zego → VoiceRoomManager mapping

| Zego | This SDK |
|------|----------|
| `createEngine` | `VoiceRoomManager` + `signIn()` |
| `loginRoom` | `loginRoom(roomId, isHost)` |
| `startPublishingStream` | Automatic on join |
| `startPlayingStream` | Automatic (`onRemoteStreamAdded`) |
| `muteMicrophone` | `toggleMic()` |
| `muteAllPlayStreamAudio` | `muteAllRemote(true)` |
| Seat APIs | `takeSeat`, `leaveSeat`, `removeSpeakerFromSeat` |
| `logoutRoom` | `leaveRoom()` / `logout()` |

## Interop with web clients

Android and browser users can join the **same room ID** on the **same server** — signaling protocol is identical.

## Production checklist

- [ ] Deploy `server.js` with HTTPS
- [ ] Set production URL in app (no cleartext)
- [ ] Add TURN server in `VoiceConfig.getIceServers()` (see root README)
- [ ] Add JWT auth on `join-room` in `server.js` when ready

## Not yet in Android SDK

- BGM / MediaPlayer mixing (web only for now)
- Voice effects presets
- Sound level meters

These can be added in a follow-up; core voice chat is implemented.
