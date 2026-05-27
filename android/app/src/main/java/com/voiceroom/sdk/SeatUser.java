package com.voiceroom.sdk;

public class SeatUser {
    public final String socketId;
    public final String userId;
    public final String userName;
    public boolean muted;

    public SeatUser(String socketId, String userId, String userName, boolean muted) {
        this.socketId = socketId;
        this.userId = userId;
        this.userName = userName;
        this.muted = muted;
    }
}
