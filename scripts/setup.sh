#!/bin/bash
set -e

echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║       Blueprint Setup            ║"
echo "  ╚══════════════════════════════════╝"
echo ""

# Check for Bun
if ! command -v bun >/dev/null 2>&1; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Copy .env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✓ Created .env from .env.example"
fi

# Generate encryption key if placeholder
if grep -q "replace-with-64-char" .env 2>/dev/null; then
  KEY=$(node scripts/generate-key.js 2>/dev/null || bun scripts/generate-key.js)
  if [ -n "$KEY" ]; then
    sed -i.bak "s/replace-with-64-char-hex-string-generated-by-openssl-rand-hex-32/$KEY/" .env
    rm -f .env.bak
    echo "✓ Generated encryption key"
  fi
fi

# Generate session secret if placeholder
if grep -q "replace-with-another-64-char" .env 2>/dev/null; then
  SECRET=$(node scripts/generate-key.js 2>/dev/null || bun scripts/generate-key.js)
  if [ -n "$SECRET" ]; then
    sed -i.bak "s/replace-with-another-64-char-hex-string-for-session-signing/$SECRET/" .env
    rm -f .env.bak
    echo "✓ Generated session secret"
  fi
fi

# Install dependencies
echo "Installing server dependencies..."
cd server && bun install --silent 2>/dev/null || bun install
cd ..

echo "Installing client dependencies..."
cd client && bun install --silent 2>/dev/null || bun install
cd ..

# Init database
echo "Initialising database..."
cd server && bun run db/init.js
cd ..

# Build client
echo "Building frontend..."
cd client && bun run build
cd ..

echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║       Setup Complete! ✓          ║"
echo "  ╚══════════════════════════════════╝"
echo ""
echo "  Next steps:"
echo ""
echo "    1. Configure your LLM provider in .env"
echo "       Ollama (free, local — no API key needed):"
echo "         Install: https://ollama.ai"
echo "         Run: ollama pull llama3"
echo "       Or add an API key: Anthropic, OpenAI, or Gemini"
echo "       See .env.example for all options."
echo ""
echo "    2. Start Blueprint:"
echo "       cd server && bun index.js"
echo ""
echo "    3. Open http://localhost:4000"
echo ""
