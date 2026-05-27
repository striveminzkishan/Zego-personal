package com.voiceroom.sdk;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native WebRTC engine — mirrors public/engine.js.
 */
public class WebRtcVoiceEngine {

    private static final String TAG = "WebRtcVoiceEngine";

    public interface EngineListener {
        void onIceCandidate(String peerId, JSONObject candidate);
        void onRemoteAudioTrack(String peerId);
        void onIceConnectionChange(String peerId, String state);
        void onError(String message);
    }

    private final Context appContext;
    private final VoiceConfig config;
    private final EngineListener listener;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private PeerConnectionFactory factory;
    private AudioSource audioSource;
    private AudioTrack localAudioTrack;
    private final Map<String, PeerConnection> peerConnections = new ConcurrentHashMap<>();
    private final Map<String, List<IceCandidate>> iceQueues = new ConcurrentHashMap<>();
    private final Map<String, AudioTrack> remoteAudioTracks = new ConcurrentHashMap<>();

    private boolean micMuted = false;
    private boolean allRemoteMuted = false;

    public WebRtcVoiceEngine(Context context, VoiceConfig config, EngineListener listener) {
        this.appContext = context.getApplicationContext();
        this.config = config;
        this.listener = listener;
    }

    public void init(Runnable onReady, java.util.function.Consumer<String> onError) {
        executor.execute(() -> {
            try {
                PeerConnectionFactory.InitializationOptions initOptions =
                        PeerConnectionFactory.InitializationOptions.builder(appContext)
                                .setEnableInternalTracer(false)
                                .createInitializationOptions();
                PeerConnectionFactory.initialize(initOptions);

                factory = PeerConnectionFactory.builder()
                        .createPeerConnectionFactory();

                Log.d(TAG, "PeerConnectionFactory ready");
                onReady.run();
            } catch (Exception e) {
                Log.e(TAG, "init failed", e);
                onError.accept(e.getMessage());
            }
        });
    }

    public void startLocalAudio(Runnable onReady, java.util.function.Consumer<String> onError) {
        executor.execute(() -> {
            try {
                MediaConstraints constraints = new MediaConstraints();
                audioSource = factory.createAudioSource(constraints);
                localAudioTrack = factory.createAudioTrack("ARDAMSAudioTrack", audioSource);
                localAudioTrack.setEnabled(true);
                Log.d(TAG, "Local audio started");
                onReady.run();
            } catch (Exception e) {
                Log.e(TAG, "startLocalAudio failed", e);
                onError.accept(e.getMessage());
            }
        });
    }

    public void createPeerConnection(String peerId, Runnable onReady) {
        executor.execute(() -> {
            try {
                closePeerConnectionInternal(peerId);

                PeerConnection.RTCConfiguration rtcConfig =
                        new PeerConnection.RTCConfiguration(config.getIceServers());
                rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

                PeerConnection pc = factory.createPeerConnection(rtcConfig, newPeerObserver(peerId));
                if (pc == null) {
                    listener.onError("Failed to create PeerConnection for " + peerId);
                    return;
                }

                peerConnections.put(peerId, pc);
                iceQueues.put(peerId, new ArrayList<>());

                if (localAudioTrack != null) {
                    pc.addTrack(localAudioTrack, Collections.singletonList("local_stream"));
                    Log.d(TAG, "Added local track to " + peerId);
                } else {
                    Log.w(TAG, "No local audio track when creating PC for " + peerId);
                }

                onReady.run();
            } catch (Exception e) {
                Log.e(TAG, "createPeerConnection failed", e);
                listener.onError(e.getMessage());
            }
        });
    }

    public void createOffer(String peerId, java.util.function.Consumer<JSONObject> onSuccess,
                            java.util.function.Consumer<String> onError) {
        executor.execute(() -> {
            PeerConnection pc = peerConnections.get(peerId);
            if (pc == null) {
                onError.accept("No peer connection for " + peerId);
                return;
            }
            pc.createOffer(new SdpObserverAdapter() {
                @Override
                public void onCreateSuccess(SessionDescription sessionDescription) {
                    pc.setLocalDescription(new SdpObserverAdapter() {
                        @Override
                        public void onSetSuccess() {
                            try {
                                onSuccess.accept(toJsonSdp(sessionDescription));
                                Log.d(TAG, "Created offer for " + peerId);
                            } catch (Exception e) {
                                onError.accept(e.getMessage());
                            }
                        }

                        @Override
                        public void onSetFailure(String s) {
                            onError.accept(s);
                        }
                    }, sessionDescription);
                }

                @Override
                public void onCreateFailure(String s) {
                    onError.accept(s);
                }
            }, new MediaConstraints());
        });
    }

