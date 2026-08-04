# Quick Start Guide

Get up and running with the Poker GTO Bot API in minutes!

## Step 1: Install Prerequisites

Make sure you have the following installed:
- [Bun](https://bun.sh) - JavaScript runtime
- CMake - For building the solver
- C++ compiler (clang/g++)

**macOS:**
```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install CMake
brew install cmake
```

## Step 2: Install Dependencies

```bash
bun install
```

## Step 3: Build the Solver

```bash
./setup.sh
```

This compiles the TexasSolver C++ binary. It may take a few minutes.

## Step 4: Start the API Server

```bash
bun run start
```

The server will start on `http://localhost:2000`.

## Step 5: Test the API

In another terminal, run:

```bash
# Health check
curl http://localhost:2000/api/health

# Solve a poker hand
curl -X POST http://localhost:2000/api/solve \
  -H "Content-Type: application/json" \
  -d @examples/sample-request.json
```

## Example API Request

```json
{
  "hero": {
    "position": "BTN",
    "holding": ["As", "Kh"]
  },
  "players": [
    {
      "position": "OOP",
      "stack": 100,
      "range": "AA,KK,QQ,JJ,TT,99,88,AKs,AQs",
      "committed": 5
    },
    {
      "position": "IP",
      "stack": 100,
      "range": "AA,KK,QQ,JJ,TT,99,88,AKs,AQs",
      "committed": 5
    }
  ],
  "board": {
    "flop": ["Qs", "Jh", "2h"]
  },
  "pot": 10,
  "effectiveStack": 95,
  "actionHistory": [],
  "currentStreet": "flop",
  "gameType": "holdem"
}
```

## Running Tests

```bash
# Test schema validation
bun run src/test/schema-validation.test.ts

# Test command generator
bun run src/test/command-generator.test.ts
```

## Troubleshooting

### "Solver binary not found"
Run `./setup.sh` to build the solver.

### "CMake not found"
Install CMake using your package manager:
- macOS: `brew install cmake`
- Ubuntu: `sudo apt-get install cmake build-essential`

### "Port already in use"
Change the port by setting the `PORT` environment variable:
```bash
PORT=3000 bun run start
```

## Next Steps

- Read the full [README.md](README.md) for detailed documentation
- Customize bet sizing in your requests
- Adjust solver accuracy and performance settings
- Integrate the API into your poker application

## Support

For issues or questions:
- Check the [README.md](README.md) for detailed documentation
- Review the [TexasSolver documentation](https://github.com/bupticybee/TexasSolver)
- Open an issue in this repository

Happy solving! 🃏
