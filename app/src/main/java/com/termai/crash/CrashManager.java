package com.termai.crash;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;

import com.termai.log.Logger;

import org.json.JSONObject;

import java.io.*;
import java.text.SimpleDateFormat;
import java.util.*;

/**
 * CrashManager — Crash detection, state preservation, and auto-restore.
 *
 * On every significant action, state is saved.
 * On startup, checks if previous session ended cleanly.
 * If not (crash), offers to restore last known state.
 */
public class CrashManager implements Thread.UncaughtExceptionHandler {

    private static final String PREF_FILE       = "termai_crash";
    private static final String PREF_CLEAN_EXIT = "clean_exit";
    private static final String PREF_LAST_CMD   = "last_cmd";
    private static final String PREF_LAST_CWD   = "last_cwd";
    private static final String PREF_LAST_PRJ   = "last_project";
    private static final String PREF_CRASH_TIME = "crash_time";
    private static final String PREF_CRASH_MSG  = "crash_msg";
    private static final String CRASH_LOG_FILE  = "crash_report.txt";

    private final Context              context;
    private final Logger               logger;
    private final SharedPreferences    prefs;
    private final Thread.UncaughtExceptionHandler defaultHandler;
    private final File                 crashLogFile;

    public CrashManager(Context context, Logger logger) {
        this.context        = context;
        this.logger         = logger;
        this.prefs          = context.getSharedPreferences(PREF_FILE, Context.MODE_PRIVATE);
        this.crashLogFile   = new File(context.getFilesDir(), CRASH_LOG_FILE);
        this.defaultHandler = Thread.getDefaultUncaughtExceptionHandler();

        // Register as default handler
        Thread.setDefaultUncaughtExceptionHandler(this);
    }

    // ─── Startup check ────────────────────────────
    /**
     * Call on startup. Returns true if previous session crashed.
     */
    public boolean didCrash() {
        return !prefs.getBoolean(PREF_CLEAN_EXIT, true);
    }

    /**
     * Mark session as started (not clean exit yet).
     */
    public void sessionStarted() {
        prefs.edit().putBoolean(PREF_CLEAN_EXIT, false).apply();
        logger.system(Logger.Level.INFO, "Session started");
    }

    /**
     * Mark session as ending cleanly.
     */
    public void sessionEnded() {
        prefs.edit().putBoolean(PREF_CLEAN_EXIT, true).apply();
        logger.system(Logger.Level.INFO, "Session ended cleanly");
    }

    // ─── State save ───────────────────────────────
    @JavascriptInterface
    public void saveState(String cwd, String lastCmd, String activeProject) {
        prefs.edit()
            .putString(PREF_LAST_CWD, cwd        != null ? cwd : "~")
            .putString(PREF_LAST_CMD, lastCmd     != null ? lastCmd : "")
            .putString(PREF_LAST_PRJ, activeProject != null ? activeProject : "")
            .apply();
    }

    // ─── Restore state ────────────────────────────
    @JavascriptInterface
    public String getLastState() {
        try {
            return new JSONObject()
                .put("crashed",       didCrash())
                .put("lastCwd",       prefs.getString(PREF_LAST_CWD, "~"))
                .put("lastCmd",       prefs.getString(PREF_LAST_CMD, ""))
                .put("lastProject",   prefs.getString(PREF_LAST_PRJ, ""))
                .put("crashTime",     prefs.getLong(PREF_CRASH_TIME, 0))
                .put("crashMessage",  prefs.getString(PREF_CRASH_MSG, ""))
                .toString();
        } catch (Exception e) { return "{}"; }
    }

    @JavascriptInterface
    public void clearCrashState() {
        prefs.edit()
            .putBoolean(PREF_CLEAN_EXIT, true)
            .putString(PREF_CRASH_MSG, "")
            .putLong(PREF_CRASH_TIME, 0)
            .apply();
    }

    @JavascriptInterface
    public String readCrashReport() {
        if (!crashLogFile.exists()) return "\"No crash report found.\"";
        try {
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new FileReader(crashLogFile))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line).append("\n");
            }
            return org.json.JSONObject.quote(sb.toString());
        } catch (IOException e) {
            return org.json.JSONObject.quote("Error reading crash report: " + e.getMessage());
        }
    }

    // ─── UncaughtExceptionHandler ─────────────────
    @Override
    public void uncaughtException(Thread thread, Throwable ex) {
        try {
            String msg = ex.getClass().getSimpleName() + ": " + ex.getMessage();
            long   now = System.currentTimeMillis();

            // Save crash metadata
            prefs.edit()
                .putBoolean(PREF_CLEAN_EXIT, false)
                .putLong(PREF_CRASH_TIME, now)
                .putString(PREF_CRASH_MSG, msg)
                .apply();

            // Write crash report
            writeCrashReport(thread, ex, now);

            logger.crash("UNCAUGHT: " + msg);

        } catch (Exception ignored) {
            // Never crash the crash handler
        } finally {
            // Delegate to system handler for normal crash flow
            if (defaultHandler != null) defaultHandler.uncaughtException(thread, ex);
        }
    }

    private void writeCrashReport(Thread thread, Throwable ex, long timestamp) {
        try (PrintWriter pw = new PrintWriter(new FileWriter(crashLogFile))) {
            String time = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
                .format(new Date(timestamp));
            pw.println("=== TermAI Crash Report ===");
            pw.println("Time:    " + time);
            pw.println("Thread:  " + thread.getName());
            pw.println("Message: " + ex.getMessage());
            pw.println();
            pw.println("=== Stack Trace ===");
            ex.printStackTrace(pw);
            pw.println();
            pw.println("=== Last State ===");
            pw.println("CWD:     " + prefs.getString(PREF_LAST_CWD, "unknown"));
            pw.println("LastCmd: " + prefs.getString(PREF_LAST_CMD, "none"));
            pw.println("Project: " + prefs.getString(PREF_LAST_PRJ, "none"));
        } catch (IOException ignored) {}
    }
}