    public void handleOffer(String peerId, JSONObject offerJson,
                            java.util.function.Consumer<JSONObject> onSuccess,
                            java.util.function.Consumer<String> onError) {
        executor.execute(() -> {
            PeerConnection pc = peerConnections.get(peerId);
            if (pc == null) {
                onError.accept("No peer connection for " + peerId);
                return;
            }
            try {
                SessionDescription offer = fromJsonSdp(offerJson);
                pc.setRemoteDescription(new SdpObserverAdapter() {
                    @Override
                    public void onSetSuccess() {
                        flushIceCandidates(peerId);
                        pc.createAnswer(new SdpObserverAdapter() {
                            @Override
                            public void onCreateSuccess(SessionDescription answer) {
                                pc.setLocalDescription(new SdpObserverAdapter() {
                                    @Override
                                    public void onSetSuccess() {
                                        try {
                                            onSuccess.accept(toJsonSdp(answer));
                                            Log.d(TAG, "Created answer for " + peerId);
                                        } catch (Exception e) {
                                            onError.accept(e.getMessage());
                                        }
                                    }

                                    @Override
                                    public void onSetFailure(String s) {
                                        onError.accept(s);
                                    }
                                }, answer);
                            }

                            @Override
                            public void onCreateFailure(String s) {
                                onError.accept(s);
                            }
                        }, new MediaConstraints());
                    }

                    @Override
                    public void onSetFailure(String s) {
                        onError.accept(s);
                    }
                }, offer);
            } catch (Exception e) {
                onError.accept(e.getMessage());
            }
        });
    }

    public void handleAnswer(String peerId, JSONObject answerJson,
                             Runnable onSuccess, java.util.function.Consumer<String> onError) {
        executor.execute(() -> {
            PeerConnection pc = peerConnections.get(peerId);
            if (pc == null) {
                onError.accept("No peer connection for " + peerId);
                return;
            }
            if (pc.signalingState() != PeerConnection.SignalingState.HAVE_LOCAL_OFFER) {
                Log.w(TAG, "Ignoring stale answer from " + peerId + " state=" + pc.signalingState());
                onSuccess.run();
                return;
            }
            try {
                SessionDescription answer = fromJsonSdp(answerJson);
                pc.setRemoteDescription(new SdpObserverAdapter() {
                    @Override
                    public void onSetSuccess() {
                        flushIceCandidates(peerId);
                        Log.d(TAG, "Set answer from " + peerId);
                        onSuccess.run();
                    }

                    @Override
                    public void onSetFailure(String s) {
                        onError.accept(s);
                    }
                }, answer);
            } catch (Exception e) {
                onError.accept(e.getMessage());
            }
        });
    }

    public void handleIceCandidate(String peerId, JSONObject candidateJson) {
        executor.execute(() -> {
            PeerConnection pc = peerConnections.get(peerId);
            if (pc == null || candidateJson == null) return;

            try {
                IceCandidate candidate = fromJsonCandidate(candidateJson);
                if (pc.getRemoteDescription() == null) {
                    Log.d(TAG, "Queuing ICE for " + peerId);
                    iceQueues.computeIfAbsent(peerId, k -> new ArrayList<>()).add(candidate);
                } else {
                    pc.addIceCandidate(candidate);
                }
            } catch (Exception e) {
                Log.w(TAG, "ICE candidate error: " + e.getMessage());
            }
        });
    }

    public void closePeerConnection(String peerId) {
        executor.execute(() -> closePeerConnectionInternal(peerId));
    }

    public void closeAllPeerConnections() {
        executor.execute(() -> {
            for (String peerId : new ArrayList<>(peerConnections.keySet())) {
                closePeerConnectionInternal(peerId);
            }
        });
    }

    public boolean toggleMic() {
        micMuted = !micMuted;
        if (localAudioTrack != null) {
            localAudioTrack.setEnabled(!micMuted);
        }
        return micMuted;
    }

    public boolean isMicMuted() {
        return micMuted;
    }

    public void setAllRemoteMuted(boolean muted) {
        allRemoteMuted = muted;
        for (AudioTrack track : remoteAudioTracks.values()) {
            track.setEnabled(!muted);
        }
    }

