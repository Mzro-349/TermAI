package com.termai;

import android.app.Activity;
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

/**
 * MainActivity — Pure orchestrator. Zero business logic.
 *
 *  Wires:
 *  Logger · CrashManager · SettingsManager · SecurityEngine
 *  PluginManager · ShellEngine (via TerminalBridge)
 *  AIManager · BillingManager · FileManager · ProjectManager
 *
 *  All exposed to JS under their own bridge names.
 */
public class MainActivity extends Activity {

    // All managers
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

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setFullscreen();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // 1. Logger first — everything else uses it
        logger = new Logger(this);

        // 2. Crash manager — catch exceptions early
        crashManager = new CrashManager(this, logger);
        crashManager.sessionStarted();

        // 3. Settings
        settings = new SettingsManager(this);

        // 4. Security engine
        security = new SecurityEngine(this, logger);
        security.setSandboxMode(settings.getBool(SettingsManager.SEC_SANDBOX));

        // 5. Plugins
        plugins = new PluginManager(logger);

        // 6. WebView
        webView = new WebView(this);
        setContentView(webView);
        setupWebView();

        // 7. Terminal bridge (shell + security + queue + plugins)
        String homeDir = getFilesDir().getAbsolutePath() + "/home";
        termBridge = new TerminalBridge(this, webView, homeDir, security, plugins, logger);

        // 8. AI Manager
        aiManager = new AIManager(this, settings, logger, webView);

        // 9. Billing
        billing = new BillingManager(this, webView, logger);
        billing.setListener(isPremium -> {
            plugins.setPremiumActive(isPremium);
            logger.billing(Logger.Level.INFO, "Premium changed: " + isPremium);
        });

        // 10. File & Project managers
        fileManager    = new FileManager(this, logger);
        projectManager = new ProjectManager(this, logger);

        // 11. Register all bridges
        webView.addJavascriptInterface(termBridge,     "Terminal");
        webView.addJavascriptInterface(billing,         "Billing");
        webView.addJavascriptInterface(aiManager,       "AIBridge");
        webView.addJavascriptInterface(fileManager,     "Files");
        webView.addJavascriptInterface(projectManager,  "Projects");
        webView.addJavascriptInterface(settings,        "Settings");
        webView.addJavascriptInterface(logger,          "AppLogger");
        webView.addJavascriptInterface(crashManager,    "CrashManager");

        webView.loadUrl("file:///android_asset/index.html");
        logger.system(Logger.Level.INFO, "TermAI started");
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

        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) {
                billing.queryPurchases(); // sync premium on load
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                logger.system(m.messageLevel() == ConsoleMessage.MessageLevel.ERROR
                    ? Logger.Level.ERROR : Logger.Level.DEBUG,
                    "[JS] " + m.message());
                return true;
            }
        });
    }

    private void setFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN |
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override protected void onResume()  { super.onResume();  webView.onResume();  setFullscreen(); }
    @Override protected void onPause()   { super.onPause();   webView.onPause(); }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        crashManager.sessionEnded();
        if (termBridge  != null) termBridge.destroy();
        if (billing     != null) billing.destroy();
        if (aiManager   != null) aiManager.shutdown();
        if (security    != null) security.shutdown();
        if (logger      != null) logger.shutdown();
        webView.destroy();
    }

    @Override
    public void onBackPressed() {
        webView.evaluateJavascript("document.dispatchEvent(new Event('backbutton'))", null);
    }
}
