#!/bin/bash

echo "🃏 Poker GTO Bot API Test Script"
echo "================================"
echo ""

# Check if server is running
if ! curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "⚠️  Server is not running. Starting server..."
    echo ""
    echo "Please run in another terminal:"
    echo "  bun run index.ts"
    echo ""
    echo "Then run this script again."
    exit 1
fi

echo "✅ Server is running"
echo ""

# Test health endpoint
echo "Testing GET /api/health..."
curl -s http://localhost:3000/api/health | jq .
echo ""
echo ""

# Test root endpoint
echo "Testing GET /..."
curl -s http://localhost:3000/ | jq .
echo ""
echo ""

# Test solve endpoint with sample data
echo "Testing POST /api/solve with sample data..."
curl -s -X POST http://localhost:3000/api/solve \
  -H "Content-Type: application/json" \
  -d @examples/sample-request.json | jq .
echo ""
echo ""

# Test with invalid data to check validation
echo "Testing POST /api/solve with invalid data (should fail)..."
curl -s -X POST http://localhost:3000/api/solve \
  -H "Content-Type: application/json" \
  -d '{
    "hero": {
      "position": "INVALID",
      "holding": ["As"]
    }
  }' | jq .
echo ""
echo ""

echo "✅ Tests complete!"
