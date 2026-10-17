#!/usr/bin/env bash
# Builds, signs and publishes the Pocket Gym Android app on the server, in Docker — no Android
# Studio, Java or SDK on the host. Run from the repo root on the server:
#
#   scripts/android/build-apk.sh [OUT_DIR]        # OUT_DIR defaults to /opt/pocketgym-android/dist
#
# What it does:
#   1. Creates the signing key on first run, in KEYS_DIR (/opt/pocketgym-android/keys), with a
#      random password beside it. KEEP THAT DIRECTORY: every update must be signed with the same
#      key, or Android refuses to install it over the app already on a phone. Back it up.
#   2. Builds the mobile flavor and the release APK in the same image the upstream CI uses.
#   3. Signs it, and writes OUT_DIR/pocketgym.apk, pocketgym-<version>.apk, its .sha256, and
#      latest.json — what the app's update check reads (frontend/src/lib/update.js).
#
# The web server then serves OUT_DIR at https://<your domain>/android/ (see docs/MOBILE.md).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-/opt/pocketgym-android/dist}"
KEYS="${KEYS_DIR:-/opt/pocketgym-android/keys}"
CACHE="${CACHE_DIR:-/opt/pocketgym-android/cache}"
IMAGE="${ANDROID_IMAGE:-cimg/android:2026.08-node}"
ALIAS=pocketgym

mkdir -p "$OUT" "$KEYS" "$CACHE/gradle" "$CACHE/npm"
chmod 700 "$KEYS"

if [ ! -f "$KEYS/release.jks" ]; then
  echo "No signing key yet: creating $KEYS/release.jks (back this directory up)."
  umask 077
  head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 > "$KEYS/password"
  docker run --rm -v "$KEYS:/keys" "$IMAGE" bash -c \
    "keytool -genkeypair -keystore /keys/release.jks -alias $ALIAS -keyalg RSA -keysize 4096 -validity 10000 \
       -storepass \"\$(cat /keys/password)\" -keypass \"\$(cat /keys/password)\" \
       -dname 'CN=Pocket Gym, O=Pocket Gym' && chown $(id -u):$(id -g) /keys/release.jks"
fi

docker run --rm \
  -v "$REPO:/src" -v "$KEYS:/keys:ro" -v "$OUT:/out" \
  -v "$CACHE/gradle:/home/circleci/.gradle" -v "$CACHE/npm:/home/circleci/.npm" \
  -e GRADLE_OPTS=-Dorg.gradle.daemon=false -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -u root "$IMAGE" bash -euo pipefail -c '
    # The image runs as circleci; the checkout belongs to the host user. Build as root on a copy
    # so nothing in the repo (node_modules, android/build) changes owner or gets left behind.
    rm -rf /build && cp -a /src /build && cd /build/frontend
    rm -rf node_modules
    npm ci --no-audit --no-fund
    npm run build:mobile
    VER="$(node -p "require(\"./package.json\").version")"
    cd android
    GRADLE_USER_HOME=/home/circleci/.gradle ./gradlew --no-daemon -q assembleRelease
    BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
    "$BT/zipalign" -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk /tmp/aligned.apk
    PASS="$(cat /keys/password)"
    "$BT/apksigner" sign --ks /keys/release.jks --ks-key-alias pocketgym \
      --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --out "/out/pocketgym-$VER.apk" /tmp/aligned.apk
    "$BT/apksigner" verify "/out/pocketgym-$VER.apk"
    cd /out
    cp "pocketgym-$VER.apk" pocketgym.apk
    SUM="$(sha256sum "pocketgym-$VER.apk" | cut -d" " -f1)"
    echo "$SUM  pocketgym-$VER.apk" > "pocketgym-$VER.apk.sha256"
    printf "{\"version\":\"%s\",\"apk\":\"pocketgym-%s.apk\",\"sha256\":\"%s\",\"built\":\"%s\"}\n" \
      "$VER" "$VER" "$SUM" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > latest.json
    chown -R "$HOST_UID:$HOST_GID" /out
    echo "Built Pocket Gym $VER ($SUM)"
  '
ls -la "$OUT"
