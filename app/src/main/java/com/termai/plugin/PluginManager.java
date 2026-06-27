package com.termai.plugin;

import android.webkit.JavascriptInterface;

import com.termai.log.Logger;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PluginManager — Plugin registry and lifecycle management.
 *
 * Architecture allows future plugins without touching core code.
 * Plugins are registered at startup; more can be added at runtime.
 * JS can query available plugins and their capabilities.
 */
public class PluginManager {

    private final Map<String, TermAIPlugin> plugins = new ConcurrentHashMap<>();
    private final Logger                    logger;
    private       boolean                   premiumActive = false;

    public PluginManager(Logger logger) {
        this.logger = logger;
        registerBuiltins();
    }

    // ─── Register built-in plugins ────────────────
    private void registerBuiltins() {
        register(new GitPlugin());
        register(new PythonPlugin());
        register(new NodePlugin());
        register(new SSHPlugin());
    }

    // ─── Plugin lifecycle ─────────────────────────
    public void register(TermAIPlugin plugin) {
        plugins.put(plugin.getId(), plugin);
        plugin.onRegister();
        logger.system(Logger.Level.INFO, "Plugin registered: " + plugin.getName());
    }

    public void unregister(String id) {
        TermAIPlugin p = plugins.remove(id);
        if (p != null) {
            p.onUnregister();
            logger.system(Logger.Level.INFO, "Plugin unregistered: " + p.getName());
        }
    }

    public void setPremiumActive(boolean active) { this.premiumActive = active; }

    // ─── Command routing ──────────────────────────
    /**
     * Try all plugins for this command.
     * Returns shell command if a plugin handles it, null otherwise.
     */
    public String routeCommand(String command) {
        for (TermAIPlugin plugin : plugins.values()) {
            if (plugin.requiresPremium() && !premiumActive) continue;
            String result = plugin.handleCommand(command);
            if (result != null) {
                logger.system(Logger.Level.INFO,
                    "Plugin [" + plugin.getId() + "] handled: " + command);
                return result;
            }
        }
        return null;
    }

    // ─── JS Interface ─────────────────────────────
    @JavascriptInterface
    public String listPlugins() {
        try {
            JSONArray arr = new JSONArray();
            for (TermAIPlugin p : plugins.values()) {
                arr.put(new JSONObject()
                    .put("id",             p.getId())
                    .put("name",           p.getName())
                    .put("version",        p.getVersion())
                    .put("requiresPremium",p.requiresPremium())
                    .put("available",      !p.requiresPremium() || premiumActive));
            }
            return new JSONObject().put("ok",true).put("plugins",arr).toString();
        } catch (Exception e) {
            return "{\"ok\":false}";
        }
    }

    @JavascriptInterface
    public String getAIToolsContext() {
        // Returns all plugin tool descriptions for AI context
        try {
            JSONArray tools = new JSONArray();
            for (TermAIPlugin p : plugins.values()) {
                if (!p.requiresPremium() || premiumActive) {
                    JSONObject desc = p.getAIToolDescription();
                    if (desc != null) tools.put(desc);
                }
            }
            return tools.toString();
        } catch (Exception e) { return "[]"; }
    }

    @JavascriptInterface
    public String routeCommandJS(String command) {
        String result = routeCommand(command);
        try {
            return new JSONObject()
                .put("handled", result != null)
                .put("command", result != null ? result : command)
                .toString();
        } catch (Exception e) { return "{\"handled\":false}"; }
    }

    // ═══════════════════════════════════════════════
    // Built-in Plugin Implementations
    // ═══════════════════════════════════════════════

    static class GitPlugin implements TermAIPlugin {
        @Override public String getId()      { return "git"; }
        @Override public String getName()    { return "Git Plugin"; }
        @Override public String getVersion() { return "1.0"; }
        @Override public void onRegister()   {}
        @Override public void onUnregister() {}
        @Override public boolean requiresPremium() { return false; }

