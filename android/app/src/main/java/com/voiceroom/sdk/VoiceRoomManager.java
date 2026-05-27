package com.voiceroom.sdk;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Native port of public/room-manager.js — use instead of Zego SDK.
 */
public class VoiceRoomManager implements SignalingClient.Listener, WebRtcVoiceEngine.EngineListener {

    private final Context context;
    private final VoiceConfig config;
    private final VoiceEventListener uiListener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private SignalingClient signaling;
    private WebRtcVoiceEngine engine;

    private String roomId;
    private String mySocketId;
    private String myUserId;
    private String userName;
    private boolean isHost;
    private String roomState = "disconnected";

    private final Map<String, PeerInfo> peers = new HashMap<>();
    private final SeatUser[] seats = new SeatUser[8];

    public VoiceRoomManager(Context context, VoiceConfig config, VoiceEventListener listener) {
        this.context = context.getApplicationContext();
        this.config = config;
        this.uiListener = listener;
    }

    /** Replaces Zego engine init + ZIM sign-in. */
    public void signIn(String userName, Runnable onSuccess, java.util.function.Consumer<String> onError) {
        this.userName = userName;
        engine = new WebRtcVoiceEngine(context, config, this);
        engine.init(() -> engine.startLocalAudio(
                () -> runOnMain(() -> {
                    uiListener.onSignedIn(userName);
                    onSuccess.run();
                }),
                err -> runOnMain(() -> onError.accept(err))
        ), err -> runOnMain(() -> onError.accept(err)));
    }

    /** Connect socket + join room. Call after signIn(). */
    public void loginRoom(String roomId, boolean isHost) {
        if (userName == null) {
            notifyError("Call signIn() first");
            return;
        }
        this.roomId = roomId;
        this.isHost = isHost;
        roomState = "connecting";
        uiListener.onRoomStateChanged("connecting", roomId);

        signaling = new SignalingClient(config, this);
        signaling.connect();
    }

    public void leaveRoom(Runnable onDone) {
        leaveSeat();
        if (engine != null) {
            engine.closeAllPeerConnections();
        }
        if (signaling != null && roomId != null) {
            signaling.leaveRoom(roomId);
            signaling.disconnect();
            signaling = null;
        }
        roomState = "disconnected";
        peers.clear();
        for (int i = 0; i < seats.length; i++) seats[i] = null;
        runOnMain(() -> {
            uiListener.onRoomStateChanged("disconnected", roomId);
            uiListener.onLeftRoom(roomId);
            onDone.run();
        });
    }

    public void logout(Runnable onDone) {
        leaveRoom(() -> {
            if (engine != null) {
                engine.destroy(() -> {
                    engine = null;
                    runOnMain(() -> {
                        uiListener.onSignedOut();
                        onDone.run();
                    });
                });
            } else {
                runOnMain(onDone);
            }
        });
    }

    public boolean toggleMic() {
        if (engine == null) return false;
        boolean muted = engine.toggleMic();
        if (signaling != null && roomId != null) {
            signaling.toggleMute(roomId, muted);
        }
        uiListener.onMicStateChanged(muted);
        return muted;
    }

    public void muteAllRemote(boolean muted) {
        if (engine != null) engine.setAllRemoteMuted(muted);
        uiListener.onRemoteMuteChanged(muted);
    }

    public void takeSeat(int seatIndex) {
        if (seatIndex < 0 || seatIndex > 7 || signaling == null || roomId == null) return;
        signaling.takeSeat(roomId, seatIndex);
    }

    public void leaveSeat() {
        if (signaling == null || roomId == null) return;
        signaling.leaveSeat(roomId);
    }

    public void removeSpeakerFromSeat(int seatIndex) {
        if (!isHost || seatIndex < 0 || seatIndex > 7 || signaling == null || roomId == null) return;
        signaling.removeFromSeat(roomId, seatIndex);
    }

    public SeatUser[] getSeats() {
        return seats.clone();
    }

    // ── SignalingClient.Listener ─────────────────────────────────────────────

    @Override
    public void onConnected(String socketId) {
        mySocketId = socketId;
        log("Socket connected: " + socketId);
        if (roomId != null && userName != null) {
            signaling.joinRoom(roomId, userName, isHost);
        }
    }

    @Override
    public void onDisconnected() {
        if (!"disconnected".equals(roomState)) {
            roomState = "reconnecting";
            uiListener.onRoomStateChanged("reconnecting", roomId);
        }
    }

