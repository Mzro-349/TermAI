package com.termai.plugin;

import org.json.JSONObject;

/**
 * TermAIPlugin — Interface all plugins must implement.
 *
 * Plugins can:
 * - Add custom terminal commands (!git, !python, etc.)
 * - Add AI tools (functions the AI can call)
 * - Add UI components (JS side)
 * - Hook into the command execution pipeline
 *
 * Current built-in plugins: GitPlugin, PythonPlugin, NodePlugin, SSHPlugin.
 * Users can add custom plugins in the future.
 */
public interface TermAIPlugin {

    /** Unique plugin ID, e.g. "git", "python", "ssh" */
    String getId();

    /** Human-readable name */
    String getName();

    /** Plugin version */
    String getVersion();

    /** Called once when plugin is registered */
    void onRegister();

    /** Called when plugin is unregistered */
    void onUnregister();

    /**
     * Handle a custom command starting with this plugin's prefix.
     * e.g. GitPlugin handles "!git status" → returns shell command to run
     * Returns null if this plugin doesn't handle the command.
     */
    String handleCommand(String command);

    /**
     * Provide AI tool description for this plugin.
     * Returned JSON is included in AI context so AI knows this plugin exists.
     */
    JSONObject getAIToolDescription();

    /** Whether this plugin requires Premium */
    boolean requiresPremium();
}
