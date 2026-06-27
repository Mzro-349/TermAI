package com.termai.project;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;

import com.termai.log.Logger;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.*;
import java.util.*;

/**
 * ProjectManager — Workspace and project lifecycle management.
 *
 * Responsibilities:
 * - Create / open / close / delete projects
 * - Session persistence (restore last open project on restart)
 * - Project metadata (name, type, last opened, git status)
 * - Workspace directory management
 */
public class ProjectManager {

    private static final String PREF_FILE        = "termai_projects";
    private static final String PREF_RECENT      = "recent_projects";
    private static final String PREF_LAST_PROJECT = "last_project";
    private static final String PREF_LAST_CWD    = "last_cwd";
    private static final int    MAX_RECENT        = 10;

    private final File              projectsRoot;
    private final SharedPreferences prefs;
    private final Logger            logger;

    private String activeProjectPath = null;

    public ProjectManager(Context context, Logger logger) {
        this.logger       = logger;
        this.prefs        = context.getSharedPreferences(PREF_FILE, Context.MODE_PRIVATE);
        this.projectsRoot = new File(context.getFilesDir(), "projects");
        this.projectsRoot.mkdirs();
        logger.system(Logger.Level.INFO, "ProjectManager ready. Root: " + projectsRoot.getAbsolutePath());
    }

    // ─── Create project ───────────────────────────
    @JavascriptInterface
    public String createProject(String name, String type) {
        try {
            String safeName = name.replaceAll("[^a-zA-Z0-9_\\-]", "_");
            File   dir      = new File(projectsRoot, safeName);
            if (dir.exists()) return error("Project '" + safeName + "' already exists");

            dir.mkdirs();

            // Write .termai-project metadata
            JSONObject meta = new JSONObject();
            meta.put("name",        name);
            meta.put("type",        type != null ? type : "general");
            meta.put("created",     System.currentTimeMillis());
            meta.put("lastOpened",  System.currentTimeMillis());
            meta.put("version",     "1.0");

            writeFile(new File(dir, ".termai-project"), meta.toString(2));

            // Create type-specific structure
            scaffoldProject(dir, type);

            addToRecent(dir.getAbsolutePath(), name, type);
            logger.system(Logger.Level.INFO, "Project created: " + name + " [" + type + "]");

            return new JSONObject()
                .put("ok",   true)
                .put("path", dir.getAbsolutePath())
                .put("name", name)
                .toString();

        } catch (Exception e) {
            logger.system(Logger.Level.ERROR, "Create project error: " + e.getMessage());
            return error(e.getMessage());
        }
    }

    private void scaffoldProject(File dir, String type) throws IOException {
        if (type == null) return;
        switch (type.toLowerCase()) {
            case "python":
                new File(dir, "src").mkdirs();
                writeFile(new File(dir, "main.py"), "#!/usr/bin/env python3\n\ndef main():\n    print('Hello from TermAI!')\n\nif __name__ == '__main__':\n    main()\n");
                writeFile(new File(dir, "requirements.txt"), "# Add your dependencies here\n");
                writeFile(new File(dir, ".gitignore"), "__pycache__/\n*.pyc\n.env\nvenv/\n");
                break;
            case "node":
                writeFile(new File(dir, "index.js"), "// TermAI Node.js Project\nconsole.log('Hello from TermAI!');\n");
                writeFile(new File(dir, ".gitignore"), "node_modules/\n.env\ndist/\n");
                writeFile(new File(dir, "package.json"),
                    "{\"name\":\"" + dir.getName() + "\",\"version\":\"1.0.0\",\"main\":\"index.js\"}\n");
                break;
            case "bash":
                new File(dir, "scripts").mkdirs();
                writeFile(new File(dir, "main.sh"), "#!/bin/bash\nset -euo pipefail\necho 'Hello from TermAI!'\n");
                break;
            case "git":
                // Just init git — done via command
                break;
        }
        writeFile(new File(dir, "README.md"), "# " + dir.getName() + "\n\nCreated with TermAI.\n");
    }

