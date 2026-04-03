#!/bin/bash
# Real Cursor agent test with session resume via IPC
# Requires CURSOR_API_KEY in .env
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DIST_DIR=$(mktemp -d)
IPC_DIR=$(mktemp -d)/ipc/input

trap "rm -rf $DIST_DIR $(dirname $(dirname $IPC_DIR))" EXIT

# Load .env
source "$PROJECT_ROOT/.env" 2>/dev/null || true
if [ -z "$CURSOR_API_KEY" ]; then
  echo "CURSOR_API_KEY not set in .env, skipping real test"
  exit 0
fi

mkdir -p "$IPC_DIR"

echo "=== Compiling ==="
cd "$RUNNER_DIR"
npx tsc --outDir "$DIST_DIR" 2>&1
ln -sf "$RUNNER_DIR/node_modules" "$DIST_DIR/node_modules"
sed -i "s|/workspace/ipc/input|$IPC_DIR|g" "$DIST_DIR/cursor-runner.js"

echo "=== Starting cursor-runner (turn 1: remember a number) ==="
INPUT="{\"prompt\":\"Remember the number 42. Just say OK.\",\"groupFolder\":\"test\",\"chatJid\":\"test@test\",\"isMain\":false,\"secrets\":{\"CURSOR_API_KEY\":\"$CURSOR_API_KEY\"}}"

echo "$INPUT" | node "$DIST_DIR/cursor-runner.js" >"$DIST_DIR/stdout.txt" 2>"$DIST_DIR/stderr.txt" &
PID=$!

# Wait for first response
for i in $(seq 1 60); do
  if grep -q "NANOCLAW_OUTPUT_END" "$DIST_DIR/stdout.txt" 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "=== Turn 1 response ==="
cat "$DIST_DIR/stdout.txt"
echo ""

# Send follow-up via IPC
echo '{"type":"message","text":"What number did I ask you to remember? Reply with just the number."}' > "$IPC_DIR/001.json"
echo "=== Sent follow-up IPC message ==="

# Wait for second response
for i in $(seq 1 60); do
  COUNT=$(grep -c "NANOCLAW_OUTPUT_END" "$DIST_DIR/stdout.txt" 2>/dev/null || true)
  if [ "$COUNT" -ge 2 ]; then
    break
  fi
  sleep 1
done

echo "=== Turn 2 response ==="
cat "$DIST_DIR/stdout.txt"
echo ""

# Clean exit
touch "$IPC_DIR/_close"
wait $PID 2>/dev/null || true

echo "=== STDERR ==="
cat "$DIST_DIR/stderr.txt"
echo ""

# Check results
if grep -q '"status":"success"' "$DIST_DIR/stdout.txt" && grep -q "42" "$DIST_DIR/stdout.txt"; then
  echo "PASS: Agent remembered 42 across sessions"
elif grep -q '"status":"success"' "$DIST_DIR/stdout.txt"; then
  echo "PARTIAL: Agent responded but may not have remembered 42 (check output above)"
else
  echo "FAIL: No successful response"
  exit 1
fi

if grep -q "\-\-resume" "$DIST_DIR/stderr.txt"; then
  echo "PASS: Second turn used --resume"
else
  echo "FAIL: Second turn did not use --resume"
  exit 1
fi
