#!/bin/sh
set -eu

target_dir=${CARGO_TARGET_DIR:-/private/tmp/highostty-target}
profile=${PROFILE:-debug}
output=${1:-/private/tmp/HiGhostty-universal.app}
arm_app="$target_dir/$profile/bundle/macos/HiGhostty.app"
arm_bin="$arm_app/Contents/MacOS/highostty"
x86_bin="$target_dir/x86_64-apple-darwin/$profile/highostty"

if [ ! -d "$arm_app" ] || [ ! -f "$x86_bin" ]; then
  echo "Build the arm64 Tauri app and x86_64 Rust binary first." >&2
  exit 1
fi

ditto "$arm_app" "$output"
find "$output" -name '._*' -type f -delete
lipo -create "$arm_bin" "$x86_bin" -output "$output/Contents/MacOS/highostty"
codesign --force --deep --sign - "$output"
codesign --verify --deep --strict "$output"
lipo -info "$output/Contents/MacOS/highostty"
