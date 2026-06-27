package com.termai.util;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import org.json.JSONObject;

/**
 * JsCallback — Thread-safe utility for calling JavaScript from any thread.
 *
 * Ensures:
 * - Always runs on main thread
 * - Proper JSON escaping (single pass, no duplicates)
 * - Null-safe
 */
public class JsCallback {

    private final WebView webView;
    private final Handler mainHandler;

    public JsCallback(WebView webView) {
        this.webView     = webView;
        this.mainHandler = new Handler(Looper.getMainLooper());
    }

    /** Call a JS function registered under window.terminalCallbacks[id] */
    public void resolve(String callbackId, String jsonPayload) {
        if (callbackId == null || webView == null) return;
        final String js =
            "var fn=window.terminalCallbacks&&window.terminalCallbacks['" + callbackId + "'];" +
            "if(fn){delete window.terminalCallbacks['" + callbackId + "'];fn(" + jsonPayload + ");}";
        runOnMain(() -> webView.evaluateJavascript(js, null));
    }

    /** Stream a chunk of output to JS */
    public void streamChunk(String sessionId, String chunk) {
        if (chunk == null || webView == null) return;
        final String js =
            "window.onShellChunk&&window.onShellChunk(" +
            JSONObject.quote(sessionId) + "," +
            JSONObject.quote(chunk) + ");";
        runOnMain(() -> webView.evaluateJavascript(js, null));
    }

    /** Evaluate arbitrary JS safely on main thread */
    public void eval(String js) {
        if (js == null || webView == null) return;
        runOnMain(() -> webView.evaluateJavascript(js, null));
    }

    /** Build standard command-done JSON */
    public static String buildDonePayload(int exitCode, String cwd) {
        return String.format(
            "{\"exitCode\":%d,\"cwd\":%s}",
            exitCode,
            JSONObject.quote(cwd != null ? cwd : "~")
        );
    }

    private void runOnMain(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            r.run();
        } else {
            mainHandler.post(r);
        }
    }
}
