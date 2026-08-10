#!/bin/bash
# Smart Home AI Control Panel - Start Script

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=================================================="
echo "  Smart Home AI Control Panel"
echo "=================================================="

# Check dependencies
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Please install Node.js >= 14"
  exit 1
fi

if ! command -v ffmpeg &> /dev/null; then
  echo "❌ ffmpeg not found. Please install ffmpeg"
  echo "   macOS: brew install ffmpeg"
  exit 1
fi

# Check config
if [ ! -f "$PROJECT_DIR/config.json" ]; then
  echo "❌ config.json not found"
  exit 1
fi

# Kill existing process
pkill -f "node.*server.js" 2>/dev/null
sleep 1

# Create snapshots directory
mkdir -p "$PROJECT_DIR/snapshots"

# Start server
cd "$PROJECT_DIR"
echo "🚀 Starting server..."
node server.js &
SERVER_PID=$!

sleep 2

# Check if server started successfully
if kill -0 $SERVER_PID 2>/dev/null; then
  PORT=$(python3 -c "import json; print(json.load(open('config.json'))['server']['port'])" 2>/dev/null || echo "8090")
  echo ""
  echo "✅ Server started successfully!"
  echo ""
  echo "   🌐 Dashboard: http://localhost:${PORT}"
  echo "   📷 Snapshot:  http://localhost:${PORT}/api/snapshot"
  echo "   🧠 Analysis:  http://localhost:${PORT}/api/analysis"
  echo ""
  echo "   PID: $SERVER_PID"
  echo "   Stop: kill $SERVER_PID"
  echo "=================================================="
else
  echo "❌ Server failed to start"
  exit 1
fi
