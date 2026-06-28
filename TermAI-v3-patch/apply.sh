#!/bin/bash
# Apply TermAI v2 patch
DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$HOME/TermAI-fixed"

echo "Applying TermAI v2 patch..."

# Assets
cp "$DIR/index.html"   "$PROJECT/app/src/main/assets/"
cp "$DIR/terminal.js"  "$PROJECT/app/src/main/assets/"
cp "$DIR/terminal.css" "$PROJECT/app/src/main/assets/"
cp "$DIR/ai-engine.js" "$PROJECT/app/src/main/assets/"

# Also copy to root assets (for workflow)
cp "$DIR/index.html"   "$PROJECT/assets/"
cp "$DIR/terminal.js"  "$PROJECT/assets/"
cp "$DIR/terminal.css" "$PROJECT/assets/"
cp "$DIR/ai-engine.js" "$PROJECT/assets/"

# MainActivity
cp "$DIR/MainActivity.java" \
   "$PROJECT/app/src/main/java/com/termai/MainActivity.java"

echo "Files applied. Committing..."
cd "$PROJECT"
git add -A
git commit -m "TermAI v2: full UI rebuild, all buttons wired, offline assets"
git push

echo "Done! Go to GitHub Actions → Build TermAI → Run workflow → release-apk"
