package com.termai.billing;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.android.billingclient.api.*;
import com.termai.log.Logger;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * BillingManager v2 — Complete billing lifecycle. Single source of truth.
 *
 * Added: Restore Purchases · Offline Cache · Expiry Check · Trial · Offer Manager
 */
public class BillingManager {

    public static final String SKU_MONTHLY = "termai_premium_monthly";
    public static final String SKU_YEARLY  = "termai_premium_yearly";

    private static final String PREF_FILE         = "termai_billing";
    private static final String PREF_PREMIUM       = "is_premium";
    private static final String PREF_EXPIRY        = "premium_expiry_ms";
    private static final String PREF_TRIAL_USED    = "trial_used";
    private static final String PREF_TRIAL_START   = "trial_start_ms";
    private static final long   TRIAL_DURATION_MS  = 7L * 24 * 60 * 60 * 1000; // 7 days
    private static final long   OFFLINE_GRACE_MS   = 7L * 24 * 60 * 60 * 1000; // 7 days offline grace

    public interface Listener { void onPremiumChanged(boolean isPremium); }

    private final Activity          activity;
    private final WebView           webView;
    private final Logger            logger;
    private final Handler           mainHandler;
    private final SharedPreferences prefs;

    private BillingClient billingClient;
    private boolean       connected = false;
    private boolean       premium   = false;
    private Listener      listener;

    public BillingManager(Activity activity, WebView webView, Logger logger) {
        this.activity    = activity;
        this.webView     = webView;
        this.logger      = logger;
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.prefs       = activity.getSharedPreferences(PREF_FILE, Activity.MODE_PRIVATE);

        // Load from offline cache first (immediate premium if grace period active)
        this.premium = loadCachedPremium();
        connect();
    }

    public void setListener(Listener l) { this.listener = l; }

    // ─── Offline cache ────────────────────────────
    private boolean loadCachedPremium() {
        if (!prefs.getBoolean(PREF_PREMIUM, false)) return isTrialActive();
        // Check if within grace period (allow offline use for 7 days)
        long lastVerified = prefs.getLong(PREF_EXPIRY, 0);
        if (lastVerified > 0 && System.currentTimeMillis() - lastVerified > OFFLINE_GRACE_MS) {
            logger.billing(Logger.Level.WARN, "Premium cache expired — will re-verify");
            return false; // force re-verify
        }
        logger.billing(Logger.Level.INFO, "Premium loaded from cache");
        return true;
    }

    // ─── Trial ────────────────────────────────────
    public boolean isTrialActive() {
        if (prefs.getBoolean(PREF_TRIAL_USED, false)) {
            long start = prefs.getLong(PREF_TRIAL_START, 0);
            return start > 0 && System.currentTimeMillis() - start < TRIAL_DURATION_MS;
        }
        return false;
    }

    @JavascriptInterface
    public String getTrialStatus() {
        try {
            boolean trialUsed   = prefs.getBoolean(PREF_TRIAL_USED, false);
            long    trialStart  = prefs.getLong(PREF_TRIAL_START, 0);
            boolean trialActive = isTrialActive();
            long    remaining   = trialActive ? TRIAL_DURATION_MS - (System.currentTimeMillis() - trialStart) : 0;
            return new JSONObject()
                .put("trialUsed",       trialUsed)
                .put("trialActive",     trialActive)
                .put("trialRemainingMs", remaining)
                .put("trialDays",        remaining / (1000 * 60 * 60 * 24))
                .toString();
        } catch (Exception e) { return "{}"; }
    }

    @JavascriptInterface
    public String startTrial() {
        if (prefs.getBoolean(PREF_TRIAL_USED, false)) {
            return "{\"ok\":false,\"reason\":\"Trial already used\"}";
        }
        long now = System.currentTimeMillis();
        prefs.edit()
            .putBoolean(PREF_TRIAL_USED, true)
            .putLong(PREF_TRIAL_START, now)
            .apply();
        setPremium(true);
        logger.billing(Logger.Level.INFO, "Trial started");
        return "{\"ok\":true,\"durationDays\":7}";
    }

