package com.voiceroom.sdk;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;

import io.socket.client.IO;
import io.socket.client.Socket;
import io.socket.emitter.Emitter;

/**
 * Socket.io client — matches server.js events.
 */
public class SignalingClient {

    private static final String TAG = "SignalingClient";

    public interface Listener {
        void onConnected(String socketId);
        void onDisconnected();
        void onRoomJoined(String roomId, String userId, List<PeerInfo> peers, SeatUser[] seats);
        void onSeatUpdate(SeatUser[] seats);
        void onSeatTakeFailed(int seatIndex, String reason);
        void onRemovedFromSeat(int seatIndex);
        void onPeerJoined(String socketId, String userName);
        void onPeerLeft(String socketId);
        void onOffer(String from, JSONObject offer);
        void onAnswer(String from, JSONObject answer);
        void onIceCandidate(String from, JSONObject candidate);
        void onPeerMuteChanged(String socketId, boolean muted);
        void onBarrage(String from, JSONObject data);
        void onCustomCommand(String from, JSONObject data);
        void onError(String message);
    }

    private final VoiceConfig config;
    private final Listener listener;
    private Socket socket;

    public SignalingClient(VoiceConfig config, Listener listener) {
        this.config = config;
        this.listener = listener;
    }

    public void connect() {
        try {
            IO.Options opts = new IO.Options();
            opts.forceNew = true;
            opts.reconnection = true;
            socket = IO.socket(URI.create(config.getServerUrl()), opts);

            socket.on(Socket.EVENT_CONNECT, args -> {
                Log.d(TAG, "Connected: " + socket.id());
                listener.onConnected(socket.id());
            });

            socket.on(Socket.EVENT_DISCONNECT, args -> listener.onDisconnected());

            socket.on("room-joined", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    String roomId = data.getString("roomId");
                    String userId = data.getString("userId");
                    List<PeerInfo> peers = parsePeers(data.optJSONArray("peers"));
                    SeatUser[] seats = parseSeats(data.optJSONArray("seats"));
                    listener.onRoomJoined(roomId, userId, peers, seats);
                } catch (Exception e) {
                    listener.onError("room-joined parse error: " + e.getMessage());
                }
            });

