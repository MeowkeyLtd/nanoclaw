#!/bin/bash
# Offline test for cursor-runner.ts (single-turn)
# Uses mock-agent binary instead of real Cursor CLI
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR=$(mktemp -d)
STDERR_FILE=$(mktemp)
IPC_DIR=$(mktemp -d)/ipc/input

trap "rm -rf $DIST_DIR $STDERR_FILE $(dirname $(dirname $IPC_DIR)) /tmp/mock-agent-counter" EXIT

# Put mock-agent on PATH as "agent"
export PATH="$SCRIPT_DIR:$PATH"
rm -f /tmp/mock-agent-counter

# Create IPC directory (no _close yet — we'll send it after first response)
mkdir -p "$IPC_DIR"

echo "=== Compiling TypeScript ==="
cd "$RUNNER_DIR"
npx tsc --outDir "$DIST_DIR" 2>&1
ln -sf "$RUNNER_DIR/node_modules" "$DIST_DIR/node_modules"

# Patch IPC path in compiled JS
sed -i "s|/workspace/ipc/input|$IPC_DIR|g" "$DIST_DIR/cursor-runner.js"

echo "=== Running cursor-runner with mock agent ==="
INPUT='{"prompt":"say hello","groupFolder":"test","chatJid":"test@test","isMain":false}'

# Run in background so we can send _close after first response
echo "$INPUT" | node "$DIST_DIR/cursor-runner.js" >"$DIST_DIR/stdout.txt" 2>"$STDERR_FILE" &
PID=$!

# Wait for first response
for i in $(seq 1 20); do
  if grep -q "NANOCLAW_OUTPUT_END" "$DIST_DIR/stdout.txt" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# Send _close so the runner exits
touch "$IPC_DIR/_close"

# Wait for process to exit
wait $PID 2>/dev/null || true

OUTPUT=$(cat "$DIST_DIR/stdout.txt")

echo "=== STDOUT ==="
echo "$OUTPUT"
echo ""
echo "=== STDERR ==="
cat "$STDERR_FILE"
echo ""

# Validate
PASS=0
FAIL=0

check() {
  if echo "$OUTPUT" | grep -q "$1"; then
    echo "PASS: $2"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $2 (looking for: $1)"
    FAIL=$((FAIL + 1))
  fi
}

check "NANOCLAW_OUTPUT_START" "output start marker found"
check "NANOCLAW_OUTPUT_END" "output end marker found"
check "mock-session" "session ID captured"
check "mock cursor agent" "response text forwarded"
check '"status":"success"' "status is success"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
