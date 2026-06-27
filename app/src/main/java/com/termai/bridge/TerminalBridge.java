package com.termai.bridge;

import android.content.Context;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.termai.log.Logger;
import com.termai.plugin.PluginManager;
import com.termai.security.SecurityEngine;
import com.termai.terminal.CommandQueue;
import com.termai.terminal.ShellEngine;
import com.termai.util.JsCallback;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * TerminalBridge v2 — JS ↔ Android bridge. Bridge ONLY.
 *
 * Wires together: ShellEngine + SecurityEngine + CommandQueue + PluginManager
 * No business logic here — delegates everything.
 */
public class TerminalBridge {

    private final Context         context;
    private final ShellEngine     shell;
    private final SecurityEngine  security;
    private final CommandQueue    queue;
    private final PluginManager   plugins;
    private final JsCallback      jsCallback;
    private final Logger          logger;

    public TerminalBridge(Context context, WebView webView, String homeDir,
                          SecurityEngine security, PluginManager plugins, Logger logger) {
        this.context    = context;
        this.security   = security;
        this.plugins    = plugins;
        this.logger     = logger;
        this.jsCallback = new JsCallback(webView);
        this.shell      = new ShellEngine(homeDir);
        this.queue      = new CommandQueue(shell, logger);

        try { shell.start(); }
        catch (Exception e) { logger.terminal(Logger.Level.ERROR, "Shell start failed: " + e.getMessage()); }
    }

    // ─── Single command ───────────────────────────
    @JavascriptInterface
    public void executeCommand(String command, String sessionId, String callbackId) {
        // Plugin routing first
        String routed = plugins.routeCommand(command);
        String finalCmd = routed != null ? routed : command;

        logger.terminal(Logger.Level.INFO, "Execute: " + finalCmd);

        shell.execute(finalCmd, new ShellEngine.OutputCallback() {
            @Override public void onChunk(String chunk) { jsCallback.streamChunk(sessionId, chunk); }
            @Override public void onDone(int exitCode, String cwd) {
                logger.terminal(exitCode == 0 ? Logger.Level.INFO : Logger.Level.WARN,
                    "Done [" + exitCode + "]: " + finalCmd);
                jsCallback.resolve(callbackId, JsCallback.buildDonePayload(exitCode, cwd));
            }
            @Override public void onShellDied() {
                logger.terminal(Logger.Level.ERROR, "Shell died during: " + finalCmd);
                jsCallback.resolve(callbackId, "{\"exitCode\":1,\"cwd\":\"~\",\"error\":\"Shell died\"}");
            }
        });
    }

    // ─── Queue (AI plan execution) ────────────────
    @JavascriptInterface
    public void executeQueue(String stepsJson, String sessionId, String callbackId) {
        try {
            queue.clear();
            queue.enqueueFromPlan(new JSONArray(stepsJson));

            queue.setListener(new CommandQueue.QueueListener() {
                @Override public void onCommandStart(CommandQueue.QueuedCommand cmd) {
                    jsCallback.eval("window.onQueueStep&&window.onQueueStep(" + cmd.toJson() + ")");
                }
                @Override public void onCommandDone(CommandQueue.QueuedCommand cmd) {
                    jsCallback.streamChunk(sessionId, cmd.output);
                }
                @Override public void onQueueDone(java.util.List<CommandQueue.QueuedCommand> results) {
                    try {
                        JSONArray arr = new JSONArray();
                        for (CommandQueue.QueuedCommand c : results) arr.put(c.toJson());
                        jsCallback.resolve(callbackId, "{\"ok\":true,\"results\":" + arr + "}");
                    } catch (Exception e) {
                        jsCallback.resolve(callbackId, "{\"ok\":false}");
                    }
                }
                @Override public void onQueueCancelled() {
                    jsCallback.resolve(callbackId, "{\"ok\":false,\"cancelled\":true}");
                }
            });

            queue.execute();

        } catch (Exception e) {
            logger.terminal(Logger.Level.ERROR, "Queue error: " + e.getMessage());
            jsCallback.resolve(callbackId, "{\"ok\":false,\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    @JavascriptInterface public void cancelQueue()  { queue.cancel(); }
    @JavascriptInterface public void pauseQueue()   { queue.pause();  }
    @JavascriptInterface public void resumeQueue()  { queue.resume(); }
    @JavascriptInterface public String queueStatus(){ return queue.getStatus().toString(); }

    // ─── Security ─────────────────────────────────
    @JavascriptInterface public String securityScan(String cmd)   { return SecurityEngine.toJson(security.scan(cmd)); }
    @JavascriptInterface public String securityScanScript(String s){ return SecurityEngine.toJson(security.scanScript(s)); }
    @JavascriptInterface public String sandboxDescribe(String cmd) {
        String d = security.sandboxDescribe(cmd);
        return "{\"description\":" + JSONObject.quote(d != null ? d : "") + ",\"sandbox\":" + security.isSandboxMode() + "}";
    }

    // ─── Plugins ──────────────────────────────────
    @JavascriptInterface public String listPlugins()       { return plugins.listPlugins(); }
    @JavascriptInterface public String getAITools()        { return plugins.getAIToolsContext(); }
    @JavascriptInterface public String routePlugin(String cmd) { return plugins.routeCommandJS(cmd); }

    // ─── Shell control ────────────────────────────
    @JavascriptInterface public void interrupt()              { shell.interrupt(); }
    @JavascriptInterface public void writeStdin(String data)  { shell.writeStdin(data); }
    @JavascriptInterface public String getCwd()               { return shell.getCwd(); }
    @JavascriptInterface public boolean isShellAlive()        { return shell.isAlive(); }

    // ─── Clipboard ────────────────────────────────
    @JavascriptInterface
    public void copyToClipboard(String text) {
        ClipboardManager cm = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(ClipData.newPlainText("TermAI", text));
    }
    @JavascriptInterface
    public String pasteFromClipboard() {
        ClipboardManager cm = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm.hasPrimaryClip() && cm.getPrimaryClip() != null) {
            ClipData.Item i = cm.getPrimaryClip().getItemAt(0);
            return i != null && i.getText() != null ? i.getText().toString() : "";
        }
        return "";
    }

    public void destroy() { shell.destroy(); }
}
