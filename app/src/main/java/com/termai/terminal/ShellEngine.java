package com.termai.terminal;

import android.os.Handler;
import android.os.Looper;

import java.io.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/**
 * ShellEngine — Persistent shell with async streaming I/O.
 *
 * Design principles:
 * - Single persistent shell process (no spawn per command)
 * - Non-blocking output: two permanent reader threads (stdout + stderr)
 * - Commands tracked by unique end-markers — no race conditions
 * - Streaming: output chunks sent to JS as they arrive
 * - No duplicate escaping — raw output passed to callback
 * - Proper cleanup on destroy()
 */
public class ShellEngine {

    // ─── Callback interface ───────────────────────
    public interface OutputCallback {
        /** Called for each chunk of output while command is running */
        void onChunk(String chunk);
        /** Called once when command finishes */
        void onDone(int exitCode, String cwd);
        /** Called if the shell process dies unexpectedly */
        void onShellDied();
    }

    // ─── Constants ────────────────────────────────
    private static final String MARKER_PREFIX = "__TRM_DONE_";
    private static final int    THREAD_POOL   = 2;
    private static final long   CMD_TIMEOUT_MS = 30_000L;

    // ─── State ────────────────────────────────────
    private final String          homeDir;
    private       Process         process;
    private       PrintWriter     stdin;
    private       BufferedReader  stdoutReader;
    private       BufferedReader  stderrReader;

    private final ExecutorService  executor = Executors.newFixedThreadPool(THREAD_POOL);
    private       Thread           stdoutThread;
    private       Thread           stderrThread;

    // Current command context (atomic for thread safety)
    private final AtomicReference<String>         currentMarkerId    = new AtomicReference<>(null);
    private final AtomicReference<OutputCallback> currentCallback    = new AtomicReference<>(null);
    private final AtomicReference<String>         currentCwd         = new AtomicReference<>("~");
    private final AtomicLong                      commandStartTime   = new AtomicLong(0);

    private volatile boolean alive = false;

    public ShellEngine(String homeDir) {
        this.homeDir = homeDir;
    }

