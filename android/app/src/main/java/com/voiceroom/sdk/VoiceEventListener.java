package com.voiceroom.sdk;

import java.util.List;

/** Mirrors web RoomManager / VoiceEngine event handlers. */
public interface VoiceEventListener {

    default void onSignedIn(String userName) {}

    default void onSignedOut() {}

    default void onRoomStateChanged(String state, String roomId) {}

    default void onRoomJoined(String roomId, List<PeerInfo> peers) {}

    default void onLeftRoom(String roomId) {}

    default void onPeerJoined(String socketId, String userName) {}

    default void onPeerLeft(String socketId, String userName) {}

    default void onPeerMuteChanged(String socketId, boolean muted) {}

    default void onRemoteStreamAdded(String socketId) {}

    default void onPeerConnectionState(String socketId, String state) {}

    default void onMicStateChanged(boolean muted) {}

    default void onRemoteMuteChanged(boolean muted) {}

    default void onSeatUpdate(SeatUser[] seats) {}

    default void onSeatChanged(int seatIndex, SeatUser user) {}

    default void onSeatTakeFailed(int seatIndex, String reason) {}

    default void onLog(String message) {}

    default void onError(String message) {}
}
