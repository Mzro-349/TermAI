package com.termai.settings;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.util.*;

/**
 * SettingsManager — Single source of truth for ALL app settings.
 *
 * Organized into categories: UI, Terminal, AI, Security, Developer.
 * All reads/writes go through here — no scattered SharedPreferences access.
 * Notifies JS on any change via a registered callback.
 */
public class SettingsManager {

    private static final String PREF_FILE = "termai_settings";

    // ─── Setting keys ─────────────────────────────
    // UI
    public static final String THEME        = "theme";
    public static final String FONT_SIZE    = "font_size";
    public static final String CURSOR_STYLE = "cursor_style";
    public static final String SCROLLBACK   = "scrollback";
    // Terminal
    public static final String SHELL        = "shell";
    public static final String WORK_DIR     = "work_dir";
    // AI
    public static final String AI_ENDPOINT  = "ai_endpoint";
    public static final String AI_LANG      = "ai_lang";
    public static final String AI_MODEL     = "ai_model";
    public static final String AI_AUTO_ERR  = "ai_auto_error";
    public static final String AI_MAX_TOK   = "ai_max_tokens";
    // Security
    public static final String SEC_ENABLED  = "security_enabled";
    public static final String SEC_SANDBOX  = "security_sandbox";
    public static final String SEC_AUDIT    = "security_audit";
    // Developer
    public static final String DEV_VERBOSE  = "dev_verbose";
    public static final String DEV_LOG_AI   = "dev_log_ai";

    // ─── Defaults ─────────────────────────────────
    private static final Map<String, Object> DEFAULTS = new HashMap<String, Object>() {{
        put(THEME,        "dark");
        put(FONT_SIZE,    14);
        put(CURSOR_STYLE, "block");
        put(SCROLLBACK,   5000);
        put(SHELL,        "sh");
        put(WORK_DIR,     "~");
        put(AI_ENDPOINT,  "");
        put(AI_LANG,      "ar");
        put(AI_MODEL,     "claude-sonnet-4-6");
        put(AI_AUTO_ERR,  true);
        put(AI_MAX_TOK,   1000);
        put(SEC_ENABLED,  true);
        put(SEC_SANDBOX,  false);
        put(SEC_AUDIT,    true);
        put(DEV_VERBOSE,  false);
        put(DEV_LOG_AI,   false);
    }};

    // ─── State ────────────────────────────────────
    private final SharedPreferences prefs;
    private       ChangeListener    listener;

    public interface ChangeListener {
        void onSettingChanged(String key, Object value);
    }

    public SettingsManager(Context context) {
        this.prefs = context.getSharedPreferences(PREF_FILE, Context.MODE_PRIVATE);
    }

    public void setChangeListener(ChangeListener l) { this.listener = l; }

    // ─── Get / Set ───────────────────────────────
    public String  getString(String key)  { return prefs.getString(key, (String)  DEFAULTS.getOrDefault(key, "")); }
    public int     getInt(String key)     { return prefs.getInt(key,    (Integer) DEFAULTS.getOrDefault(key, 0)); }
    public boolean getBool(String key)    { return prefs.getBoolean(key,(Boolean) DEFAULTS.getOrDefault(key, false)); }

    public void set(String key, String value)  { prefs.edit().putString(key, value).apply();  notifyChange(key, value); }
    public void set(String key, int value)     { prefs.edit().putInt(key, value).apply();      notifyChange(key, value); }
    public void set(String key, boolean value) { prefs.edit().putBoolean(key, value).apply();  notifyChange(key, value); }

    private void notifyChange(String key, Object value) {
        if (listener != null) listener.onSettingChanged(key, value);
    }

    // ─── JS Interface ─────────────────────────────
    @JavascriptInterface
    public String getAllSettings() {
        try {
            JSONObject obj = new JSONObject();
            obj.put(THEME,        getString(THEME));
            obj.put(FONT_SIZE,    getInt(FONT_SIZE));
            obj.put(CURSOR_STYLE, getString(CURSOR_STYLE));
            obj.put(SCROLLBACK,   getInt(SCROLLBACK));
            obj.put(SHELL,        getString(SHELL));
            obj.put(AI_ENDPOINT,  getString(AI_ENDPOINT));
            obj.put(AI_LANG,      getString(AI_LANG));
            obj.put(AI_MODEL,     getString(AI_MODEL));
            obj.put(AI_AUTO_ERR,  getBool(AI_AUTO_ERR));
            obj.put(AI_MAX_TOK,   getInt(AI_MAX_TOK));
            obj.put(SEC_ENABLED,  getBool(SEC_ENABLED));
            obj.put(SEC_SANDBOX,  getBool(SEC_SANDBOX));
            obj.put(SEC_AUDIT,    getBool(SEC_AUDIT));
            obj.put(DEV_VERBOSE,  getBool(DEV_VERBOSE));
            return obj.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    @JavascriptInterface
    public void setString(String key, String value) { set(key, value); }

    @JavascriptInterface
    public void setInt(String key, int value) { set(key, value); }

    @JavascriptInterface
    public void setBool(String key, boolean value) { set(key, value); }

    @JavascriptInterface
    public String getSettingString(String key) { return getString(key); }

    @JavascriptInterface
    public int getSettingInt(String key) { return getInt(key); }

    @JavascriptInterface
    public boolean getSettingBool(String key) { return getBool(key); }

    @JavascriptInterface
    public void resetToDefaults() {
        SharedPreferences.Editor editor = prefs.edit();
        for (Map.Entry<String, Object> entry : DEFAULTS.entrySet()) {
            Object val = entry.getValue();
            if (val instanceof String)  editor.putString(entry.getKey(), (String)  val);
            if (val instanceof Integer) editor.putInt(entry.getKey(),    (Integer) val);
            if (val instanceof Boolean) editor.putBoolean(entry.getKey(),(Boolean) val);
        }
        editor.apply();
    }
}
