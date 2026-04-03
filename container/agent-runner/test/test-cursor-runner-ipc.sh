#!/bin/bash
# Offline test for cursor-runner.ts Stage 2: IPC follow-ups and session resume
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

# Create IPC directory
mkdir -p "$IPC_DIR"

echo "=== Compiling TypeScript ==="
cd "$RUNNER_DIR"
npx tsc --outDir "$DIST_DIR" 2>&1
ln -sf "$RUNNER_DIR/node_modules" "$DIST_DIR/node_modules"

echo "=== Running cursor-runner with IPC follow-up ==="
INPUT='{"prompt":"initial prompt","groupFolder":"test","chatJid":"test@test","isMain":false}'

# Override IPC_INPUT_DIR by patching the compiled JS (it's hardcoded to /workspace/ipc/input)
sed -i "s|/workspace/ipc/input|$IPC_DIR|g" "$DIST_DIR/cursor-runner.js"

# Run cursor-runner in background
echo "$INPUT" | node "$DIST_DIR/cursor-runner.js" >"$DIST_DIR/stdout.txt" 2>"$STDERR_FILE" &
PID=$!

# Wait for first response (poll stdout for first OUTPUT_END marker)
for i in $(seq 1 20); do
  if grep -q "NANOCLAW_OUTPUT_END" "$DIST_DIR/stdout.txt" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

echo "=== First response received ==="

# Drop a follow-up IPC message
echo '{"type":"message","text":"follow up message"}' > "$IPC_DIR/001-followup.json"
echo "Dropped IPC follow-up message"

# Wait for second response
for i in $(seq 1 20); do
  MARKER_COUNT=$(grep -c "NANOCLAW_OUTPUT_END" "$DIST_DIR/stdout.txt" 2>/dev/null || true)
  if [ "$MARKER_COUNT" -ge 3 ]; then  # initial result + session update + follow-up result
    break
  fi
  sleep 0.5
done

echo "=== Second response received ==="

# Send _close sentinel
touch "$IPC_DIR/_close"
echo "Sent _close sentinel"

# Wait for process to exit
wait $PID 2>/dev/null || true

echo ""
echo "=== STDOUT ==="
cat "$DIST_DIR/stdout.txt"
echo ""
echo "=== STDERR ==="
cat "$STDERR_FILE"
echo ""

# Validate
PASS=0
FAIL=0
OUTPUT=$(cat "$DIST_DIR/stdout.txt")
ERROUT=$(cat "$STDERR_FILE")

check_stdout() {
  if echo "$OUTPUT" | grep -q "$1"; then
    echo "PASS: $2"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $2 (looking for: $1)"
    FAIL=$((FAIL + 1))
  fi
}

check_stderr() {
  if echo "$ERROUT" | grep -q "$1"; then
    echo "PASS: $2"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $2 (looking for: $1)"
    FAIL=$((FAIL + 1))
  fi
}

check_stdout "Response 1 from mock cursor agent" "first response received"
check_stdout "Response 2 from mock cursor agent" "second response received (follow-up)"
check_stderr "\-\-resume mock-session-1" "second invocation uses --resume with first session ID"
check_stderr "Close sentinel" "clean exit on _close sentinel"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