    // ─── Start ────────────────────────────────────
    public synchronized void start() throws IOException {
        if (alive) return;

        new File(homeDir).mkdirs();

        ProcessBuilder pb = new ProcessBuilder("sh")
            .redirectErrorStream(false);

        pb.environment().put("HOME",    homeDir);
        pb.environment().put("TERM",    "xterm-256color");
        pb.environment().put("LANG",    "en_US.UTF-8");
        pb.environment().put("PS1",     ""); // suppress prompt — we manage it in JS
        pb.environment().put("PATH",
            ""
            + ""
            + "/system/bin:/system/xbin");
        pb.environment().put("TMPDIR",  "/data/local/tmp");
        pb.environment().put("PREFIX",  "/data/data/com.termai/files/usr");
        pb.directory(new File(homeDir));

        process = pb.start();
        stdin   = new PrintWriter(new BufferedWriter(
                    new OutputStreamWriter(process.getOutputStream(), "UTF-8")), true);

        stdoutReader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), "UTF-8"), 8192);
        stderrReader = new BufferedReader(
                new InputStreamReader(process.getErrorStream(), "UTF-8"), 4096);

        alive = true;
        currentCwd.set(homeDir);

        startStdoutReader();
        startStderrReader();
    }

    // ─── Execute Command ─────────────────────────
    /**
     * Execute a command asynchronously.
     * Output is streamed to callback.onChunk() as it arrives.
     * When done, callback.onDone() is called with exit code + new cwd.
     */
    public void execute(String command, OutputCallback callback) {
        if (!alive || process == null || !process.isAlive()) {
            try { start(); Thread.sleep(200); }
            catch (Exception e) { callback.onDone(1, currentCwd.get()); return; }
        }

        final String markerId = MARKER_PREFIX + System.nanoTime();
        currentMarkerId.set(markerId);
        currentCallback.set(callback);
        commandStartTime.set(System.currentTimeMillis());

        // Schedule timeout
        executor.submit(() -> {
            try {
                Thread.sleep(CMD_TIMEOUT_MS);
                // If same marker still active after timeout
                if (markerId.equals(currentMarkerId.get())) {
                    OutputCallback cb = currentCallback.getAndSet(null);
                    currentMarkerId.set(null);
                    if (cb != null) {
                        cb.onChunk("\r\n\u001b[33m[TermAI: command timed out after 30s]\u001b[0m\r\n");
                        cb.onDone(124, currentCwd.get());
                    }
                }
            } catch (InterruptedException ignored) {}
        });

        // Write command + capture exit code + new cwd
        String wrapped =
            command + "\n" +
            "echo \"" + markerId + "$?\"\n" +
            "pwd\n" +
            "echo \"" + markerId + "PWD\"\n";

        stdin.print(wrapped);
        stdin.flush();
    }

    // ─── Persistent stdout reader thread ─────────
    private void startStdoutReader() {
        stdoutThread = new Thread(() -> {
            String line;
            String capturedExitLine = null;

            try {
                while (alive && (line = stdoutReader.readLine()) != null) {
                    final String ln = line;
                    String markerId = currentMarkerId.get();
                    OutputCallback cb = currentCallback.get();

                    if (markerId != null && ln.startsWith(markerId)) {
                        if (capturedExitLine == null) {
                            // First marker: contains exit code
                            capturedExitLine = ln;
                        } else {
                            // Second marker (PWD): command done
                            // But we need the line BETWEEN these two markers for pwd
                            // Actually pwd is printed before the second marker
                            // so at this point we have the exit code already
                        }

                        if (ln.equals(markerId + "PWD")) {
                            // Command complete
                            int exitCode = 0;
                            if (capturedExitLine != null) {
                                String codeStr = capturedExitLine.substring(markerId.length());
                                try { exitCode = Integer.parseInt(codeStr.trim()); }
                                catch (NumberFormatException ignored) {}
                            }
                            capturedExitLine = null;
                            currentMarkerId.set(null);

                            final int  finalCode = exitCode;
                            final String finalCwd = currentCwd.get();
                            final OutputCallback finalCb = currentCallback.getAndSet(null);
                            if (finalCb != null) {
                                finalCb.onDone(finalCode, finalCwd);
                            }
                        }
                        // Don't send marker lines to output
                        continue;
                    }

                    // Check if this line is a pwd line (comes between exit marker and PWD marker)
                    if (capturedExitLine != null && ln.startsWith("/")) {
                        // Likely a path — update cwd
                        currentCwd.set(ln.trim());
                        continue;
                    }

                    // Regular output — stream to callback
                    if (cb != null) {
                        cb.onChunk(ln + "\r\n");
                    }
                }
            } catch (IOException ignored) {}

            // Shell died
            alive = false;
            OutputCallback cb = currentCallback.getAndSet(null);
            if (cb != null) cb.onShellDied();
        }, "TermAI-stdout");

        stdoutThread.setDaemon(true);
        stdoutThread.start();
    }

    // ─── Persistent stderr reader thread ─────────
    private void startStderrReader() {
        stderrThread = new Thread(() -> {
            String line;
            try {
                while (alive && (line = stderrReader.readLine()) != null) {
                    final String ln = line;
                    OutputCallback cb = currentCallback.get();
                    if (cb != null) {
                        cb.onChunk("\u001b[31m" + ln + "\u001b[0m\r\n");
                    }
                }
            } catch (IOException ignored) {}
        }, "TermAI-stderr");

        stderrThread.setDaemon(true);
        stderrThread.start();
    }

    // ─── Write raw stdin (Ctrl+C etc) ────────────
    public void writeStdin(String data) {
        if (stdin != null) {
            stdin.print(data);
            stdin.flush();
        }
    }

    // ─── Send interrupt ───────────────────────────
    public void interrupt() {
        writeStdin("\u0003"); // Ctrl+C
        // Clear current callback gracefully
        currentMarkerId.set(null);
        OutputCallback cb = currentCallback.getAndSet(null);
        if (cb != null) cb.onDone(130, currentCwd.get());
    }

    // ─── Getters ──────────────────────────────────
    public String getCwd()   { return currentCwd.get(); }
    public boolean isAlive() { return alive && process != null && process.isAlive(); }

    // ─── Cleanup ──────────────────────────────────
    public void destroy() {
        alive = false;
        currentMarkerId.set(null);
        currentCallback.set(null);

        try { if (stdin != null) stdin.close(); } catch (Exception ignored) {}
        if (stdoutThread != null) stdoutThread.interrupt();
        if (stderrThread != null) stderrThread.interrupt();
        if (process != null) process.destroyForcibly();
        executor.shutdownNow();
    }
}
