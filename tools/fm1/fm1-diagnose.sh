#!/usr/bin/env bash
# fm1-diagnose.sh — collect everything needed to root-cause
#   "could not build Objective-C module 'SwiftShims'"
# on macOS. Read-only with respect to the system: it only inspects the
# toolchain and runs `swift build` inside the project directory.
#
# Usage:  tools/fm1/fm1-diagnose.sh [path/to/swift/project]
# Output: fm1-diagnose.log and build.log in the project directory.
#
# Exit status: 0 = build succeeded, 1 = build failed, 2 = bad usage/environment.

set -uo pipefail

PROJECT_DIR="${1:-.}"
if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "error: '$PROJECT_DIR' is not a directory" >&2
  exit 2
fi
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this script diagnoses a macOS toolchain; run it on the Mac (found $(uname -s))" >&2
  exit 2
fi
if [[ ! -f "$PROJECT_DIR/Package.swift" ]]; then
  echo "error: no Package.swift in $PROJECT_DIR — pass the Swift project directory as the first argument" >&2
  exit 2
fi

LOG="$PROJECT_DIR/fm1-diagnose.log"
BUILD_LOG="$PROJECT_DIR/build.log"
: > "$LOG"

section() { printf '\n===== %s =====\n' "$1" | tee -a "$LOG"; }
# Run a command, record its output and exit status; never abort the script.
probe() {
  printf '\n$ %s\n' "$*" >> "$LOG"
  "$@" >> "$LOG" 2>&1
  printf '[exit %d]\n' "$?" >> "$LOG"
}
shellprobe() {
  printf '\n$ %s\n' "$1" >> "$LOG"
  bash -c "$1" >> "$LOG" 2>&1
  printf '[exit %d]\n' "$?" >> "$LOG"
}

section "Host"
probe sw_vers
probe uname -m
probe date -u +%Y-%m-%dT%H:%M:%SZ

section "Toolchain selection"
probe xcode-select -p
probe xcrun swift --version
probe swift --version
shellprobe 'which -a swift'
probe xcrun --show-sdk-path
probe xcrun --show-sdk-version
probe xcodebuild -version
probe xcodebuild -checkFirstLaunchStatus

section "Environment overrides that commonly break module builds"
for v in TOOLCHAINS SDKROOT DEVELOPER_DIR CPATH LIBRARY_PATH SWIFT_EXEC SWIFTPM_ENABLE_PLUGINS; do
  printf '%s=%s\n' "$v" "${!v-<unset>}" | tee -a "$LOG"
done
shellprobe 'echo "$PATH" | tr ":" "\n"'

section "Command Line Tools"
probe pkgutil --pkg-info=com.apple.pkg.CLTools_Executables
shellprobe 'ls -d /Library/Developer/CommandLineTools /Applications/Xcode*.app 2>&1'

section "SwiftShims presence"
SDK="$(xcrun --show-sdk-path 2>/dev/null || true)"
TOOLCHAIN_BIN="$(xcrun -f swift 2>/dev/null || true)"
printf 'sdk=%s\nswift=%s\n' "$SDK" "$TOOLCHAIN_BIN" | tee -a "$LOG"
if [[ -n "$TOOLCHAIN_BIN" ]]; then
  shellprobe "ls -d \"\$(dirname \"$TOOLCHAIN_BIN\")/../lib/swift/shims\" 2>&1"
fi

section "Other Swift installs that could shadow the system one"
shellprobe 'ls -d /Library/Developer/Toolchains/* ~/Library/Developer/Toolchains/* 2>&1'
shellprobe 'ls -d /opt/homebrew/opt/swift* /usr/local/opt/swift* ~/.swiftly ~/.swiftenv 2>&1'

section "Caches"
shellprobe 'du -sh ~/Library/Developer/Xcode/DerivedData 2>&1'
shellprobe 'du -sh "$(getconf DARWIN_USER_CACHE_DIR)org.llvm.clang* 2>&1" 2>&1'
shellprobe "du -sh \"$PROJECT_DIR/.build\" 2>&1"

section "Package"
probe head -n 40 "$PROJECT_DIR/Package.swift"

section "Build (swift build -v), full output in $BUILD_LOG"
( cd "$PROJECT_DIR" && swift build -v 2>&1 | tee "$BUILD_LOG" >/dev/null; exit "${PIPESTATUS[0]}" )
BUILD_STATUS=$?
printf 'swift build exit status: %d\n' "$BUILD_STATUS" | tee -a "$LOG"

section "First errors (root causes usually precede the final one)"
grep -n -m 10 -E 'error:|fatal error:' "$BUILD_LOG" | tee -a "$LOG" || echo "(no 'error:' lines)" | tee -a "$LOG"

section "Hints"
if grep -q "SwiftShims" "$BUILD_LOG" 2>/dev/null; then
  cat <<'HINTS' | tee -a "$LOG"
SwiftShims failure detected. Work through in order, re-running this script after each step:
  1. Compare 'swift --version' with 'xcrun swift --version' above. If they differ, a non-Xcode
     swift is first on PATH (see 'which -a swift'); remove it from PATH or unset TOOLCHAINS.
  2. Unset SDKROOT / DEVELOPER_DIR if set, then: sudo xcode-select -s /Applications/Xcode.app
  3. If Xcode was just updated: sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
  4. Clear stale caches: rm -rf "$(getconf DARWIN_USER_CACHE_DIR)"org.llvm.clang* .build
  5. If only Command Line Tools are installed and the SDK/compiler pair looks mismatched:
     sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install
HINTS
fi

echo
echo "Wrote $LOG and $BUILD_LOG — paste fm1-diagnose.log back into the session."
[[ $BUILD_STATUS -eq 0 ]] && exit 0 || exit 1