            socket.on("peer-joined", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    listener.onPeerJoined(
                            data.getString("socketId"),
                            data.getString("userName"));
                } catch (Exception e) {
                    listener.onError("peer-joined parse error: " + e.getMessage());
                }
            });

            socket.on("peer-left", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    listener.onPeerLeft(data.getString("socketId"));
                } catch (Exception e) {
                    listener.onError("peer-left parse error: " + e.getMessage());
                }
            });

            socket.on("offer", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    listener.onOffer(data.getString("from"), data.getJSONObject("offer"));
                } catch (Exception e) {
                    listener.onError("offer parse error: " + e.getMessage());
                }
            });

            socket.on("answer", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    listener.onAnswer(data.getString("from"), data.getJSONObject("answer"));
                } catch (Exception e) {
                    listener.onError("answer parse error: " + e.getMessage());
                }
            });

            socket.on("ice-candidate", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    listener.onIceCandidate(data.getString("from"), data.getJSONObject("candidate"));
                } catch (Exception e) {
                    listener.onError("ice-candidate parse error: " + e.getMessage());
                }
            });

            socket.on("peer-mute-changed", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    listener.onPeerMuteChanged(
                            data.getString("socketId"),
                            data.getBoolean("muted"));
                } catch (Exception e) {
                    listener.onError("peer-mute-changed parse error: " + e.getMessage());
                }
            });

            socket.on("barrage", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    listener.onBarrage(data.getString("from"), data.getJSONObject("data"));
                } catch (Exception e) {
                    listener.onError("barrage parse error: " + e.getMessage());
                }
            });

            socket.on("seat-update", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    listener.onSeatUpdate(parseSeats(data.getJSONArray("seats")));
                } catch (Exception e) {
                    listener.onError("seat-update parse error: " + e.getMessage());
                }
            });

            socket.on("seat-take-failed", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    listener.onSeatTakeFailed(
                            data.getInt("seatIndex"),
                            data.optString("reason", "occupied"));
                } catch (Exception e) {
                    listener.onError("seat-take-failed parse error: " + e.getMessage());
                }
            });

            socket.on("removed-from-seat", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    listener.onRemovedFromSeat(data.getInt("seatIndex"));
                } catch (Exception e) {
                    listener.onError("removed-from-seat parse error: " + e.getMessage());
                }
            });

            socket.on("custom-command", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    listener.onCustomCommand(data.getString("from"), data.getJSONObject("data"));
                } catch (Exception e) {
                    listener.onError("custom-command parse error: " + e.getMessage());
                }
            });

            socket.connect();
        } catch (Exception e) {
            listener.onError("Socket connect failed: " + e.getMessage());
        }
    }

    public String getSocketId() {
        return socket != null ? socket.id() : null;
    }

    public boolean isConnected() {
        return socket != null && socket.connected();
    }

    public void joinRoom(String roomId, String userName, boolean isHost) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("roomId", roomId);
            payload.put("userName", userName);
            payload.put("isHost", isHost);
            emit("join-room", payload);
        } catch (Exception e) {
            listener.onError("join-room failed: " + e.getMessage());
        }
    }

    public void leaveRoom(String roomId) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("roomId", roomId);
            emit("leave-room", payload);
        } catch (Exception e) {
            listener.onError("leave-room failed: " + e.getMessage());
        }
    }

    public void sendOffer(String to, JSONObject offer) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("to", to);
            payload.put("offer", offer);
            emit("offer", payload);
        } catch (Exception e) {
            listener.onError("send offer failed: " + e.getMessage());
        }
    }

    public void sendAnswer(String to, JSONObject answer) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("to", to);
            payload.put("answer", answer);
            emit("answer", payload);
        } catch (Exception e) {
            listener.onError("send answer failed: " + e.getMessage());
        }
    }

    public void sendIceCandidate(String to, JSONObject candidate) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("to", to);
            payload.put("candidate", candidate);
            emit("ice-candidate", payload);
        } catch (Exception e) {
            listener.onError("send ice failed: " + e.getMessage());
        }
    }

    public void toggleMute(String roomId, boolean muted) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("roomId", roomId);
            payload.put("muted", muted);
            emit("toggle-mute", payload);
        } catch (Exception e) {
            listener.onError("toggle-mute failed: " + e.getMessage());
        }
    }

    public void takeSeat(String roomId, int seatIndex) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("roomId", roomId);
            payload.put("seatIndex", seatIndex);
            emit("take-seat", payload);
        } catch (Exception e) {
            listener.onError("take-seat failed: " + e.getMessage());
        }
    }

    public void leaveSeat(String roomId) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("roomId", roomId);
            emit("leave-seat", payload);
        } catch (Exception e) {
            listener.onError("leave-seat failed: " + e.getMessage());
        }
    }

    public void removeFromSeat(String roomId, int seatIndex) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("roomId", roomId);
            payload.put("seatIndex", seatIndex);
            emit("remove-from-seat", payload);
        } catch (Exception e) {
            listener.onError("remove-from-seat failed: " + e.getMessage());
        }
    }

    public void sendBarrage(String roomId, JSONObject data) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("roomId", roomId);
            payload.put("data", data);
            emit("barrage", payload);
        } catch (Exception e) {
            listener.onError("barrage failed: " + e.getMessage());
        }
    }

    public void sendCustomCommand(String to, JSONObject data) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("to", to);
            payload.put("data", data);
            emit("custom-command", payload);
        } catch (Exception e) {
            listener.onError("custom-command failed: " + e.getMessage());
        }
    }

    public void disconnect() {
        if (socket != null) {
            socket.disconnect();
            socket.off();
            socket = null;
        }
    }

    private void emit(String event, JSONObject payload) {
        if (socket == null || !socket.connected()) {
            listener.onError("Socket not connected");
            return;
        }
        socket.emit(event, payload);
    }

    private static SeatUser[] parseSeats(JSONArray arr) throws Exception {
        SeatUser[] seats = new SeatUser[8];
        if (arr == null) return seats;
        for (int i = 0; i < Math.min(8, arr.length()); i++) {
            if (arr.isNull(i)) continue;
            JSONObject o = arr.getJSONObject(i);
            seats[i] = new SeatUser(
                    o.getString("socketId"),
                    o.optString("userId", ""),
                    o.optString("userName", ""),
                    o.optBoolean("muted", false));
        }
        return seats;
    }

    private static List<PeerInfo> parsePeers(JSONArray arr) throws Exception {
        List<PeerInfo> peers = new ArrayList<>();
        if (arr == null) return peers;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject p = arr.getJSONObject(i);
            peers.add(new PeerInfo(
                    p.getString("socketId"),
                    p.optString("userName", ""),
                    p.optBoolean("muted", false)));
        }
        return peers;
    }
}
