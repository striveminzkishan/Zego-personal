package com.voiceroom.sdk;

public class PeerInfo {
    public final String socketId;
    public final String userName;
    public boolean muted;

    public PeerInfo(String socketId, String userName, boolean muted) {
        this.socketId = socketId;
        this.userName = userName;
        this.muted = muted;
    }
}
