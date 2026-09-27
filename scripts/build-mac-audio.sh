#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Mac audio requires macOS 15+ and Xcode Command Line Tools." >&2
  exit 1
fi
bundle="$PWD/.echoguide/native/EchoGuide Audio.app"
mkdir -p "$bundle/Contents/MacOS" "$PWD/.echoguide/native/module-cache"
cp native/mac-audio/Info.plist "$bundle/Contents/Info.plist"
xcrun swiftc -swift-version 5 -O -module-cache-path "$PWD/.echoguide/native/module-cache" \
  -target "$(uname -m)-apple-macos15.0" native/mac-audio/main.swift \
  -o "$bundle/Contents/MacOS/EchoGuideAudio"
codesign --force --sign - --identifier ai.echoguide.audio.local "$bundle"
"$bundle/Contents/MacOS/EchoGuideAudio" --self-test
node scripts/test-mac-audio-watchdog.mjs "$bundle/Contents/MacOS/EchoGuideAudio"
echo "Built EchoGuide Audio. Open EchoGuide on localhost and select MacBook audio."
