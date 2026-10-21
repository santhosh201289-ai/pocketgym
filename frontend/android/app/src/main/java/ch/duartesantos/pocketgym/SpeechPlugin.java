package ch.duartesantos.pocketgym;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;

/**
 * Speech to text for planning by voice (frontend/src/lib/speech.js). Android's WebView has no
 * SpeechRecognition, so the page asks the phone's own recogniser through this: one utterance per
 * listen(), the words back as text, nothing recorded or kept. The microphone permission is asked
 * the first time someone taps the microphone, not before.
 */
@CapacitorPlugin(name = "Speech", permissions = { @Permission(alias = "mic", strings = { Manifest.permission.RECORD_AUDIO }) })
public class SpeechPlugin extends Plugin {

    private SpeechRecognizer recognizer;
    private PluginCall pending;

    @PluginMethod
    public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void listen(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "micAnswered");
            return;
        }
        start(call);
    }

    @PermissionCallback
    private void micAnswered(PluginCall call) {
        if (getPermissionState("mic") == PermissionState.GRANTED) start(call);
        else call.reject("The microphone is not allowed", "permission");
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> { if (recognizer != null) recognizer.stopListening(); });
        call.resolve();
    }

    private void start(PluginCall call) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.reject("No speech recogniser on this phone", "unsupported");
            return;
        }
        String lang = call.getString("lang", "en-IN");
        getActivity().runOnUiThread(() -> {
            // One at a time: a second tap ends the first listen.
            if (pending != null) { pending.reject("Stopped", "failed"); pending = null; }
            if (recognizer != null) recognizer.destroy();
            pending = call;
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onEvent(int eventType, Bundle params) {}

                @Override public void onPartialResults(Bundle partial) {
                    ArrayList<String> m = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (m == null || m.isEmpty()) return;
                    JSObject e = new JSObject();
                    e.put("text", m.get(0));
                    notifyListeners("partial", e);
                }

                @Override public void onResults(Bundle results) {
                    ArrayList<String> m = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    PluginCall c = pending;
                    pending = null;
                    if (c == null) return;
                    if (m == null || m.isEmpty()) { c.reject("Nothing was heard", "no-speech"); return; }
                    JSObject r = new JSObject();
                    r.put("text", m.get(0));
                    JSArray alt = new JSArray();
                    for (int i = 1; i < m.size(); i++) alt.put(m.get(i));
                    r.put("alternatives", alt);
                    c.resolve(r);
                }

                @Override public void onError(int error) {
                    PluginCall c = pending;
                    pending = null;
                    if (c == null) return;
                    boolean quiet = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
                    boolean denied = error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS;
                    c.reject("Speech recognition error " + error, quiet ? "no-speech" : denied ? "permission" : "failed");
                }
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            recognizer.startListening(i);
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (recognizer != null) { recognizer.destroy(); recognizer = null; }
    }
}