        @Override
        public String handleCommand(String cmd) {
            if (!cmd.startsWith("!git ")) return null;
            String args = cmd.substring(5).trim();
            // Safety: block destructive git operations
            if (args.startsWith("push --force") || args.startsWith("reset --hard HEAD~")) {
                return "echo '[TermAI] Destructive git operation requires manual confirmation'";
            }
            return "git " + args;
        }

        @Override
        public JSONObject getAIToolDescription() {
            try {
                return new JSONObject()
                    .put("plugin", "git")
                    .put("prefix", "!git")
                    .put("description", "Git version control commands")
                    .put("examples", new JSONArray()
                        .put("!git status").put("!git log --oneline").put("!git diff"));
            } catch (Exception e) { return null; }
        }
    }

    static class PythonPlugin implements TermAIPlugin {
        @Override public String getId()      { return "python"; }
        @Override public String getName()    { return "Python Plugin"; }
        @Override public String getVersion() { return "1.0"; }
        @Override public void onRegister()   {}
        @Override public void onUnregister() {}
        @Override public boolean requiresPremium() { return false; }

        @Override
        public String handleCommand(String cmd) {
            if (cmd.equals("!python")) return "python3 --version && echo 'Python ready'";
            if (cmd.startsWith("!pip ")) return "pip3 " + cmd.substring(5);
            if (cmd.startsWith("!py "))  return "python3 -c \"" + cmd.substring(4).replace("\"","\\\"") + "\"";
            return null;
        }

        @Override
        public JSONObject getAIToolDescription() {
            try {
                return new JSONObject()
                    .put("plugin", "python")
                    .put("prefix", "!py / !pip")
                    .put("description", "Python 3 execution and package management")
                    .put("examples", new JSONArray()
                        .put("!py print('hello')").put("!pip install requests"));
            } catch (Exception e) { return null; }
        }
    }

    static class NodePlugin implements TermAIPlugin {
        @Override public String getId()      { return "node"; }
        @Override public String getName()    { return "Node.js Plugin"; }
        @Override public String getVersion() { return "1.0"; }
        @Override public void onRegister()   {}
        @Override public void onUnregister() {}
        @Override public boolean requiresPremium() { return false; }

        @Override
        public String handleCommand(String cmd) {
            if (cmd.equals("!node"))    return "node --version && echo 'Node ready'";
            if (cmd.startsWith("!npm ")) return "npm " + cmd.substring(5);
            if (cmd.startsWith("!node ")) return "node " + cmd.substring(6);
            return null;
        }

        @Override
        public JSONObject getAIToolDescription() {
            try {
                return new JSONObject()
                    .put("plugin", "node")
                    .put("prefix", "!node / !npm")
                    .put("description", "Node.js execution and npm package management")
                    .put("examples", new JSONArray()
                        .put("!npm install").put("!node index.js"));
            } catch (Exception e) { return null; }
        }
    }

    static class SSHPlugin implements TermAIPlugin {
        @Override public String getId()      { return "ssh"; }
        @Override public String getName()    { return "SSH Plugin"; }
        @Override public String getVersion() { return "1.0"; }
        @Override public void onRegister()   {}
        @Override public void onUnregister() {}
        @Override public boolean requiresPremium() { return true; }

        @Override
        public String handleCommand(String cmd) {
            if (cmd.startsWith("!ssh ")) return "ssh " + cmd.substring(5);
            if (cmd.startsWith("!scp ")) return "scp " + cmd.substring(5);
            return null;
        }

        @Override
        public JSONObject getAIToolDescription() {
            try {
                return new JSONObject()
                    .put("plugin",      "ssh")
                    .put("prefix",      "!ssh / !scp")
                    .put("description", "SSH remote connections and SCP file transfer (Premium)")
                    .put("premium",     true);
            } catch (Exception e) { return null; }
        }
    }
}
