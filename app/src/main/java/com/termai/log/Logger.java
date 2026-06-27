package com.termai.log;

import android.content.Context;
import android.webkit.JavascriptInterface;

import java.io.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;

/**
 * Logger — Centralized logging system.
 *
 * Channels: TERMINAL · SECURITY · AI · BILLING · CRASH · SYSTEM
 * Each channel → its own rotating log file.
 * Max 512KB per file → auto-rotate to .1.log backup.
 * Thread-safe: all writes go through a single-thread executor.
 */
public class Logger {

    public enum Channel { TERMINAL, SECURITY, AI, BILLING, CRASH, SYSTEM }
    public enum Level   { DEBUG, INFO, WARN, ERROR }

    private static final long     MAX_FILE_BYTES = 512 * 1024; // 512 KB
    private static final String   DATE_FORMAT    = "yyyy-MM-dd HH:mm:ss.SSS";
    private static final String   LOG_DIR        = "logs";

    private final File            logDir;
    private final ExecutorService writer = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "TermAI-Logger");
        t.setDaemon(true);
        return t;
    });
    private final SimpleDateFormat fmt = new SimpleDateFormat(DATE_FORMAT, Locale.US);

    // In-memory ring buffer for JS access (last 200 lines)
    private final ArrayDeque<String> ringBuffer = new ArrayDeque<>(200);

    public Logger(Context context) {
        this.logDir = new File(context.getFilesDir(), LOG_DIR);
        this.logDir.mkdirs();
        log(Channel.SYSTEM, Level.INFO, "Logger initialized. Dir: " + logDir.getAbsolutePath());
    }

    // ─── Public API ───────────────────────────────
    public void terminal(Level level, String msg) { log(Channel.TERMINAL, level, msg); }
    public void security(Level level, String msg) { log(Channel.SECURITY, level, msg); }
    public void ai(Level level, String msg)       { log(Channel.AI,       level, msg); }
    public void billing(Level level, String msg)  { log(Channel.BILLING,  level, msg); }
    public void crash(String msg)                 { log(Channel.CRASH,    Level.ERROR, msg); }
    public void system(Level level, String msg)   { log(Channel.SYSTEM,   level, msg); }

    public void log(Channel channel, Level level, String msg) {
        final String line = buildLine(channel, level, msg);
        android.util.Log.d("TermAI/" + channel.name(), msg);

        writer.submit(() -> {
            writeToFile(channel, line);
            synchronized (ringBuffer) {
                if (ringBuffer.size() >= 200) ringBuffer.pollFirst();
                ringBuffer.addLast(line);
            }
        });
    }

    // ─── File write with rotation ──────────────────
    private void writeToFile(Channel channel, String line) {
        File file = logFile(channel);
        try {
            if (file.exists() && file.length() >= MAX_FILE_BYTES) rotate(channel);
            try (FileWriter fw = new FileWriter(file, true)) {
                fw.write(line + "\n");
            }
        } catch (IOException e) {
            android.util.Log.e("TermAI/Logger", "Write error: " + e.getMessage());
        }
    }

    private void rotate(Channel channel) {
        File current = logFile(channel);
        File backup  = new File(logDir, channel.name().toLowerCase() + ".1.log");
        if (backup.exists()) backup.delete();
        current.renameTo(backup);
    }

    private File logFile(Channel channel) {
        return new File(logDir, channel.name().toLowerCase() + ".log");
    }

    private String buildLine(Channel channel, Level level, String msg) {
        return String.format("[%s] [%s] [%s] %s",
            fmt.format(new Date()), channel.name(), level.name(), msg);
    }

    // ─── JS Interface ─────────────────────────────
    @JavascriptInterface
    public String getRecentLogs(int count) {
        synchronized (ringBuffer) {
            StringBuilder sb = new StringBuilder("[");
            int skip = Math.max(0, ringBuffer.size() - count);
            int i    = 0;
            for (String line : ringBuffer) {
                if (i++ < skip) continue;
                if (sb.length() > 1) sb.append(",");
                sb.append(escapeJson(line));
            }
            return sb.append("]").toString();
        }
    }

    @JavascriptInterface
    public String readChannelLog(String channelName) {
        try {
            Channel ch   = Channel.valueOf(channelName.toUpperCase());
            File    file = logFile(ch);
            if (!file.exists()) return "\"(empty)\"";
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new FileReader(file))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line).append("\n");
            }
            return escapeJson(sb.toString());
        } catch (Exception e) {
            return escapeJson("Error: " + e.getMessage());
        }
    }

    @JavascriptInterface
    public void clearLogs() {
        writer.submit(() -> {
            for (Channel ch : Channel.values()) {
                logFile(ch).delete();
                new File(logDir, ch.name().toLowerCase() + ".1.log").delete();
            }
            synchronized (ringBuffer) { ringBuffer.clear(); }
        });
    }

    @JavascriptInterface
    public String getLogDir() { return logDir.getAbsolutePath(); }

    // ─── Helpers ──────────────────────────────────
    private static String escapeJson(String s) {
        if (s == null) return "\"\"";
        return "\"" + s.replace("\\","\\\\").replace("\"","\\\"")
                       .replace("\n","\\n").replace("\r","") + "\"";
    }

    public void shutdown() { writer.shutdown(); }
}
