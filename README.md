# Base MEV Platform

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-363636?style=flat&logo=solidity&logoColor=white)](https://soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/Hardhat-2.28-FFF100?style=flat&logo=hardhat&logoColor=black)](https://hardhat.org/)
[![ethers.js](https://img.shields.io/badge/ethers.js-6.8-2535A0?style=flat&logo=ethereum&logoColor=white)](https://docs.ethers.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[![Base](https://img.shields.io/badge/Base-Mainnet-0052FF?style=flat&logo=coinbase&logoColor=white)](https://base.org/)
[![Uniswap V3](https://img.shields.io/badge/Uniswap-V3-FF007A?style=flat&logo=uniswap&logoColor=white)](https://uniswap.org/)
[![Aerodrome](https://img.shields.io/badge/Aerodrome-DEX-00D4AA?style=flat)](https://aerodrome.finance/)

[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-Supported-326CE5?style=flat&logo=kubernetes&logoColor=white)](https://kubernetes.io/)
[![Jest](https://img.shields.io/badge/Jest-Testing-C21325?style=flat&logo=jest&logoColor=white)](https://jestjs.io/)

A flash-loan-native MEV platform dedicated to Base blockchain, targeting low-competition, low-capital strategies with maximal gas efficiency and atomic execution.

## Features

### Phase 1 (MVP) - Cross-DEX Arbitrage ![Status](https://img.shields.io/badge/Status-Active-success)
- Real-time monitoring of Uniswap V3 and Aerodrome pools on Base
- Flash loan execution via Uniswap V3 pools
- Direct pool swaps to minimize gas costs
- Private transaction submission to avoid MEV theft
- Comprehensive profit validation and safety checks
- **Zero RPC Polling** - DexScreener WebSocket integration

### Phase 2 - Liquidations ![Status](https://img.shields.io/badge/Status-In_Development-yellow)
- Health factor monitoring on Moonwell, Aave V3, and Seamless protocols
- Flash-borrowed liquidation execution
- Optimal collateral selling routes

### Phase 3 - Stable Pool Rebalancing ![Status](https://img.shields.io/badge/Status-Planned-blue)
- Aerodrome stable pool imbalance detection
- Flash-borrowed rebalancing execution
- Incentivized pool prioritization

## Architecture

The platform consists of modular components:

- **Scanner** ![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white): Real-time blockchain monitoring for opportunities
  - Zero RPC polling via DexScreener WebSocket
  - Multi-DEX support (Uniswap V3, Aerodrome)
  - Dynamic pool discovery and validation
  
- **Simulator** ![ethers.js](https://img.shields.io/badge/-ethers.js-2535A0?style=flat-square&logo=ethereum&logoColor=white): Pre-execution validation using forked state
  - Profit calculation with gas estimation
  - Slippage and price impact analysis
  - Multi-route optimization
  
- **Bundler** ![MEV](https://img.shields.io/badge/-MEV_Protected-FF6B6B?style=flat-square): Private transaction submission with bribe optimization
  - Flashbots & bloXroute relay support
  - Dynamic bribe calculation
  - Multi-relay failover
  
- **Flash Executor** ![Solidity](https://img.shields.io/badge/-Solidity-363636?style=flat-square&logo=solidity&logoColor=white): On-chain contract for atomic arbitrage execution
  - Flash loan integration
  - Reentrancy protection
  - Owner-only execution
  
- **Monitoring** ![Prometheus](https://img.shields.io/badge/-Prometheus-E6522C?style=flat-square&logo=prometheus&logoColor=white): Comprehensive metrics and alerting system
  - Health checks & circuit breakers
  - Performance metrics
  - Alert dispatch (webhook, email, Slack)

## Quick Start

### Prerequisites

![Requirements](https://img.shields.io/badge/Requirements-Check_List-orange?style=flat)

- **Node.js 18+** - JavaScript runtime
- **RPC Access** - Base mainnet RPC (Alchemy/Infura recommended)
- **Private Keys** - For transaction signing (dedicated wallet)
- **API Keys** - bloXroute or Flashbots for private relays
- **Docker** (optional) - For containerized deployment
- **Base Node** (optional) - Local op-geth + op-node for lower latency

### Installation


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
# Type check
npm run typecheck

# Build for production
npm run build

# Start in development mode
npm run dev

# Run tests
npm test

# Lint and format
npm run lint
npm run format
```

**Available Scripts:**

| Command | Description | Purpose |
|---------|-------------|---------|
| `npm run dev` | Interactive menu | Choose strategy to run |
| `npm run dexscreener` | DexScreener runner | Zero-RPC arbitrage monitoring |
| `npm run dev:direct` | Direct start | Start with watch mode |
| `npm run build` | Build project | Compile TypeScript to JS |
| `npm run test` | Run tests | Execute Jest test suite |
| `npm run typecheck` | Type checking | Validate TypeScript types |
| `npm run deploy:testnet` | Deploy contracts | Deploy to Base Sepolia |
| `npm run deploy:mainnet` | Deploy contracts | Deploy to Base Mainnet |
| `npm run relay:test` | Test relays | Verify relay connectivity |
| `npm run testing:enable-paper` | Paper trading | Enable simulation mode |
| `npm run testing:enable-live` | Micro-live | Enable small trades |

### Docker Deployment ![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat&logo=docker)

```bash
# Build and start all services
docker-compose up -d

# Check health
curl http://localhost:3002/health

# View logs
docker-compose logs -f base-mev-platform
```

**Services Included:**

| Service | Port | Purpose |
|---------|------|---------|
| `base-mev-platform` | 3001, 3002 | Main MEV bot |
| `prometheus` | 9090 | Metrics collection |
| `grafana` | 3000 | Metrics visualization |
| `redis` | 6379 | Cache & state storage |

**Container Features:**
- Multi-stage build for small image size
- Health checks for orchestration
- Auto-restart on failure
- Volume mounts for logs and config
- Non-root user for security

## Documentation

- **[API Reference](docs/API.md)** - Health check and metrics endpoints
- **[Operations Guide](docs/OPERATIONS.md)** - Monitoring, troubleshooting, and maintenance
- **[Deployment Guide](docs/DEPLOYMENT.md)** - Local, Docker, and Kubernetes deployment

### Health Monitoring ![Monitoring](https://img.shields.io/badge/Monitoring-Enabled-success?style=flat&logo=prometheus)

The platform exposes health check endpoints:

| Endpoint | Purpose | K8s Support |
|----------|---------|-------------|
| `GET /health` | Comprehensive health status | Yes |
| `GET /ready` | Readiness probe | Kubernetes |
| `GET /live` | Liveness probe | Kubernetes |
| `GET /metrics` | Prometheus metrics | Yes |
| `GET /status` | Simple status check | Yes |

Default health check port: **3002** (configurable via `HEALTH_CHECK_PORT`)

**Metrics Available:**
- Opportunities detected/validated/executed
- Transaction success/failure rates
- Profit and loss tracking
- Latency and performance metrics
- RPC connection health

### Configuration ![Config](https://img.shields.io/badge/Config-YAML-red?style=flat)

Edit `config/default.yaml` to configure:

| Category | Settings | Purpose |
|----------|----------|---------|
| **Network** | RPC URLs, fallbacks, chain ID | Connection management |
| **Strategies** | Min profit, slippage, gas limits | Trading parameters |
| **Security** | Pool/token allowlists | Safety controls |
| **Relays** | Flashbots, bloXroute endpoints | Private submission |
| **Monitoring** | Metrics, alerts, circuit breakers | Observability |
| **Performance** | Timeouts, retries, cache settings | Optimization |

**Key Configuration Files:**
- `config/default.yaml` - Main configuration
- `config/contracts.yaml` - Contract addresses
- `config/pools-aggressive.yaml` - Pool definitions
- `.env` - Environment variables (secrets)

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

### Code Quality ![Code Quality](https://img.shields.io/badge/Code_Quality-Strict-blue?style=flat)

The project uses:
- **TypeScript** ![Strict](https://img.shields.io/badge/Strict_Mode-Enabled-3178C6?style=flat-square) for type safety
- **ESLint** ![Configured](https://img.shields.io/badge/ESLint-Configured-4B32C3?style=flat-square&logo=eslint) for code linting
- **Prettier** ![Formatted](https://img.shields.io/badge/Prettier-Formatted-F7B93E?style=flat-square&logo=prettier) for code formatting
- **Husky** ![Git Hooks](https://img.shields.io/badge/Git_Hooks-Active-brightgreen?style=flat-square) for git hooks
- **Jest** ![Testing](https://img.shields.io/badge/Jest-Testing-C21325?style=flat-square&logo=jest) for testing
- **Zod** ![Validation](https://img.shields.io/badge/Zod-Validation-3068B7?style=flat-square) for runtime validation

### Commit Convention

Use conventional commits focusing on features:
- `chore: Initial project setup`
- `feat: Add arbitrage opportunity detection`
- `feat: Implement flash loan execution`
- `test: Add profit calculation tests`
- `fix: Handle RPC connection failures`

## Security ![Security](https://img.shields.io/badge/Security-Audited_Design-brightgreen?style=flat&logo=security&logoColor=white)

- All transactions use private relays to avoid MEV theft
- On-chain profit validation prevents unprofitable execution
- Allowlisted pools and tokens for safety
- Reentrancy protection in smart contracts
- Comprehensive error handling and circuit breakers
- Owner-only execution controls
- Real-time monitoring and alerting
- Daily loss limits and position sizing

## License

MIT License - see LICENSE file for details.

## Contributing ![Contributions](https://img.shields.io/badge/Contributions-Welcome-brightgreen?style=flat)

1. Fork the repository
2. Create a feature branch
3. Make your changes with proper tests
4. Ensure all checks pass (`npm run typecheck`)
5. Submit a pull request

**Contribution Guidelines:**
- Follow TypeScript strict mode
- Add tests for new features
- Update documentation
- Use conventional commits (no emojis in commits)
- Run `npm run typecheck` before committing

## Disclaimer

This software is for educational and research purposes. Use at your own risk. MEV extraction may be subject to legal and regulatory restrictions in your jurisdiction.

---

## Project Stats

![Lines of Code](https://img.shields.io/badge/Lines_of_Code-20K+-blue?style=flat)
![TypeScript](https://img.shields.io/badge/TypeScript-100%25-3178C6?style=flat&logo=typescript)
![Test Coverage](https://img.shields.io/badge/Test_Coverage-Expanding-yellow?style=flat&logo=jest)
![Modules](https://img.shields.io/badge/Modules-100+-green?style=flat)
![Smart Contracts](https://img.shields.io/badge/Smart_Contracts-1-363636?style=flat&logo=solidity)

**Architecture Highlights:**
- **Modular Design**: 100+ TypeScript modules
- **Zero Dependencies**: Minimal external dependencies
- **Performance**: <100ms latency target
- **Security First**: Multi-layer protection
- **Flash Loan Native**: Zero capital required
- **Multi-Protocol**: Uniswap V3, Aerodrome, Aave, Moonwell
- **Auto-Failover**: Multi-RPC with health monitoring
- **Observable**: Full metrics and alerting

---

<div align="center">

**Built for the Base ecosystem**

[![Base](https://img.shields.io/badge/Powered_by-Base-0052FF?style=for-the-badge&logo=coinbase&logoColor=white)](https://base.org/)

</div>