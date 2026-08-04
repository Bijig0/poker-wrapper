#!/bin/bash

echo "🃏 Poker GTO Bot Setup Script"
echo "=============================="
echo ""

# Check if cmake is installed
if ! command -v cmake &> /dev/null; then
    echo "❌ CMake is not installed."
    echo "Please install CMake first:"
    echo ""
    echo "macOS:   brew install cmake"
    echo "Ubuntu:  sudo apt-get install cmake build-essential"
    echo "Fedora:  sudo dnf install cmake gcc-c++"
    echo ""
    exit 1
fi

echo "✅ CMake found"

# Check if we're in console branch
cd gto-source
CURRENT_BRANCH=$(git branch --show-current)

if [ "$CURRENT_BRANCH" != "console" ]; then
    echo "⚠️  Switching to console branch..."
    git checkout console
fi

echo "✅ On console branch"

# Create build directory
echo "📁 Creating build directory..."
mkdir -p build
cd build

# Run CMake
echo "🔧 Running CMake configuration..."
cmake ..

if [ $? -ne 0 ]; then
    echo "❌ CMake configuration failed"
    exit 1
fi

# Build the project
echo "🔨 Building TexasSolver (this may take a few minutes)..."
make

if [ $? -ne 0 ]; then
    echo "❌ Build failed"
    exit 1
fi

echo ""
echo "✅ TexasSolver built successfully!"
echo ""

# Go back to root
cd ../..

# Create temp directory
mkdir -p temp

echo "✅ Setup complete!"
echo ""
echo "You can now run the API server with:"
echo "  bun run index.ts"
echo ""
echo "Test the API with:"
echo "  curl http://localhost:3000/api/health"
echo ""
