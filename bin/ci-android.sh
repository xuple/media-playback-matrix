#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner (which runs each `script:` line on its own,
# so multi-line shell constructs must live in a file).
set -uo pipefail
mkdir -p diagnostics
trap 'status=$?; if [ "$status" -ne 0 ]; then adb logcat -d | tail -n 2000 > diagnostics/android-logcat.txt || true; fi' EXIT
adb shell getprop ro.build.version.release > diagnostics/android-version.txt
adb shell dumpsys package com.android.chrome > diagnostics/chrome-package.txt
if ! adb shell pm path com.android.chrome | tee diagnostics/chrome-path.txt | grep -q '^package:'; then
  node runners/ci.mjs infra "${1:-android-chrome}" 'com.android.chrome absent from Play Store image; no APK fallback'
  exit 1
fi
node runners/ci.mjs run "${1:-android-chrome}" -- node runners/android-chrome.mjs
