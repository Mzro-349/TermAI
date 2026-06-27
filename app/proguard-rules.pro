# TermAI ProGuard Rules

# Keep all JavascriptInterface methods (critical for WebView bridge)
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep all TermAI classes and their members
-keep class com.termai.** { *; }
-keepclassmembers class com.termai.** { *; }

# Google Play Billing
-keep class com.android.billingclient.** { *; }
-keepclassmembers class com.android.billingclient.** { *; }

# AndroidX
-keep class androidx.** { *; }

# WebView bridge safety
-keepclassmembers class * extends android.webkit.WebViewClient {
    public void *(android.webkit.WebView, java.lang.String, android.graphics.Bitmap);
    public boolean *(android.webkit.WebView, java.lang.String);
}

# Kotlin (if added later)
-dontwarn kotlin.**

# JSON
-keep class org.json.** { *; }

# Prevent stripping enums
-keepclassmembers enum * { *; }

# Keep Serializable
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
    java.lang.Object writeReplace();
    java.lang.Object readResolve();
}
