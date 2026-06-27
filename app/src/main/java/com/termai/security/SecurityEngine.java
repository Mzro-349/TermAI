package com.termai.security;

import android.content.Context;
import android.webkit.JavascriptInterface;

import com.termai.log.Logger;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.regex.Pattern;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * SecurityEngine v2 — Full security pipeline.
 *
 * Features:
 * - Whitelist (always safe, no scan)
 * - Blacklist (always blocked)
 * - Pattern-based risk rules
 * - Sandbox mode (dry-run: show what would happen)
 * - Audit log (every command logged with result)
 * - Script scanning line-by-line
 */
public class SecurityEngine {

    public enum Risk { SAFE, LOW, MEDIUM, HIGH, CRITICAL }

    public static class ScanResult {
        public final Risk    risk;
        public final boolean blocked;
        public final String  reason;
        public final String  detail;

        public ScanResult(Risk risk, boolean blocked, String reason, String detail) {
            this.risk    = risk;
            this.blocked = blocked;
            this.reason  = reason;
            this.detail  = detail;
        }
        public static ScanResult safe() { return new ScanResult(Risk.SAFE,false,null,null); }
    }

    // ─── Rule ────────────────────────────────────
    private static class Rule {
        final Pattern pattern;
        final Risk    risk;
        final boolean block;
        final String  reason;
        final String  detail;
        Rule(String regex, Risk risk, boolean block, String reason, String detail) {
            this.pattern = Pattern.compile(regex, Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
            this.risk = risk; this.block = block;
            this.reason = reason; this.detail = detail;
        }
    }

    // ─── Whitelist ────────────────────────────────
    private static final Set<String> WHITELIST = new HashSet<>(Arrays.asList(
        "ls","ls -la","ls -l","pwd","echo","date","whoami","id","uname","uname -a",
        "cat","head","tail","grep","find","which","type","history","clear","exit",
        "git status","git log","git log --oneline","git diff","git branch",
        "python3 --version","node --version","npm --version","pip3 list",
        "du -sh","df -h","free -h","ps","ps aux","top","uptime","env","printenv"
    ));

    // ─── Blacklist (immediate block, no prompt) ───
    private static final List<Rule> BLACKLIST = Arrays.asList(
        new Rule(":\\(\\)\\s*\\{\\s*:|:&\\s*\\}\\s*;\\s*:", Risk.CRITICAL, true,
            "Fork Bomb", "Will freeze device by spawning infinite processes."),
        new Rule("mkfs\\.", Risk.CRITICAL, true,
            "Disk Format", "Formatting storage is permanently destructive."),
        new Rule("dd\\s+.*of=/dev/", Risk.CRITICAL, true,
            "Raw Disk Write", "Writing to block devices can corrupt all data."),
        new Rule("rm\\s+(-[rRf]+\\s+)*/?\\*\\s*$", Risk.CRITICAL, true,
            "Wildcard Delete", "Deleting all files in current directory."),
        new Rule("(nc|netcat)\\s+.*-e\\s+.*(sh|bash)", Risk.CRITICAL, true,
            "Backdoor Shell", "Netcat with -e creates a remote shell — not permitted.")
    );

    // ─── Risk rules (warn, require approval) ─────
    private static final List<Rule> RULES = Arrays.asList(
        new Rule("rm\\s+(-[rRf]+\\s+)*~", Risk.HIGH, false,
            "Delete Home Directory", "Recursively deletes your home folder and all contents."),
        new Rule("rm\\s+(-[rRf]+\\s+)*/data", Risk.HIGH, false,
            "Delete Data Directory", "Deleting /data can break the app permanently."),
        new Rule("curl[^|]*\\|\\s*(ba?sh|sh|zsh)", Risk.HIGH, false,
            "Remote Script Pipe", "Piping remote URL directly to shell without review."),
        new Rule("wget[^|]*-O\\s*-[^|]*\\|\\s*(ba?sh|sh)", Risk.HIGH, false,
            "Remote Script Pipe", "Downloading and piping to shell without reviewing content."),
        new Rule("chmod\\s+(-R\\s+)?777", Risk.HIGH, false,
            "World-Writable Permissions", "Files accessible to all users — security risk."),
        new Rule("/etc/(passwd|shadow|sudoers)", Risk.HIGH, false,
            "System File Access", "Accessing sensitive authentication files."),
        new Rule("passwd\\s*(root)?\\s*$", Risk.HIGH, false,
            "Password Change", "Changing root or user password."),
        new Rule("sudo\\s+(su|bash|sh)\\s*$", Risk.MEDIUM, false,
            "Root Shell", "Escalating to a full root shell session."),
        new Rule("(curl|wget)\\s+https?://", Risk.LOW, false,
            "Network Download", "Downloading content from the internet.")
    );

    // ─── State ────────────────────────────────────
    private final Logger          logger;
    private final File            auditFile;
    private final ExecutorService auditWriter = Executors.newSingleThreadExecutor();
    private final SimpleDateFormat auditFmt   = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US);
    private       boolean         sandboxMode = false;
    private       long            totalScans  = 0;
    private       long            totalBlocks = 0;

    public SecurityEngine(Context context, Logger logger) {
        this.logger    = logger;
        this.auditFile = new File(context.getFilesDir(), "logs/security_audit.log");
        this.auditFile.getParentFile().mkdirs();
    }