    // ─── Open project ─────────────────────────────
    @JavascriptInterface
    public String openProject(String path) {
        try {
            File dir = new File(path);
            if (!dir.exists() || !dir.isDirectory()) return error("Project not found: " + path);

            activeProjectPath = dir.getAbsolutePath();
            prefs.edit().putString(PREF_LAST_PROJECT, activeProjectPath).apply();

            // Read metadata
            File metaFile = new File(dir, ".termai-project");
            String name = dir.getName();
            String type = "general";
            if (metaFile.exists()) {
                JSONObject meta = new JSONObject(readFile(metaFile));
                name = meta.optString("name", name);
                type = meta.optString("type", type);
                // Update lastOpened
                meta.put("lastOpened", System.currentTimeMillis());
                writeFile(metaFile, meta.toString(2));
            }

            addToRecent(path, name, type);
            logger.system(Logger.Level.INFO, "Project opened: " + name);

            return new JSONObject()
                .put("ok",   true)
                .put("path", activeProjectPath)
                .put("name", name)
                .put("type", type)
                .toString();

        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── List projects ────────────────────────────
    @JavascriptInterface
    public String listProjects() {
        try {
            JSONArray arr  = new JSONArray();
            File[]    dirs = projectsRoot.listFiles(File::isDirectory);
            if (dirs != null) {
                Arrays.sort(dirs, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                for (File dir : dirs) {
                    JSONObject p = new JSONObject();
                    p.put("path", dir.getAbsolutePath());
                    p.put("name", dir.getName());
                    p.put("lastModified", dir.lastModified());
                    p.put("active", dir.getAbsolutePath().equals(activeProjectPath));

                    File meta = new File(dir, ".termai-project");
                    if (meta.exists()) {
                        JSONObject m = new JSONObject(readFile(meta));
                        p.put("type", m.optString("type","general"));
                        p.put("name", m.optString("name", dir.getName()));
                    }
                    arr.put(p);
                }
            }
            return new JSONObject().put("ok", true).put("projects", arr).toString();
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── Recent projects ──────────────────────────
    @JavascriptInterface
    public String getRecentProjects() {
        return prefs.getString(PREF_RECENT, "[]");
    }

    private void addToRecent(String path, String name, String type) {
        try {
            JSONArray arr  = new JSONArray(prefs.getString(PREF_RECENT, "[]"));
            JSONArray next = new JSONArray();

            // Remove existing entry for same path
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.getJSONObject(i);
                if (!item.optString("path").equals(path)) next.put(item);
            }

            // Add to front
            JSONObject entry = new JSONObject();
            entry.put("path",       path);
            entry.put("name",       name);
            entry.put("type",       type != null ? type : "general");
            entry.put("lastOpened", System.currentTimeMillis());

            JSONArray result = new JSONArray();
            result.put(entry);
            for (int i = 0; i < Math.min(next.length(), MAX_RECENT - 1); i++)
                result.put(next.get(i));

            prefs.edit().putString(PREF_RECENT, result.toString()).apply();
        } catch (Exception ignored) {}
    }

    // ─── Session persistence ──────────────────────
    @JavascriptInterface
    public void saveSession(String cwd, String openFiles) {
        prefs.edit()
            .putString(PREF_LAST_CWD, cwd)
            .apply();
    }

    @JavascriptInterface
    public String restoreSession() {
        try {
            return new JSONObject()
                .put("lastProject", prefs.getString(PREF_LAST_PROJECT, ""))
                .put("lastCwd",     prefs.getString(PREF_LAST_CWD, "~"))
                .toString();
        } catch (Exception e) { return "{}"; }
    }

    // ─── Getters ──────────────────────────────────
    @JavascriptInterface
    public String getActiveProject()    { return activeProjectPath != null ? activeProjectPath : ""; }

    @JavascriptInterface
    public String getProjectsRootPath() { return projectsRoot.getAbsolutePath(); }

    // ─── Helpers ──────────────────────────────────
    private void writeFile(File f, String content) throws IOException {
        try (FileWriter fw = new FileWriter(f)) { fw.write(content); }
    }

    private String readFile(File f) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new FileReader(f))) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append("\n");
        }
        return sb.toString();
    }

    private String error(String msg) {
        try { return new JSONObject().put("ok",false).put("error",msg).toString(); }
        catch (Exception e) { return "{\"ok\":false}"; }
    }
}
