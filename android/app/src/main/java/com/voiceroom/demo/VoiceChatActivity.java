package com.voiceroom.demo;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Bundle;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.android.material.textfield.TextInputEditText;
import com.voiceroom.sdk.PeerInfo;
import com.voiceroom.sdk.VoiceConfig;
import com.voiceroom.sdk.VoiceEventListener;
import com.voiceroom.sdk.VoiceRoomManager;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * Demo screen — wire this into your existing chat app (replace Zego voice screen).
 */
public class VoiceChatActivity extends AppCompatActivity {

    private static final int REQ_MIC = 1001;

    private TextInputEditText editServerUrl;
    private TextInputEditText editUserName;
    private TextInputEditText editRoomId;
    private CheckBox checkHost;
    private Button btnJoin;
    private Button btnLeave;
    private Button btnMic;
    private Button btnMuteRemote;
    private TextView textStatus;
    private TextView textLog;

    private VoiceRoomManager roomManager;
    private boolean remoteMuted = false;
    private boolean inRoom = false;

    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_voice_chat);

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        editServerUrl = findViewById(R.id.editServerUrl);
        editUserName = findViewById(R.id.editUserName);
        editRoomId = findViewById(R.id.editRoomId);
        checkHost = findViewById(R.id.checkHost);
        btnJoin = findViewById(R.id.btnJoin);
        btnLeave = findViewById(R.id.btnLeave);
        btnMic = findViewById(R.id.btnMic);
        btnMuteRemote = findViewById(R.id.btnMuteRemote);
        textStatus = findViewById(R.id.textStatus);
        textLog = findViewById(R.id.textLog);

        btnJoin.setOnClickListener(v -> joinRoom());
        btnLeave.setOnClickListener(v -> leaveRoom());
        btnMic.setOnClickListener(v -> toggleMic());
        btnMuteRemote.setOnClickListener(v -> toggleRemoteMute());

        // Pre-fill from Intent (launch from your chat app)
        String user = getIntent().getStringExtra("userName");
        String room = getIntent().getStringExtra("roomId");
        String server = getIntent().getStringExtra("serverUrl");
        if (user != null) editUserName.setText(user);
        if (room != null) editRoomId.setText(room);
        if (server != null) editServerUrl.setText(server);
        checkHost.setChecked(getIntent().getBooleanExtra("isHost", false));
    }

    private void joinRoom() {
        String serverUrl = text(editServerUrl);
        String userName = text(editUserName);
        String roomId = text(editRoomId);
        if (serverUrl.isEmpty() || userName.isEmpty() || roomId.isEmpty()) {
            toast("Enter server URL, name, and room ID");
            return;
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return;
        }

        startVoice(serverUrl, userName, roomId, checkHost.isChecked());
    }

    private void startVoice(String serverUrl, String userName, String roomId, boolean isHost) {
        setUiInRoom(false);
        appendLog("Connecting…");

        configureAudioForCall();

        VoiceConfig config = new VoiceConfig(serverUrl);
        roomManager = new VoiceRoomManager(this, config, eventListener);

        roomManager.signIn(userName,
                () -> roomManager.loginRoom(roomId, isHost),
                err -> {
                    toast(err);
                    setUiInRoom(false);
                });
    }

    private void leaveRoom() {
        if (roomManager == null) return;
        btnLeave.setEnabled(false);
        roomManager.logout(() -> {
            roomManager = null;
            inRoom = false;
            setUiInRoom(false);
            appendLog("Left room");
            textStatus.setText("Disconnected");
            restoreAudioAfterCall();
        });
    }

    private void toggleMic() {
        if (roomManager == null) return;
        boolean muted = roomManager.toggleMic();
        btnMic.setText(muted ? "Unmute mic" : "Mute mic");
    }

    private void toggleRemoteMute() {
        if (roomManager == null) return;
        remoteMuted = !remoteMuted;
        roomManager.muteAllRemote(remoteMuted);
        btnMuteRemote.setText(remoteMuted ? "Unmute all remote" : "Mute all remote");
    }

    private void configureAudioForCall() {
        if (audioManager == null) return;
        try {
            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            audioManager.setSpeakerphoneOn(true);

            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(attrs)
                    .setAcceptsDelayedFocusGain(true)
                    .setOnAudioFocusChangeListener(focusChange -> { /* ignore */ })
                    .build();
            audioManager.requestAudioFocus(audioFocusRequest);
        } catch (Exception e) {
            appendLog("Audio setup warning: " + e.getMessage());
        }
    }

    private void restoreAudioAfterCall() {
        if (audioManager == null) return;
        try {
            if (audioFocusRequest != null) {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
                audioFocusRequest = null;
            }
            audioManager.setSpeakerphoneOn(false);
            audioManager.setMode(AudioManager.MODE_NORMAL);
        } catch (Exception ignored) {
        }
    }

    private void setUiInRoom(boolean joined) {
        inRoom = joined;
        btnJoin.setEnabled(!joined);
        btnLeave.setEnabled(joined);
        btnMic.setEnabled(joined);
        btnMuteRemote.setEnabled(joined);
        editServerUrl.setEnabled(!joined);
        editUserName.setEnabled(!joined);
        editRoomId.setEnabled(!joined);
        checkHost.setEnabled(!joined);
    }

    private final VoiceEventListener eventListener = new VoiceEventListener() {
        @Override
        public void onSignedIn(String userName) {
            appendLog("Signed in as " + userName);
        }

        @Override
        public void onRoomStateChanged(String state, String roomId) {
            textStatus.setText(state);
            appendLog("Room state: " + state);
            if ("connected".equals(state)) {
                setUiInRoom(true);
            }
        }

        @Override
        public void onRoomJoined(String roomId, List<PeerInfo> peers) {
            appendLog("In room " + roomId + ", peers=" + peers.size());
        }

        @Override
        public void onPeerJoined(String socketId, String userName) {
            appendLog("Peer joined: " + userName);
        }

        @Override
        public void onPeerLeft(String socketId, String userName) {
            appendLog("Peer left: " + (userName != null ? userName : socketId));
        }

        @Override
        public void onRemoteStreamAdded(String socketId) {
            appendLog("Hearing audio from " + socketId);
            toast("Remote voice connected");
        }

        @Override
        public void onPeerConnectionState(String socketId, String state) {
            appendLog("ICE " + socketId + ": " + state);
        }

        @Override
        public void onLog(String message) {
            appendLog(message);
        }

        @Override
        public void onError(String message) {
            appendLog("ERROR: " + message);
            toast(message);
        }
    };

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_MIC && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            joinRoom();
        } else {
            toast("Microphone permission required");
        }
    }

    @Override
    protected void onDestroy() {
        if (roomManager != null) {
            roomManager.logout(() -> roomManager = null);
        }
        restoreAudioAfterCall();
        super.onDestroy();
    }

    private static String text(TextInputEditText edit) {
        return edit.getText() != null ? edit.getText().toString().trim() : "";
    }

    private void appendLog(String line) {
        String ts = new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date());
        CharSequence cur = textLog.getText();
        String next = (cur != null && cur.length() > 0 ? cur + "\n" : "") + ts + " " + line;
        textLog.setText(next);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }
}
