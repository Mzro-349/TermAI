package com.termai.ai;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.termai.log.Logger;
import com.termai.settings.SettingsManager;
import com.termai.util.JsCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * AIManager — Single Responsibility: all AI/API logic.
 *
 * Responsibilities:
 * - Secure storage of API endpoint / keys
 * - Rate limiting (prevent abuse)
 * - Plan generation: user request → structured execution plan
 * - Streaming API calls
 * - AI call logging
 * - Provider abstraction (Claude / OpenAI / Gemini future)
 *
 * MainActivity knows NOTHING about AI providers.
 * TerminalBridge knows NOTHING about AI.
 * JS ai-engine.js handles UI; AIManager.java handles native concerns.
 */
public class AIManager {

    // Rate limit: max 60 calls per minute
    private static final int    RATE_WINDOW_MS = 60_000;
    private static final int    RATE_MAX       = 60;
    private static final int    TIMEOUT_MS     = 30_000;
    private static final String PREF_FILE      = "termai_ai";

    private final Context        context;
    private final SettingsManager settings;
    private final Logger          logger;
    private final JsCallback      jsCallback;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Handler         mainHandler = new Handler(Looper.getMainLooper());

    // Rate limiting
    private final AtomicInteger   callCount  = new AtomicInteger(0);
    private       long            windowStart = System.currentTimeMillis();

    // Session stats
    private       int totalCallsSession = 0;
    private       int totalTokensSession = 0;

    public AIManager(Context context, SettingsManager settings, Logger logger, WebView webView) {
        this.context    = context;
        this.settings   = settings;
        this.logger     = logger;
        this.jsCallback = new JsCallback(webView);
    }

    // ─── Rate limit check ─────────────────────────
    private boolean checkRateLimit() {
        long now = System.currentTimeMillis();
        if (now - windowStart > RATE_WINDOW_MS) {
            windowStart = now;
            callCount.set(0);
        }
        return callCount.incrementAndGet() <= RATE_MAX;
    }

    // ─── Core API call ────────────────────────────
    /**
     * Make an API call to the configured endpoint.
     * callbackId: JS callback to fire with result.
     * systemPrompt + messages: full conversation context.
     */
    @JavascriptInterface
    public void call(String systemPrompt, String messagesJson, String callbackId) {
        if (!checkRateLimit()) {
            jsCallback.resolve(callbackId,
                "{\"error\":\"Rate limit exceeded. Wait 1 minute.\"}");
            return;
        }

        final String endpoint = settings.getString(SettingsManager.AI_ENDPOINT);
        if (endpoint.isEmpty()) {
            jsCallback.resolve(callbackId, "{\"error\":\"NO_ENDPOINT\"}");
            return;
        }

        executor.submit(() -> {
            long startMs = System.currentTimeMillis();
            try {
                JSONObject payload = new JSONObject();
                payload.put("system",   systemPrompt);
                payload.put("messages", new JSONArray(messagesJson));
                payload.put("lang",     settings.getString(SettingsManager.AI_LANG));

                String response  = httpPost(endpoint, payload.toString());
                JSONObject resObj = new JSONObject(response);
                String content   = resObj.optString("content", "");

                totalCallsSession++;
                logger.ai(Logger.Level.INFO,
                    String.format("Call #%d | %dms | %d chars",
                        totalCallsSession,
                        System.currentTimeMillis() - startMs,
                        content.length()));

                jsCallback.resolve(callbackId,
                    "{\"content\":" + JSONObject.quote(content) + "}");

            } catch (Exception e) {
                logger.ai(Logger.Level.ERROR, "API error: " + e.getMessage());
                jsCallback.resolve(callbackId,
                    "{\"error\":" + JSONObject.quote(e.getMessage()) + "}");
            }
        });
    }

