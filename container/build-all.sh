#!/bin/bash
# Build all NanoClaw container images
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Building NanoClaw Container Images ==="
echo ""

# Build Claude container
echo "Building Claude container (nanoclaw-agent:latest)..."
docker build -t nanoclaw-agent:latest -f Dockerfile .
echo "✓ Claude container built"
echo ""

# Build Gemini container
echo "Building Gemini container (nanoclaw-agent-gemini:latest)..."
docker build -t nanoclaw-agent-gemini:latest -f Dockerfile.gemini .
echo "✓ Gemini container built"
echo ""

echo "=== Build Complete ==="
echo ""
echo "Available images:"
docker images | grep nanoclaw-agent