    // ─── Main scan ────────────────────────────────
    public ScanResult scan(String command) {
        if (command == null || command.isBlank()) return ScanResult.safe();
        totalScans++;
        String cmd = command.trim();

        // 1. Whitelist check (skip all scanning)
        if (WHITELIST.contains(cmd) || WHITELIST.contains(cmd.split("\\s+")[0])) {
            auditLog(cmd, Risk.SAFE, "WHITELIST", false);
            return ScanResult.safe();
        }

        // 2. Blacklist check (always block)
        for (Rule rule : BLACKLIST) {
            if (rule.pattern.matcher(cmd).find()) {
                totalBlocks++;
                auditLog(cmd, rule.risk, rule.reason, true);
                logger.security(Logger.Level.WARN, "BLOCKED [" + rule.reason + "]: " + cmd);
                return new ScanResult(rule.risk, true, rule.reason, rule.detail);
            }
        }

        // 3. Risk rule check
        for (Rule rule : RULES) {
            if (rule.pattern.matcher(cmd).find()) {
                auditLog(cmd, rule.risk, rule.reason, false);
                logger.security(Logger.Level.INFO, "FLAGGED [" + rule.risk + " / " + rule.reason + "]: " + cmd);
                return new ScanResult(rule.risk, false, rule.reason, rule.detail);
            }
        }

        auditLog(cmd, Risk.SAFE, null, false);
        return ScanResult.safe();
    }

    // ─── Script scan ──────────────────────────────
    public ScanResult scanScript(String scriptContent) {
        if (scriptContent == null) return ScanResult.safe();
        String[] lines = scriptContent.split("\n");
        for (String line : lines) {
            String t = line.trim();
            if (t.isEmpty() || t.startsWith("#")) continue;
            ScanResult r = scan(t);
            if (r.risk != Risk.SAFE && r.risk != Risk.LOW) {
                return new ScanResult(r.risk, r.blocked,
                    "Script contains: " + r.reason, r.detail);
            }
        }
        return ScanResult.safe();
    }

    // ─── Sandbox mode ────────────────────────────
    /**
     * Sandbox/Dry-run: describe what a command would do without executing it.
     * Returns a human-readable explanation for the approval UI.
     */
    public String sandboxDescribe(String command) {
        if (!sandboxMode) return null;
        // Basic dry-run descriptions
        String cmd = command.trim();
        if (cmd.startsWith("rm "))      return "Would DELETE: " + cmd.replace("rm ","");
        if (cmd.startsWith("mkdir "))   return "Would CREATE directory: " + cmd.replace("mkdir ","");
        if (cmd.startsWith("mv "))      return "Would MOVE: " + cmd.replace("mv ","");
        if (cmd.startsWith("cp "))      return "Would COPY: " + cmd.replace("cp ","");
        if (cmd.startsWith("chmod "))   return "Would CHANGE PERMISSIONS: " + cmd.replace("chmod ","");
        if (cmd.startsWith("curl ") || cmd.startsWith("wget "))
                                        return "Would DOWNLOAD from internet";
        if (cmd.startsWith("apt ") || cmd.startsWith("pkg "))
                                        return "Would INSTALL packages: " + cmd;
        if (cmd.startsWith("git commit")) return "Would COMMIT to git repository";
        if (cmd.startsWith("git push"))   return "Would PUSH to remote git repository";
        return "Would EXECUTE: " + cmd;
    }

    public void setSandboxMode(boolean enabled) {
        this.sandboxMode = enabled;
        logger.security(Logger.Level.INFO, "Sandbox mode: " + (enabled ? "ON" : "OFF"));
    }
    public boolean isSandboxMode() { return sandboxMode; }

    // ─── Audit log ────────────────────────────────
    private void auditLog(String command, Risk risk, String reason, boolean blocked) {
        auditWriter.submit(() -> {
            try (FileWriter fw = new FileWriter(auditFile, true)) {
                String line = String.format("[%s] [%s] [%s] %s%s",
                    auditFmt.format(new Date()),
                    risk.name(),
                    blocked ? "BLOCKED" : "ALLOWED",
                    command,
                    reason != null ? " | " + reason : "");
                fw.write(line + "\n");
            } catch (IOException ignored) {}
        });
    }

    // ─── JS Interface ─────────────────────────────
    @JavascriptInterface
    public String securityScan(String command) {
        return toJson(scan(command));
    }

    @JavascriptInterface
    public String securityScanScript(String script) {
        return toJson(scanScript(script));
    }

    @JavascriptInterface
    public String getSandboxDescription(String command) {
        String desc = sandboxDescribe(command);
        try {
            return new JSONObject()
                .put("sandbox", sandboxMode)
                .put("description", desc != null ? desc : "")
                .toString();
        } catch (Exception e) { return "{}"; }
    }

    @JavascriptInterface
    public void setSandbox(boolean enabled) { setSandboxMode(enabled); }

    @JavascriptInterface
    public String getStats() {
        try {
            return new JSONObject()
                .put("totalScans",  totalScans)
                .put("totalBlocks", totalBlocks)
                .put("sandboxMode", sandboxMode)
                .toString();
        } catch (Exception e) { return "{}"; }
    }

    // ─── JSON output ──────────────────────────────
    public static String toJson(ScanResult r) {
        if (r.risk == Risk.SAFE) return "{\"safe\":true}";
        try {
            return new JSONObject()
                .put("safe",    !r.blocked)
                .put("blocked", r.blocked)
                .put("risk",    r.risk.name())
                .put("reason",  r.reason)
                .put("detail",  r.detail)
                .toString();
        } catch (Exception e) { return "{\"safe\":true}"; }
    }

    public void shutdown() { auditWriter.shutdown(); }
}
