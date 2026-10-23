package com.watchkeeper;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Speech, natively.
 *
 * Android's WebView implements neither SpeechRecognition nor a dependable
 * speechSynthesis, so a plain web wrapper would lose every voice feature.
 * These wrap the platform engines, which also means recognition keeps working
 * with no connection on devices that have the offline language pack.
 */
public class VoiceBridge {

    /* ---------------- speaking ---------------- */

    public interface Done { void run(); }

    private static int utteranceSeq = 0;

    public static void speakOnce(TextToSpeech tts, String text, final Done done) {
        if (tts == null || text == null) { if (done != null) done.run(); return; }
        final String uid = "wk" + (++utteranceSeq);

        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String s) { }
            @Override public void onDone(String s) { if (done != null) done.run(); }
            @Override public void onError(String s) { if (done != null) done.run(); }
        });

        Bundle params = new Bundle();
        params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, android.media.AudioManager.STREAM_ALARM);
        try {
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, uid);
        } catch (Exception e) {
            if (done != null) done.run();
        }
    }

    /* ---------------- listening ---------------- */

    public static class NativeRecognizer {

        public interface Callback {
            void onResult(String text);
            void onError(String why);
        }

        private final Context context;
        private SpeechRecognizer sr;
        private Callback cb;
        private boolean finished = false;

        public NativeRecognizer(Context c) {
            this.context = c.getApplicationContext();
        }

        public boolean available() {
            return SpeechRecognizer.isRecognitionAvailable(context);
        }

        public void listen(Callback callback) {
            this.cb = callback;
            this.finished = false;

            if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                fail("unavailable");
                return;
            }
            try {
                sr = SpeechRecognizer.createSpeechRecognizer(context);
            } catch (Exception e) {
                fail("create-failed");
                return;
            }

            sr.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle b) { }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float v) { }
                @Override public void onBufferReceived(byte[] b) { }
                @Override public void onEndOfSpeech() { }

                @Override public void onError(int code) {
                    fail("code-" + code);
                }

                @Override public void onResults(Bundle results) {
                    ArrayList<String> list =
                            results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    deliver(list == null || list.isEmpty() ? "" : list.get(0));
                }

                @Override public void onPartialResults(Bundle b) { }
                @Override public void onEvent(int i, Bundle b) { }
            });

            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.UK.toLanguageTag());
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
            i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.getPackageName());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                /* Use the on-device engine when the language pack is present,
                   so an alarm can still be answered with no signal. */
                i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            }
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1200L);

            try {
                sr.startListening(i);
            } catch (Exception e) {
                fail("start-failed");
            }
        }

        private void deliver(String text) {
            if (finished) return;
            finished = true;
            Callback c = cb;
            release();
            if (c != null) c.onResult(text);
        }

        private void fail(String why) {
            if (finished) return;
            finished = true;
            Callback c = cb;
            release();
            if (c != null) c.onError(why);
        }

        public void cancel() {
            finished = true;
            release();
        }

        private void release() {
            if (sr != null) {
                try { sr.cancel(); } catch (Exception ignored) { }
                try { sr.destroy(); } catch (Exception ignored) { }
                sr = null;
            }
        }
    }
}
