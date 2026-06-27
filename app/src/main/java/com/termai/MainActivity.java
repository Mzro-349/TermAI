package com.termai;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.*;
import android.os.Build;

import com.termai.ai.AIManager;
import com.termai.billing.BillingManager;
import com.termai.bridge.TerminalBridge;
import com.termai.crash.CrashManager;
import com.termai.file.FileManager;
import com.termai.log.Logger;
import com.termai.plugin.PluginManager;
import com.termai.project.ProjectManager;
import com.termai.security.SecurityEngine;
import com.termai.settings.SettingsManager;

public class MainActivity extends Activity {

    private Logger          logger;
    private CrashManager    crashManager;
    private SettingsManager settings;
    private SecurityEngine  security;
    private PluginManager   plugins;
    private TerminalBridge  termBridge;
    private AIManager       aiManager;
    private BillingManager  billing;
    private FileManager     fileManager;
    private ProjectManager  projectManager;
    private WebView         webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        try {
            initApp();
        } catch (Throwable e) {
            // Show crash reason to developer
            showFatalError(e);
        }
    }

    private void initApp() {
        setFullscreen();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // 1. Logger
        logger = new Logger(this);

        // 2. Crash manager
        crashManager = new CrashManager(this, logger);
        crashManager.sessionStarted();

        // 3. Settings
        settings = new SettingsManager(this);

        // 4. Security
        security = new SecurityEngine(this, logger);
        security.setSandboxMode(settings.getBool(SettingsManager.SEC_SANDBOX));

        // 5. Plugins
        plugins = new PluginManager(logger);

        // 6. WebView
        webView = new WebView(this);
        setContentView(webView);
        setupWebView();

        // 7. AI
        aiManager = new AIManager(this, settings, logger, webView);

        // 8. Billing (initialized BEFORE loadUrl so onPageFinished is safe)
        billing = new BillingManager(this, webView, logger);
        billing.setListener(isPremium -> {
            plugins.setPremiumActive(isPremium);
            logger.billing(Logger.Level.INFO, "Premium: " + isPremium);
        });

        // 9. File & Project
        fileManager    = new FileManager(this, logger);
        projectManager = new ProjectManager(this, logger);

        // 10. Register JS bridges
        webView.addJavascriptInterface(termBridge,    "Terminal");
        webView.addJavascriptInterface(billing,        "Billing");
        webView.addJavascriptInterface(aiManager,      "AIBridge");
        webView.addJavascriptInterface(fileManager,    "Files");
        webView.addJavascriptInterface(projectManager, "Projects");
        webView.addJavascriptInterface(settings,       "Settings");
        webView.addJavascriptInterface(logger,         "AppLogger");
        webView.addJavascriptInterface(crashManager,   "CrashManager");

        // 11. Load app
        webView.loadUrl("file:///android_asset/index.html");
        logger.system(Logger.Level.INFO, "TermAI started OK");
    }

    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        String homeDir = getFilesDir().getAbsolutePath() + "/home";
        termBridge = new TerminalBridge(this, webView, homeDir, security, plugins, logger);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                // Null check — billing must be initialized first
                if (billing != null) billing.queryPurchases();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (logger != null)
                    logger.system(
                        m.messageLevel() == ConsoleMessage.MessageLevel.ERROR
                            ? Logger.Level.ERROR : Logger.Level.DEBUG,
                        "[JS] " + m.message());
                return true;
            }
        });
    }

    private void showFatalError(Throwable e) {
        // Show dialog with exact crash message so developer can debug without logcat
        String msg = e.getClass().getSimpleName() + ":\n" + e.getMessage();
        if (e.getCause() != null) msg += "\nCaused by: " + e.getCause().getMessage();

        // Save to SharedPreferences for next session
        getSharedPreferences("termai_crash", MODE_PRIVATE)
            .edit().putString("last_fatal", msg).apply();

        try {
            new AlertDialog.Builder(this)
                .setTitle("TermAI — Startup Error")
                .setMessage(msg)
                .setPositiveButton("OK", (d, w) -> finish())
                .setCancelable(false)
                .show();
        } catch (Throwable ignored) {
            finish();
        }
    }

    private void setFullscreen() {
        try {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN |
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        } catch (Throwable ignored) {}
    }

    @Override protected void onResume()  { super.onResume();  if(webView!=null)webView.onResume();  setFullscreen(); }
    @Override protected void onPause()   { super.onPause();   if(webView!=null)webView.onPause(); }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (crashManager != null) crashManager.sessionEnded();
        if (termBridge   != null) termBridge.destroy();
        if (billing      != null) billing.destroy();
        if (aiManager    != null) aiManager.shutdown();
        if (security     != null) security.shutdown();
        if (logger       != null) logger.shutdown();
        if (webView      != null) webView.destroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null)
            webView.evaluateJavascript(
                "document.dispatchEvent(new Event('backbutton'))", null);
    }
}
