#!/bin/bash
# Build all NanoClaw container images
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Detect container runtime: prefer Docker if available, fall back to Apple Container
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    RUNTIME="docker"
elif command -v container &>/dev/null; then
    RUNTIME="container"
else
    echo "Error: No container runtime found. Install Docker or Apple Container."
    exit 1
fi

echo "=== Building NanoClaw Container Images ==="
echo "Using runtime: ${RUNTIME}"
echo ""

# Build Claude container
echo "Building Claude container (nanoclaw-agent:latest)..."
$RUNTIME build -t nanoclaw-agent:latest -f Dockerfile .
echo "Claude container built"
echo ""

# Build Gemini container
echo "Building Gemini container (nanoclaw-agent-gemini:latest)..."
$RUNTIME build -t nanoclaw-agent-gemini:latest -f Dockerfile.gemini .
echo "Gemini container built"
echo ""

echo "=== Build Complete ==="
echo ""
echo "Available images:"
$RUNTIME images | grep nanoclaw-agent
