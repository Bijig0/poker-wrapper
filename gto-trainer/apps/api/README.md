# Poker GTO Bot API

A Bun TypeScript API for analyzing No-Limit Hold'em poker hands using Game Theory Optimal (GTO) strategies. Powered by the [TexasSolver](https://github.com/bupticybee/TexasSolver) C++ solver.

## Features

- RESTful API for GTO poker analysis
- Zod schema validation for all inputs
- Support for full game state representation
- Action history tracking
- Customizable solver parameters
- Support for both Hold'em and Short Deck variants

## Prerequisites

- [Bun](https://bun.sh) v1.0 or higher
- CMake (for building TexasSolver)
- C++ compiler (g++, clang, or MSVC)

### Installing Prerequisites

**macOS:**
```bash
brew install cmake
```

**Ubuntu/Debian:**
```bash
sudo apt-get install cmake build-essential
```

**Fedora/RHEL:**
```bash
sudo dnf install cmake gcc-c++
```

## Installation

1. Clone the repository (if not already done):
```bash
git clone <your-repo-url>
cd poker-gto-bot
```

2. Install Bun dependencies:
```bash
bun install
```

3. Build the TexasSolver binary:
```bash
./setup.sh
```

This will compile the TexasSolver C++ binary and set up the required directories.

## Usage

### Start the API Server

```bash
bun run index.ts
```

The server will start on `http://localhost:2000` by default.

#### Configure Port

You can change the port using the `PORT` environment variable:

```bash
PORT=3000 bun run index.ts
```

Or create a `.env` file:
```bash
PORT=3000
```

### API Endpoints

#### `GET /`
Returns API information and available endpoints.

#### `GET /api/health`
Health check endpoint.

#### `POST /api/solve`
Analyze a poker game state and return GTO decision.

**Request Body:**
```json
{
  "hero": {
    "position": "BTN",
    "holding": ["As", "Kh"]
  },
  "players": [
    {
      "position": "BB",
      "stack": 100,
      "range": "AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AKo,AQs,AQo,AJs,AJo,ATs,KQs,KQo,KJs,KTs,QJs,QTs,JTs",
      "committed": 1
    },
    {
      "position": "BTN",
      "stack": 100,
      "range": "AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AKo,AQs,AQo,AJs,AJo,ATs,KQs,KJs,KTs,QJs",
      "committed": 0
    }
  ],
  "board": {
    "flop": ["Qs", "Jh", "2h"]
  },
  "pot": 10,
  "effectiveStack": 95,
  "actionHistory": [
    {
      "position": "BB",
      "actionType": "bet",
      "amount": 5,
      "street": "flop"
    }
  ],
  "currentStreet": "flop",
  "gameType": "holdem",
  "solverConfig": {
    "accuracy": 0.3,
    "maxIterations": 100,
    "threadCount": 4,
    "useIsomorphism": true
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "recommendedActions": [
      {
        "action": "raise",
        "amount": 15,
        "frequency": 0.75,
        "ev": 12.5
      },
      {
        "action": "call",
        "frequency": 0.15,
        "ev": 10.2
      },
      {
        "action": "fold",
        "frequency": 0.10,
        "ev": 0
      }
    ],
    "equity": 0.65,
    "exploitability": 0.15,
    "strategy": {
      "raise": 0.75,
      "call": 0.15,
      "fold": 0.10
    }
  }
}
```

## Schema Documentation

### Card Format
Cards are represented as two-character strings: rank + suit
- Ranks: `2, 3, 4, 5, 6, 7, 8, 9, T, J, Q, K, A`
- Suits: `h (hearts), d (diamonds), c (clubs), s (spades)`
- Examples: `"As"` (Ace of spades), `"Kh"` (King of hearts), `"Tc"` (Ten of clubs)

### Positions
Available positions:
- `UTG, UTG1, UTG2, LJ, HJ, CO, BTN, SB, BB`
- Generic: `OOP` (out of position), `IP` (in position)

### Streets
- `preflop, flop, turn, river`

### Action Types
- `fold` - Fold hand
- `check` - Check (no bet)
- `call` - Call current bet
- `bet` - Make a bet
- `raise` - Raise current bet
- `allin` - Go all-in

### Range Format
Ranges use TexasSolver format:
- Hand combos: `AA, KK, QQ, AKs, AKo`
- With weights: `99:0.75, AQo:0.5` (75% and 50% frequency)
- Example: `"AA,KK,QQ,JJ,AKs,AKo:0.75,AQs,KQs"`

### Solver Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| accuracy | number | 0.3 | Solver accuracy (lower = more accurate but slower) |
| maxIterations | number | 20 | Maximum solver iterations (increase for more accuracy) |
| threadCount | number | 4 | Number of CPU threads to use |
| useIsomorphism | boolean | true | Use isomorphic card removal (speeds up solving) |
| allinThreshold | number | 0.67 | Stack-to-pot ratio threshold for all-in |

## Example Requests

All examples are **heads-up (2-player)** No-Limit Hold'em scenarios.

### Example 1: BTN C-Bet Decision
**Hero:** As Kh on BTN after raising preflop
**Board:** Qs Jh 2h
**Situation:** BB checks to you on the flop. What's the GTO play?

```bash
curl -X POST http://localhost:2000/api/solve \
  -H "Content-Type: application/json" \
  -d @examples/sample-request.json
```

### Example 2: Facing River Bet
**Hero:** Kd Qd in BB (two pair on river)
**Board:** Kh Tc 5s 3d Qc
**Situation:** BTN bets river. Call, raise, or fold?

```bash
curl -X POST http://localhost:2000/api/solve \
  -H "Content-Type: application/json" \
  -d @examples/heads-up-river-decision.json
```

### Example 3: Facing 3-Bet Preflop
**Hero:** Ac Js on BTN
**Situation:** You raised, BB 3-bet. 4-bet, call, or fold?

```bash
curl -X POST http://localhost:2000/api/solve \
  -H "Content-Type: application/json" \
  -d @examples/heads-up-facing-3bet.json
```

### Example 4: Check-Raise Opportunity
**Hero:** 9c 8c in BB (open-ended straight draw)
**Board:** Jc Th 7d
**Situation:** You checked, BTN bet. Check-raise or call?

```bash
curl -X POST http://localhost:2000/api/solve \
  -H "Content-Type: application/json" \
  -d @examples/heads-up-check-raise.json
```

### Example 5: Donk Bet Decision
**Hero:** Ah 5h in BB (two pair)
**Board:** As 5c 2d
**Situation:** BTN raised preflop. Lead out (donk) or check?

```bash
curl -X POST http://localhost:2000/api/solve \
  -H "Content-Type: application/json" \
  -d @examples/heads-up-donk-bet.json
```

### Additional Examples

All example files in `examples/` directory:
- `sample-request.json` - Basic flop c-bet
- `heads-up-flop-cbet.json` - Top pair flop decision
- `heads-up-3bet-pot.json` - QQ facing Ace-high flop
- `heads-up-turn-bluff.json` - Gutshot on turn
- `heads-up-river-value.json` - AA on river
- `heads-up-facing-bet.json` - JT with OESD facing bet
- `heads-up-river-decision.json` - Two pair facing river bet
- `heads-up-facing-3bet.json` - AJ facing 3-bet
- `heads-up-check-raise.json` - Drawing hand
- `heads-up-donk-bet.json` - Leading with two pair

### Legacy Example 2: Turn Decision
```json
{
  "hero": {
    "position": "IP",
    "holding": ["Qd", "Qc"]
  },
  "players": [
    {
      "position": "OOP",
      "stack": 200,
      "range": "AA,KK,QQ,JJ,TT,AKs,AQs,KQs",
      "committed": 10
    },
    {
      "position": "IP",
      "stack": 200,
      "range": "AA,KK,QQ,JJ,TT,99,88,AKs,AQs,AJs,KQs",
      "committed": 10
    }
  ],
  "board": {
    "flop": ["Ah", "Kh", "3c"],
    "turn": "Qs"
  },
  "pot": 50,
  "effectiveStack": 180,
  "currentStreet": "turn",
  "actionHistory": [
    {
      "position": "OOP",
      "actionType": "check",
      "street": "turn"
    }
  ],
  "gameType": "holdem"
}
```

## Project Structure

```
poker-gto-bot/
├── src/
│   ├── schemas/
│   │   └── poker.ts          # Zod schemas for validation
│   ├── services/
│   │   ├── commandGenerator.ts   # Convert game state to solver commands
│   │   └── solverService.ts      # Execute solver and parse results
│   └── routes/
│       └── solver.ts         # API route handlers
├── examples/
│   └── sample-request.json   # Example API request
├── gto-source/               # TexasSolver C++ source code
├── temp/                     # Temporary files (auto-created)
├── index.ts                  # Main API server
├── setup.sh                  # Build script for TexasSolver
└── README.md
```

## Development

### Type Safety
All schemas are defined using Zod and automatically infer TypeScript types:
```typescript
import type { PokerGameState, GTODecision } from "./src/schemas/poker";
```

### Adding Custom Bet Sizes
You can specify custom bet sizing in your request:
```json
{
  "betSizes": [
    {
      "position": "oop",
      "street": "flop",
      "actionType": "bet",
      "size": 75
    },
    {
      "position": "ip",
      "street": "flop",
      "actionType": "raise",
      "size": 200
    }
  ]
}
```

## Troubleshooting

### Solver Binary Not Found
If you get an error about the solver binary not being found:
```bash
./setup.sh
```

### CMake Not Found
Install CMake using your package manager (see Prerequisites section).

### Out of Memory
For large game trees, the solver may require significant memory. Try:
- Reducing the number of bet sizes
- Increasing the accuracy parameter (faster but less accurate)
- Simplifying player ranges

## Performance Tips

1. **Use Isomorphism**: Keep `useIsomorphism: true` for faster solving
2. **Adjust Accuracy**: Use 0.5-1.0 for quick estimates, 0.1-0.3 for production
3. **Limit Bet Sizes**: Fewer bet sizes = faster solving
4. **Simplify Ranges**: More focused ranges solve faster

## License

This project integrates with TexasSolver, which is licensed under [GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.en.html).

## Credits

- [TexasSolver](https://github.com/bupticybee/TexasSolver) by bupticybee
- Built with [Bun](https://bun.sh)
- API framework: [Hono](https://hono.dev)
- Validation: [Zod](https://zod.dev)

## Contributing

Contributions are welcome! Please ensure:
- All schemas are properly validated with Zod
- Code follows TypeScript best practices
- API responses match the documented schemas

## Support

For issues related to:
- **This API**: Open an issue in this repository
- **TexasSolver**: Visit [TexasSolver repository](https://github.com/bupticybee/TexasSolver)


## Preflop pieces of the Ignition 200NL Ring 6-max strategy (2026-09-19)

| order | piece | registry id | answers.sqlite `source` / `tier` | what it answers |
|---|---|---|---|---|
| 1 | HRC 6-max NL200 ring charts | `hrc-6max` | `hrc-6max-preflop` / `chart-6max` | 4–6 seats, the solved size ladder, 30–150 bb — instant, our own rake |
| 2 | **GTO Wizard AI preflop (Ultra)** | `gtow-ai-preflop` | `gtow-ai-preflop` / `ai-preflop` | everything the charts cannot: a table thinned to 2–5 seats, a size off the tree, a stack past the ladder, a limped pot, a straddle — solved live in GTO Wizard's cloud from the ACTUAL table |

The fallback (`src/services/gtowAiPreflop.ts`, hand-off in `fastSolve.ts`'s 6-max branch) builds one custom preflop tree per table shape — live stacks, blinds as posted, Ignition's rake for the players dealt (5%, cap $1/$2/$3/$4 at 2/3/4-5/6+), our size menu (opens 2x 2.2x 2.5x 3x 3.5x · 3-bets 3.2x 3.8x 4.5x · 4-bets 2.2x 2.6x) plus every size the line actually contains — solves it (2–4 s), walks the line (`F` / `C` / `X` / `R<bb>`), and reads hero's exact combo from the node. Shapes are cached; a 2–5 seat table is pre-built from the poller's tick so hero's turn only pays the node fetch (1–2 s). The hand page's "Where the answers came from" names it, the Sources tab has its card, and the strategy's preflop layer declares it as `fallbackSource`.

API limits that shape it (probed 2026-09-19): multiway trees need fixed size menus; positions are fixed sets by player count; limps = one non-SB limper + the SB complete (a second limper is not modelled); a dead small blind cannot be expressed (approximated as a seat holding its blind, flagged `approx`); 3-way postflop exists (`OOP`/`OOP+1`/`IP`) but 4+ does not. Token comes from the dedicated-profile Chrome on CDP 9222 (`scripts/start_gtow_chrome.ps1`).
