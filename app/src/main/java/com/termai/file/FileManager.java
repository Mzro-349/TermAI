package com.termai.file;

import android.content.Context;
import android.webkit.JavascriptInterface;

import com.termai.log.Logger;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.*;
import java.util.*;

/**
 * FileManager — Safe file I/O for the terminal workspace.
 *
 * All operations are scoped to the app's files directory.
 * No access outside sandbox — Google Play compliant.
 */
public class FileManager {

    private final File   root;
    private final Logger logger;

    public FileManager(Context context, Logger logger) {
        this.root   = context.getFilesDir();
        this.logger = logger;
    }

    // ─── Read ─────────────────────────────────────
    @JavascriptInterface
    public String readFile(String path) {
        try {
            File f = resolve(path);
            if (!f.exists() || !f.isFile()) return error("File not found: " + path);
            if (f.length() > 1024 * 1024) return error("File too large (>1MB) to read in editor");

            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new FileReader(f))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line).append("\n");
            }
            return ok().put("content", sb.toString()).put("path", f.getAbsolutePath()).toString();
        } catch (Exception e) {
            logger.system(Logger.Level.ERROR, "readFile error: " + e.getMessage());
            return error(e.getMessage());
        }
    }

    // ─── Write ────────────────────────────────────
    @JavascriptInterface
    public String writeFile(String path, String content) {
        try {
            File f = resolve(path);
            f.getParentFile().mkdirs();
            try (FileWriter fw = new FileWriter(f)) { fw.write(content); }
            logger.system(Logger.Level.INFO, "writeFile: " + f.getAbsolutePath());
            return ok().put("path", f.getAbsolutePath()).put("size", f.length()).toString();
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── List directory ───────────────────────────
    @JavascriptInterface
    public String listDir(String path) {
        try {
            File   dir   = resolve(path != null && !path.isEmpty() ? path : "home");
            File[] files = dir.listFiles();
            if (files == null) return error("Cannot list: " + path);

            Arrays.sort(files, (a, b) -> {
                if (a.isDirectory() != b.isDirectory())
                    return a.isDirectory() ? -1 : 1;
                return a.getName().compareToIgnoreCase(b.getName());
            });

            JSONArray arr = new JSONArray();
            for (File f : files) {
                if (f.getName().equals(".") || f.getName().equals("..")) continue;
                JSONObject item = new JSONObject();
                item.put("name",     f.getName());
                item.put("path",     f.getAbsolutePath());
                item.put("isDir",    f.isDirectory());
                item.put("size",     f.isFile() ? f.length() : 0);
                item.put("modified", f.lastModified());
                item.put("hidden",   f.getName().startsWith("."));
                arr.put(item);
            }
            return ok().put("files", arr).put("path", dir.getAbsolutePath()).toString();
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── Delete ───────────────────────────────────
    @JavascriptInterface
    public String deleteFile(String path) {
        try {
            File f = resolve(path);
            if (!f.exists()) return error("Not found: " + path);
            boolean ok = f.isDirectory() ? deleteDir(f) : f.delete();
            logger.system(Logger.Level.INFO, "deleteFile: " + path + " ok=" + ok);
            return ok ? ok().toString() : error("Delete failed");
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── Move / Rename ────────────────────────────
    @JavascriptInterface
    public String moveFile(String from, String to) {
        try {
            File src  = resolve(from);
            File dest = resolve(to);
            dest.getParentFile().mkdirs();
            boolean ok = src.renameTo(dest);
            return ok ? ok().put("path", dest.getAbsolutePath()).toString()
                       : error("Move failed");
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── Copy ─────────────────────────────────────
    @JavascriptInterface
    public String copyFile(String from, String to) {
        try {
            File src  = resolve(from);
            File dest = resolve(to);
            dest.getParentFile().mkdirs();
            try (InputStream  in  = new FileInputStream(src);
                 OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[8192];
                int    n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            }
            return ok().put("path", dest.getAbsolutePath()).toString();
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── Mkdir ────────────────────────────────────
    @JavascriptInterface
    public String mkdir(String path) {
        try {
            File f = resolve(path);
            f.mkdirs();
            return ok().put("path", f.getAbsolutePath()).toString();
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── File info ────────────────────────────────
    @JavascriptInterface
    public String stat(String path) {
        try {
            File f = resolve(path);
            return ok()
                .put("exists",   f.exists())
                .put("isDir",    f.isDirectory())
                .put("size",     f.length())
                .put("modified", f.lastModified())
                .put("readable", f.canRead())
                .put("writable", f.canWrite())
                .toString();
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    // ─── Path helpers ─────────────────────────────
    @JavascriptInterface
    public String getRootPath() { return root.getAbsolutePath(); }

    @JavascriptInterface
    public String getHomePath() { return new File(root, "home").getAbsolutePath(); }

    // ─── Internals ────────────────────────────────
    private File resolve(String path) throws SecurityException {
        if (path == null || path.isEmpty()) return root;
        path = path.replace("~", new File(root, "home").getAbsolutePath());
        File f = new File(path).isAbsolute() ? new File(path) : new File(root, path);

        // Security: must stay inside root
        try {
            String canonical = f.getCanonicalPath();
            if (!canonical.startsWith(root.getCanonicalPath())) {
                throw new SecurityException("Path escape attempt: " + path);
            }
        } catch (IOException e) {
            throw new SecurityException("Invalid path: " + path);
        }
        return f;
    }

    private boolean deleteDir(File dir) {
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) {
            if (f.isDirectory()) deleteDir(f); else f.delete();
        }
        return dir.delete();
    }

    private JSONObject ok() throws Exception {
        return new JSONObject().put("ok", true);
    }

    private String error(String msg) {
        try { return new JSONObject().put("ok",false).put("error",msg).toString(); }
        catch (Exception e) { return "{\"ok\":false}"; }
    }
}
