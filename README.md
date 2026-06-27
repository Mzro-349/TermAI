# TermAI

Smart AI-powered terminal for Android. WebView-based terminal with Claude AI integration, Google Play Billing, and security engine.

## Stack
- **Android** — Pure Java, WebView, minSdk 26 (Android 8+)
- **Frontend** — HTML/CSS/JS terminal in `assets/`
- **AI** — Claude via Vercel proxy in `vercel-api/`
- **Billing** — Google Play Billing v6 (subscriptions)

## Build

### Manual (GitHub Actions)
1. Push to GitHub
2. Go to **Actions → Build TermAI → Run workflow**
3. Choose build type:
   - `release-aab` → for Google Play Store upload
   - `release-apk` → for direct install / testing
   - `debug-apk`   → for development

### Keystore
Signing key is **committed** at `app/keystore.jks`.
- Alias: `termai-release`
- Password: `TermAI@2026#Secure`
- Valid: 10,000 days (~27 years)

> ⚠️ If you fork this repo publicly, regenerate the keystore or move credentials to GitHub Secrets.

## Vercel API
Deploy `vercel-api/` as a separate Vercel project.
Set env var: `ANTHROPIC_API_KEY=sk-ant-...`

## Google Play Setup
1. Build `release-aab`
2. Upload `.aab` to Play Console → Internal Testing
3. Create subscriptions in Play Console:
   - Product ID: `termai_premium_monthly`
   - Product ID: `termai_premium_yearly`
4. Add SHA-256 fingerprint to Play Console (App Signing)

## Package
`com.termai` — minSdk 26, targetSdk 34