    public void destroy(Runnable onDone) {
        executor.execute(() -> {
            closeAllPeerConnectionsInternal();
            if (localAudioTrack != null) {
                localAudioTrack.dispose();
                localAudioTrack = null;
            }
            if (audioSource != null) {
                audioSource.dispose();
                audioSource = null;
            }
            if (factory != null) {
                factory.dispose();
                factory = null;
            }
            remoteAudioTracks.clear();
            onDone.run();
        });
    }

    private void closePeerConnectionInternal(String peerId) {
        PeerConnection pc = peerConnections.remove(peerId);
        if (pc != null) {
            pc.close();
            pc.dispose();
        }
        iceQueues.remove(peerId);
        AudioTrack remote = remoteAudioTracks.remove(peerId);
        if (remote != null) {
            remote.setEnabled(false);
        }
    }

    private void closeAllPeerConnectionsInternal() {
        for (String peerId : new ArrayList<>(peerConnections.keySet())) {
            closePeerConnectionInternal(peerId);
        }
    }

    private void flushIceCandidates(String peerId) {
        PeerConnection pc = peerConnections.get(peerId);
        List<IceCandidate> queue = iceQueues.get(peerId);
        if (pc == null || queue == null) return;
        Log.d(TAG, "Flushing " + queue.size() + " ICE candidates for " + peerId);
        for (IceCandidate c : queue) {
            try {
                pc.addIceCandidate(c);
            } catch (Exception e) {
                Log.w(TAG, "Queued ICE error: " + e.getMessage());
            }
        }
        queue.clear();
    }

    private PeerConnection.Observer newPeerObserver(String peerId) {
        return new PeerConnection.Observer() {
            @Override
            public void onSignalingChange(PeerConnection.SignalingState signalingState) {}

            @Override
            public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
                Log.d(TAG, "ICE " + peerId + ": " + state);
                listener.onIceConnectionChange(peerId, state.name().toLowerCase());
            }

            @Override
            public void onIceConnectionReceivingChange(boolean b) {}

            @Override
            public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}

            @Override
            public void onIceCandidate(IceCandidate candidate) {
                try {
                    JSONObject json = new JSONObject();
                    json.put("sdpMid", candidate.sdpMid);
                    json.put("sdpMLineIndex", candidate.sdpMLineIndex);
                    json.put("candidate", candidate.sdp);
                    listener.onIceCandidate(peerId, json);
                } catch (Exception e) {
                    listener.onError("ICE emit failed: " + e.getMessage());
                }
            }

            @Override
            public void onIceCandidatesRemoved(IceCandidate[] candidates) {}

            @Override
            public void onAddStream(MediaStream stream) {}

            @Override
            public void onRemoveStream(MediaStream stream) {}

            @Override
            public void onDataChannel(DataChannel dc) {}

            @Override
            public void onRenegotiationNeeded() {}

            @Override
            public void onAddTrack(RtpReceiver receiver, MediaStream[] streams) {
                if (receiver.track() instanceof AudioTrack) {
                    AudioTrack remote = (AudioTrack) receiver.track();
                    remote.setEnabled(!allRemoteMuted);
                    remoteAudioTracks.put(peerId, remote);
                    Log.d(TAG, "Remote audio track from " + peerId);
                    listener.onRemoteAudioTrack(peerId);
                }
            }
        };
    }

    private static JSONObject toJsonSdp(SessionDescription sdp) throws Exception {
        JSONObject json = new JSONObject();
        json.put("type", sdp.type.canonicalForm());
        json.put("sdp", sdp.description);
        return json;
    }

    private static SessionDescription fromJsonSdp(JSONObject json) throws Exception {
        SessionDescription.Type type =
                SessionDescription.Type.fromCanonicalForm(json.getString("type"));
        return new SessionDescription(type, json.getString("sdp"));
    }

    private static IceCandidate fromJsonCandidate(JSONObject json) throws Exception {
        return new IceCandidate(
                json.optString("sdpMid", null),
                json.optInt("sdpMLineIndex"),
                json.getString("candidate"));
    }

    private abstract static class SdpObserverAdapter implements SdpObserver {
        @Override
        public void onCreateSuccess(SessionDescription sessionDescription) {}

        @Override
        public void onSetSuccess() {}

        @Override
        public void onCreateFailure(String s) {
            Log.e(TAG, "SDP create failure: " + s);
        }

        @Override
        public void onSetFailure(String s) {
            Log.e(TAG, "SDP set failure: " + s);
        }
    }
}
