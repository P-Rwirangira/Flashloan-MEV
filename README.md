# Base MEV Platform

A flash-loan-native MEV platform dedicated to Base blockchain, targeting low-competition, low-capital strategies with maximal gas efficiency and atomic execution.

## Features

### Phase 1 (MVP) - Cross-DEX Arbitrage
- Real-time monitoring of Uniswap V3 and Aerodrome pools on Base
- Flash loan execution via Uniswap V3 pools
- Direct pool swaps to minimize gas costs
- Private transaction submission to avoid MEV theft
- Comprehensive profit validation and safety checks

### Phase 2 - Liquidations
- Health factor monitoring on Moonwell, Aave V3, and Seamless protocols
- Flash-borrowed liquidation execution
- Optimal collateral selling routes

### Phase 3 - Stable Pool Rebalancing
- Aerodrome stable pool imbalance detection
- Flash-borrowed rebalancing execution
- Incentivized pool prioritization

## Architecture

The platform consists of modular components:

- **Scanner**: Real-time blockchain monitoring for opportunities
- **Simulator**: Pre-execution validation using forked state
- **Bundler**: Private transaction submission with bribe optimization
- **Flash Executor**: On-chain contract for atomic arbitrage execution
- **Monitoring**: Comprehensive metrics and alerting system

## Quick Start

### Prerequisites

- Node.js 18+
- Local Base node (op-geth + op-node) or RPC access
- Private keys for transaction signing

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd base-mev-platform

# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env

# Edit configuration
nano .env
nano config/default.yaml
```

### Development

```bash
# Start in development mode
npm run dev

# Build for production
npm run build

# Run tests
npm test

# Lint and format
npm run lint
npm run format
```

### Configuration

Edit `config/default.yaml` to configure:
- Network endpoints and fallbacks
- Strategy parameters (min profit, slippage, gas limits)
- Pool allowlists for safety
- Private relay settings
- Monitoring and alerting thresholds

## Development

### Project Structure

```
src/
├── index.ts              # Application entry point
├── types/                # TypeScript type definitions
├── config/               # Configuration management
├── scanner/              # Opportunity detection
├── simulator/            # Pre-execution validation
├── bundler/              # Transaction submission
├── rpc/                  # Blockchain connections
├── contracts/            # Smart contract interfaces
├── monitoring/           # Metrics and alerting
└── utils/                # Common utilities
```

### Code Quality

The project uses:
- **TypeScript** for type safety
- **ESLint** for code linting
- **Prettier** for code formatting
- **Husky** for git hooks
- **Jest** for testing

### Commit Convention

Use conventional commits focusing on features:
- `chore: Initial project setup`
- `feat: Add arbitrage opportunity detection`
- `feat: Implement flash loan execution`
- `test: Add profit calculation tests`
- `fix: Handle RPC connection failures`

## Security

- All transactions use private relays to avoid MEV theft
- On-chain profit validation prevents unprofitable execution
- Allowlisted pools and tokens for safety
- Reentrancy protection in smart contracts
- Comprehensive error handling and circuit breakers

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with proper tests
4. Ensure all checks pass
5. Submit a pull request

## Disclaimer

This software is for educational and research purposes. Use at your own risk. MEV extraction may be subject to legal and regulatory restrictions in your jurisdiction.