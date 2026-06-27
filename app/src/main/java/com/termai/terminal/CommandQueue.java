package com.termai.terminal;

import com.termai.log.Logger;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/**
 * CommandQueue — Ordered command execution with control and observability.
 *
 * Features:
 * - Queue multiple commands (e.g. from AI plan)
 * - Cancel current or entire queue
 * - Per-command timeout
 * - Status tracking per command (PENDING / RUNNING / DONE / FAILED / CANCELLED)
 * - Pause/resume queue
 * - Continue-on-error or stop-on-error mode
 */
public class CommandQueue {

    public enum Status { PENDING, RUNNING, DONE, FAILED, CANCELLED }

    public static class QueuedCommand {
        public final String id;
        public final String command;
        public final String description;
        public final long   timeoutMs;
        public final boolean stopOnFail;

        public volatile Status status   = Status.PENDING;
        public volatile int    exitCode = -1;
        public volatile String output   = "";

        public QueuedCommand(String id, String command, String description,
                             long timeoutMs, boolean stopOnFail) {
            this.id          = id;
            this.command     = command;
            this.description = description;
            this.timeoutMs   = timeoutMs > 0 ? timeoutMs : 30_000;
            this.stopOnFail  = stopOnFail;
        }

        public JSONObject toJson() {
            try {
                return new JSONObject()
                    .put("id",          id)
                    .put("command",     command)
                    .put("description", description)
                    .put("status",      status.name())
                    .put("exitCode",    exitCode)
                    .put("output",      output.length() > 500
                        ? output.substring(0, 500) + "…" : output);
            } catch (Exception e) { return new JSONObject(); }
        }
    }

    // ─── Listener ─────────────────────────────────
    public interface QueueListener {
        void onCommandStart(QueuedCommand cmd);
        void onCommandDone(QueuedCommand cmd);
        void onQueueDone(List<QueuedCommand> results);
        void onQueueCancelled();
    }

    // ─── State ────────────────────────────────────
    private final Deque<QueuedCommand>  queue    = new ArrayDeque<>();
    private final List<QueuedCommand>   history  = new ArrayList<>();
    private final ShellEngine           shell;
    private final Logger                logger;
    private       QueueListener         listener;

    private volatile boolean running    = false;
    private volatile boolean paused     = false;
    private volatile boolean cancelled  = false;
    private final    Object  pauseLock  = new Object();

    public CommandQueue(ShellEngine shell, Logger logger) {
        this.shell  = shell;
        this.logger = logger;
    }

    public void setListener(QueueListener l) { this.listener = l; }

    // ─── Enqueue ──────────────────────────────────
    public synchronized void enqueue(String id, String command, String description,
                                     long timeoutMs, boolean stopOnFail) {
        queue.add(new QueuedCommand(id, command, description, timeoutMs, stopOnFail));
    }

    public synchronized void enqueueFromPlan(JSONArray steps) throws Exception {
        for (int i = 0; i < steps.length(); i++) {
            JSONObject step = steps.getJSONObject(i);
            enqueue(
                "step_" + step.optInt("id", i),
                step.optString("command", "echo ''"),
                step.optString("description", "Step " + (i+1)),
                30_000,
                step.optBoolean("critical", true)
            );
        }
    }

    // ─── Execute queue ────────────────────────────
    public void execute() {
        if (running) return;
        running   = true;
        cancelled = false;

        new Thread(() -> {
            List<QueuedCommand> results = new ArrayList<>();

            while (!queue.isEmpty() && !cancelled) {
                // Pause support
                synchronized (pauseLock) {
                    while (paused && !cancelled) {
                        try { pauseLock.wait(); }
                        catch (InterruptedException e) { break; }
                    }
                }
                if (cancelled) break;

                QueuedCommand cmd = queue.poll();
                if (cmd == null) break;

                cmd.status = Status.RUNNING;
                if (listener != null) listener.onCommandStart(cmd);
                logger.terminal(Logger.Level.INFO, "Queue: running → " + cmd.command);

                // Execute with timeout
                CountDownLatch latch = new CountDownLatch(1);
                StringBuilder  out   = new StringBuilder();

                shell.execute(cmd.command, new ShellEngine.OutputCallback() {
                    @Override public void onChunk(String chunk) { out.append(chunk); }
                    @Override public void onDone(int exitCode, String cwd) {
                        cmd.exitCode = exitCode;
                        cmd.output   = out.toString();
                        cmd.status   = exitCode == 0 ? Status.DONE : Status.FAILED;
                        latch.countDown();
                    }
                    @Override public void onShellDied() {
                        cmd.exitCode = 1;
                        cmd.status   = Status.FAILED;
                        cmd.output   = "Shell process died";
                        latch.countDown();
                    }
                });

                try {
                    boolean finished = latch.await(cmd.timeoutMs, TimeUnit.MILLISECONDS);
                    if (!finished) {
                        shell.interrupt();
                        cmd.status   = Status.FAILED;
                        cmd.output   += "\n[Timeout after " + (cmd.timeoutMs/1000) + "s]";
                    }
                } catch (InterruptedException e) {
                    cmd.status = Status.CANCELLED;
                }

                results.add(cmd);
                history.add(cmd);

                if (listener != null) listener.onCommandDone(cmd);

                logger.terminal(Logger.Level.INFO,
                    "Queue: done [" + cmd.status + "] → " + cmd.command);

                // Stop queue if critical step failed
                if (cmd.status == Status.FAILED && cmd.stopOnFail) {
                    logger.terminal(Logger.Level.WARN,
                        "Queue halted: critical step failed → " + cmd.command);
                    break;
                }
            }

            running = false;

            // Cancel remaining if not finished naturally
            if (cancelled) {
                for (QueuedCommand remaining : queue) remaining.status = Status.CANCELLED;
                queue.clear();
                if (listener != null) listener.onQueueCancelled();
            } else {
                if (listener != null) listener.onQueueDone(results);
            }

        }, "TermAI-Queue").start();
    }

    // ─── Control ──────────────────────────────────
    public void cancel() {
        cancelled = true;
        shell.interrupt();
        synchronized (pauseLock) { pauseLock.notifyAll(); }
    }

    public void pause() {
        paused = true;
        logger.terminal(Logger.Level.INFO, "Queue paused");
    }

    public void resume() {
        paused = false;
        synchronized (pauseLock) { pauseLock.notifyAll(); }
        logger.terminal(Logger.Level.INFO, "Queue resumed");
    }

    public void clear() {
        queue.clear();
        cancelled = false;
    }

    // ─── Status ───────────────────────────────────
    public JSONObject getStatus() {
        try {
            JSONArray pending  = new JSONArray();
            JSONArray hist     = new JSONArray();
            for (QueuedCommand c : queue)   pending.put(c.toJson());
            for (QueuedCommand c : history) hist.put(c.toJson());
            return new JSONObject()
                .put("running",  running)
                .put("paused",   paused)
                .put("pending",  pending)
                .put("history",  hist)
                .put("queueSize", queue.size());
        } catch (Exception e) { return new JSONObject(); }
    }

    public boolean isRunning() { return running; }
    public int     queueSize() { return queue.size(); }
}