    // ─── Connect ──────────────────────────────────
    private void connect() {
        billingClient = BillingClient.newBuilder(activity)
            .setListener(this::onPurchasesUpdated)
            .enablePendingPurchases()
            .build();

        billingClient.startConnection(new BillingClientStateListener() {
            @Override public void onBillingSetupFinished(BillingResult r) {
                if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    connected = true;
                    queryPurchases();
                    logger.billing(Logger.Level.INFO, "Billing connected");
                }
            }
            @Override public void onBillingServiceDisconnected() {
                connected = false;
                logger.billing(Logger.Level.WARN, "Billing disconnected — retrying");
                mainHandler.postDelayed(() -> { if (!connected) connect(); }, 5000);
            }
        });
    }

    // ─── Query purchases ──────────────────────────
    public void queryPurchases() {
        if (!connected) return;
        billingClient.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.SUBS)
                .build(),
            (result, purchases) -> {
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) return;
                boolean active = false;
                for (Purchase p : purchases) {
                    if (p.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                        active = true;
                        if (!p.isAcknowledged()) acknowledge(p);
                    }
                }
                if (!active) active = isTrialActive();
                setPremium(active);
                // Update cache timestamp
                if (active) prefs.edit().putLong(PREF_EXPIRY, System.currentTimeMillis()).apply();
            }
        );
    }

    // ─── Restore purchases ────────────────────────
    @JavascriptInterface
    public void restorePurchases(String callbackId) {
        if (!connected) {
            notifyJs("window.terminalCallbacks['" + callbackId + "'] && window.terminalCallbacks['" + callbackId + "']({ok:false,error:'Not connected'})");
            return;
        }
        billingClient.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.SUBS)
                .build(),
            (result, purchases) -> {
                boolean found = false;
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    for (Purchase p : purchases) {
                        if (p.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                            found = true;
                            if (!p.isAcknowledged()) acknowledge(p);
                        }
                    }
                }
                setPremium(found || isTrialActive());
                logger.billing(Logger.Level.INFO, "Restore: found=" + found);
                final boolean ok = found;
                mainHandler.post(() ->
                    webView.evaluateJavascript(
                        "var fn=window.terminalCallbacks&&window.terminalCallbacks['" + callbackId + "'];" +
                        "if(fn){delete window.terminalCallbacks['" + callbackId + "'];fn({ok:true,restored:" + ok + "});}",
                        null));
            }
        );
    }

    // ─── Launch purchase flow ─────────────────────
    public void launchPurchaseFlow(String sku) {
        if (!connected) { connect(); return; }
        billingClient.queryProductDetailsAsync(
            QueryProductDetailsParams.newBuilder()
                .setProductList(Collections.singletonList(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(sku).setProductType(BillingClient.ProductType.SUBS).build()))
                .build(),
            (result, detailsList) -> {
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK || detailsList.isEmpty()) return;
                ProductDetails pd = detailsList.get(0);
                List<ProductDetails.SubscriptionOfferDetails> offers = pd.getSubscriptionOfferDetails();
                if (offers == null || offers.isEmpty()) return;
                mainHandler.post(() ->
                    billingClient.launchBillingFlow(activity,
                        BillingFlowParams.newBuilder()
                            .setProductDetailsParamsList(Collections.singletonList(
                                BillingFlowParams.ProductDetailsParams.newBuilder()
                                    .setProductDetails(pd)
                                    .setOfferToken(offers.get(0).getOfferToken())
                                    .build()))
                            .build()));
            }
        );
    }

    // ─── JS interface ─────────────────────────────
    @JavascriptInterface public String getPremiumStatus() { return premium ? "active" : "inactive"; }
    @JavascriptInterface public boolean isPremiumActive()  { return premium; }

    @JavascriptInterface
    public void requestUpgrade(String sku) {
        mainHandler.post(() -> launchPurchaseFlow(
            sku != null && !sku.isEmpty() ? sku : SKU_MONTHLY));
    }

    @JavascriptInterface
    public String getBillingStatus() {
        try {
            return new JSONObject()
                .put("connected",    connected)
                .put("premium",      premium)
                .put("trial",        isTrialActive())
                .put("trialStatus",  new JSONObject(getTrialStatus()))
                .toString();
        } catch (Exception e) { return "{}"; }
    }

    // ─── Internal ─────────────────────────────────
    private void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK || purchases == null) return;
        for (Purchase p : purchases) {
            if (p.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                if (!p.isAcknowledged()) acknowledge(p);
                setPremium(true);
            }
        }
    }

    private void acknowledge(Purchase p) {
        billingClient.acknowledgePurchase(
            AcknowledgePurchaseParams.newBuilder().setPurchaseToken(p.getPurchaseToken()).build(),
            r -> logger.billing(Logger.Level.INFO, "Acknowledge: " + r.getResponseCode()));
    }

    private void setPremium(boolean active) {
        if (premium == active) return;
        premium = active;
        prefs.edit().putBoolean(PREF_PREMIUM, active).apply();
        if (listener != null) listener.onPremiumChanged(active);
        notifyJs("if(window.AI)window.AI.isPremium=" + active + ";" +
                 "if(window.updateAIBadge)window.updateAIBadge(" + active + ");" +
                 "if(window.onPremiumActivated)window.onPremiumActivated('" + (active?"active":"inactive") + "');");
        logger.billing(Logger.Level.INFO, "Premium: " + (active ? "ACTIVE" : "INACTIVE"));
    }

    private void notifyJs(String js) {
        mainHandler.post(() -> webView.evaluateJavascript(js, null));
    }

    public boolean isPremium() { return premium; }

    public void destroy() {
        if (billingClient != null && connected) billingClient.endConnection();
    }
}