    @Override
    public void onRoomJoined(String joinedRoomId, String userId, List<PeerInfo> existingPeers, SeatUser[] serverSeats) {
        myUserId = userId;
        roomState = "connected";
        peers.clear();
        for (PeerInfo p : existingPeers) peers.put(p.socketId, p);

        applySeats(serverSeats);
        uiListener.onRoomStateChanged("connected", joinedRoomId);
        if (isHost) autoTakeSeat0AsHost();

        for (PeerInfo peer : existingPeers) {
            if (shouldInitiate(peer.socketId)) {
                startPublishingTo(peer.socketId);
            }
        }

        uiListener.onRoomJoined(joinedRoomId, existingPeers);
        log("Joined room " + joinedRoomId + " with " + existingPeers.size() + " peer(s)");
    }

    @Override
    public void onPeerJoined(String socketId, String peerUserName) {
        peers.put(socketId, new PeerInfo(socketId, peerUserName, false));
        uiListener.onPeerJoined(socketId, peerUserName);
        if (shouldInitiate(socketId)) {
            startPublishingTo(socketId);
        }
    }

    @Override
    public void onPeerLeft(String socketId) {
        PeerInfo peer = peers.remove(socketId);
        if (engine != null) engine.closePeerConnection(socketId);
        uiListener.onPeerLeft(socketId, peer != null ? peer.userName : null);
    }

    @Override
    public void onSeatUpdate(SeatUser[] serverSeats) {
        applySeats(serverSeats);
    }

    @Override
    public void onSeatTakeFailed(int seatIndex, String reason) {
        uiListener.onSeatTakeFailed(seatIndex, reason);
    }

    @Override
    public void onRemovedFromSeat(int seatIndex) {
        uiListener.onRemovedFromSeat(seatIndex);
    }

    @Override
    public void onOffer(String from, JSONObject offer) {
        if (shouldInitiate(from)) {
            log("Ignoring offer from " + from + " (we are initiator)");
            return;
        }
        engine.createPeerConnection(from, () -> engine.handleOffer(from, offer,
                answer -> signaling.sendAnswer(from, answer),
                this::notifyError));
    }

    @Override
    public void onAnswer(String from, JSONObject answer) {
        engine.handleAnswer(from, answer, () -> log("Answer applied from " + from), this::notifyError);
    }

    @Override
    public void onIceCandidate(String from, JSONObject candidate) {
        if (engine != null) engine.handleIceCandidate(from, candidate);
    }

    @Override
    public void onPeerMuteChanged(String socketId, boolean muted) {
        PeerInfo p = peers.get(socketId);
        if (p != null) p.muted = muted;
        int idx = findSeatBySocket(socketId);
        if (idx != -1 && seats[idx] != null) seats[idx].muted = muted;
        uiListener.onPeerMuteChanged(socketId, muted);
    }

    @Override
    public void onBarrage(String from, JSONObject data) {
        // Seats are server-authoritative via seat-update, not barrage.
    }

    @Override
    public void onCustomCommand(String from, JSONObject data) {
        // Custom commands for invites etc.
    }

    @Override
    public void onError(String message) {
        notifyError(message);
    }

    // ── WebRtcVoiceEngine.EngineListener ─────────────────────────────────────

    @Override
    public void onIceCandidate(String peerId, JSONObject candidate) {
        if (signaling != null && roomId != null) {
            signaling.sendIceCandidate(peerId, candidate);
        }
    }

    @Override
    public void onRemoteAudioTrack(String peerId) {
        uiListener.onRemoteStreamAdded(peerId);
    }

    @Override
    public void onIceConnectionChange(String peerId, String state) {
        uiListener.onPeerConnectionState(peerId, state);
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    private void startPublishingTo(String peerSocketId) {
        engine.createPeerConnection(peerSocketId, () ->
                engine.createOffer(peerSocketId,
                        offer -> signaling.sendOffer(peerSocketId, offer),
                        this::notifyError));
    }

    private boolean shouldInitiate(String remoteSocketId) {
        return mySocketId != null && mySocketId.compareTo(remoteSocketId) < 0;
    }

    private void autoTakeSeat0AsHost() {
        if (seats[0] == null) {
            takeSeat(0);
        }
    }

    private void applySeats(SeatUser[] serverSeats) {
        for (int i = 0; i < 8; i++) seats[i] = null;
        if (serverSeats != null) {
            for (int i = 0; i < Math.min(8, serverSeats.length); i++) {
                seats[i] = serverSeats[i];
            }
        }
        uiListener.onSeatUpdate(seats.clone());
    }

    private void log(String msg) {
        runOnMain(() -> uiListener.onLog(msg));
    }

    private void notifyError(String msg) {
        runOnMain(() -> uiListener.onError(msg));
    }

    private void runOnMain(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            r.run();
        } else {
            mainHandler.post(r);
        }
    }

    public String getRoomState() { return roomState; }
    public String getMySocketId() { return mySocketId; }
}