    /**
     * Generate an execution plan from a natural language request.
     * Returns a structured JSON plan for the JS Planner to show to user.
     */
    @JavascriptInterface
    public void generatePlan(String userRequest, String callbackId) {
        if (!checkRateLimit()) {
            jsCallback.resolve(callbackId, "{\"error\":\"Rate limit exceeded\"}");
            return;
        }

        final String endpoint = settings.getString(SettingsManager.AI_ENDPOINT);
        if (endpoint.isEmpty()) {
            jsCallback.resolve(callbackId, "{\"error\":\"NO_ENDPOINT\"}");
            return;
        }

        executor.submit(() -> {
            try {
                String planPrompt = buildPlannerSystemPrompt();
                String userMsg    = "Generate execution plan for: " + userRequest;

                JSONObject payload = new JSONObject();
                payload.put("system",   planPrompt);
                payload.put("messages", new JSONArray().put(
                    new JSONObject().put("role","user").put("content", userMsg)
                ));
                payload.put("lang", settings.getString(SettingsManager.AI_LANG));

                String raw = httpPost(endpoint, payload.toString());
                JSONObject res = new JSONObject(raw);
                String content = res.optString("content","{}");

                // Clean JSON fences
                content = content.replaceAll("```json|```","").trim();

                logger.ai(Logger.Level.INFO, "Plan generated for: " + userRequest);
                jsCallback.resolve(callbackId,
                    "{\"plan\":" + content + "}");

            } catch (Exception e) {
                logger.ai(Logger.Level.ERROR, "Plan error: " + e.getMessage());
                jsCallback.resolve(callbackId,
                    "{\"error\":" + JSONObject.quote(e.getMessage()) + "}");
            }
        });
    }

    // ─── System prompts ───────────────────────────
    private String buildPlannerSystemPrompt() {
        String lang = settings.getString(SettingsManager.AI_LANG);
        String langInstr = lang.equals("ar")
            ? "Respond in Saudi Arabic dialect for descriptions. Use English for commands only."
            : "Respond in English.";

        return "You are TermAI Planner. Convert user requests into structured execution plans.\n"
            + langInstr + "\n\n"
            + "ALWAYS respond with ONLY this JSON structure, no markdown:\n"
            + "{\n"
            + "  \"title\": \"Brief plan title\",\n"
            + "  \"description\": \"What this plan does\",\n"
            + "  \"risk\": \"SAFE|LOW|MEDIUM|HIGH\",\n"
            + "  \"steps\": [\n"
            + "    {\n"
            + "      \"id\": 1,\n"
            + "      \"description\": \"Human-readable description\",\n"
            + "      \"command\": \"exact shell command\",\n"
            + "      \"critical\": true,\n"
            + "      \"undo\": \"command to undo this step or null\"\n"
            + "    }\n"
            + "  ],\n"
            + "  \"estimatedTime\": \"~30s\",\n"
            + "  \"packages\": [\"list of packages to install if any\"]\n"
            + "}\n\n"
            + "Rules:\n"
            + "- Commands must work in Termux/Android shell without root\n"
            + "- Split complex operations into small reversible steps\n"
            + "- Mark steps as critical=true if failure should stop the plan\n"
            + "- risk reflects the most dangerous step in the plan";
    }

    // ─── HTTP ─────────────────────────────────────
    private String httpPost(String endpoint, String body) throws IOException {
        URL url = new URL(endpoint);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);
        conn.setConnectTimeout(TIMEOUT_MS);
        conn.setReadTimeout(TIMEOUT_MS);

        try (OutputStream os = conn.getOutputStream()) {
            os.write(body.getBytes("UTF-8"));
        }

        int code = conn.getResponseCode();
        InputStream is = (code >= 200 && code < 300)
            ? conn.getInputStream() : conn.getErrorStream();

        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"))) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
        }

        if (code >= 400) throw new IOException("HTTP " + code + ": " + sb);
        return sb.toString();
    }

    // ─── Stats / Status ───────────────────────────
    @JavascriptInterface
    public String getSessionStats() {
        try {
            return new JSONObject()
                .put("totalCalls",  totalCallsSession)
                .put("rateUsed",    callCount.get())
                .put("rateMax",     RATE_MAX)
                .put("endpoint",    !settings.getString(SettingsManager.AI_ENDPOINT).isEmpty())
                .toString();
        } catch (Exception e) { return "{}"; }
    }

    @JavascriptInterface
    public void resetStats() {
        totalCallsSession = 0;
        totalTokensSession = 0;
    }

    public void shutdown() { executor.shutdownNow(); }
}
