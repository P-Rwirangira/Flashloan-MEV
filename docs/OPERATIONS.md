# Base MEV Platform Operations Guide

## Managing Protocol Addresses

- Edit `config/contracts.yaml` under `protocols` to update Aave V3 pool address and Compound-like comptroller/markets.
- Run the configuration validation to ensure correctness:

```
node -e "(async()=>{const {ContractManager}=require('../dist/src/contracts/contract-manager'); const cm=await ContractManager.create(); console.log('valid:', cm.validateConfig());})();"
```

If invalid, check logs for details (invalid address, missing markets, etc.).

## Liquidation Operations

- For Compound-like liquidations, you can optionally preconfigure `markets` mapping for `moonwell`/`seamless`. If `cDebtToken` or `cCollateralToken` are omitted in the opportunity, your orchestration layer can resolve them using:

```ts
const cm = await ContractManager.create();
const cToken = cm.getCTokenFor('moonwell', underlyingAddress);
```

- For Aave V3, ensure `protocols.aaveV3.poolAddress` is accurate for the network.

## FlashExecutor Runtime

- Ensure the following ENV variables are set:
  - `FLASH_EXECUTOR_ADDRESS` — deployed contract
  - `FLASH_POOL_ADDRESS` — Uniswap V3 pool used for flash loan
  - `FLASH_POOL_TOKEN_IS_TOKEN0` — set to "true" if borrowing token0, "false" to borrow token1

- The contract emits `LiquidationExecuted` and `ArbitrageExecuted` events. Monitor them for profit and gas metrics.


## Table of Contents

1. [Deployment](#deployment)
2. [Configuration](#configuration)
3. [Monitoring](#monitoring)
4. [Troubleshooting](#troubleshooting)
5. [Maintenance](#maintenance)
6. [Emergency Procedures](#emergency-procedures)

## Deployment

### Prerequisites

- Node.js 18+ installed
- Docker and Docker Compose (for containerized deployment)
- Access to Base RPC endpoint (local node recommended)
- Private keys for wallet and relay authentication
- Sufficient ETH for gas fees

### Local Development Deployment

1. **Clone and Install**
   ```bash
   git clone <repository-url>
   cd base-mev-platform
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Build and Run**
   ```bash
   npm run build
   npm start
   ```

### Docker Deployment

1. **Build Docker Image**
   ```bash
   docker build -t base-mev-platform:latest .
   ```

2. **Run with Docker Compose**
   ```bash
   docker-compose up -d
   ```

3. **Verify Deployment**
   ```bash
   curl http://localhost:3002/health
   ```

### Production Deployment Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set `dryRun: false` in config (only after testing)
- [ ] Configure secure private keys
- [ ] Set up monitoring and alerting
- [ ] Configure log aggregation
- [ ] Set appropriate resource limits
- [ ] Enable circuit breakers
- [ ] Configure backup RPC endpoints
- [ ] Test graceful shutdown
- [ ] Set up automated restarts
- [ ] Configure rate limiting

## Configuration

### Phase Configuration

Enable or disable trading phases in `config/default.yaml`:

```yaml
phases:
  arbitrage:
    enabled: true
    priority: 1
  liquidations:
    enabled: false  # Enable for Phase 2
    priority: 2
  stablePoolRebalancing:
    enabled: false  # Enable for Phase 3
    priority: 3
```

### Feature Flags

Control specific features:

```yaml
featureFlags:
  enableLiquidationMonitoring: false
  enableStablePoolMonitoring: false
  enableAdvancedRouting: true
  enablePerformanceOptimizations: true
  enableMempoolMonitoring: true
  enableCompetitionTracking: true
```

### Strategy Parameters

Adjust profit thresholds and risk parameters:

```yaml
strategies:
  arbitrage:
    minProfitUSD: 15.0
    maxSlippageBps: 100
    maxPositionSize: 50000
    cooldownMs: 2000
```

### Graceful Degradation

Configure automatic fallback behavior:

```yaml
gracefulDegradation:
  enabled: true
  fallbackToArbitrageOnly: true
  maxConsecutiveFailures: 10
```

## Monitoring

### Health Checks

**Endpoint:** `http://localhost:3002/health`

Monitor these key metrics:
- System status (healthy/degraded/unhealthy)
- RPC connection health
- Circuit breaker state
- Memory usage
- Opportunity detection status

### Key Performance Indicators (KPIs)

1. **Win Rate**: Percentage of submitted opportunities that succeed
   - Target: >60%
   - Warning: <50%
   - Critical: <30%

2. **Profit Margin**: Net profit after gas and bribes
   - Target: >50%
   - Warning: <30%
   - Critical: <10%

3. **Latency**: End-to-end opportunity processing time
   - Target: <500ms
   - Warning: >1000ms
   - Critical: >2000ms

4. **Consecutive Failures**: Number of failed opportunities in a row
   - Target: 0-2
   - Warning: 3-5
   - Critical: >5

### Metrics Collection

Access metrics via `/metrics` endpoint:

```bash
curl http://localhost:3002/metrics | jq '.'
```

### Log Monitoring

Logs are written to:
- Console (stdout/stderr)
- `logs/combined.log` - All logs
- `logs/error.log` - Error logs only

Monitor for:
- Error patterns
- Circuit breaker activations
- RPC connection failures
- Opportunity detection rates

### Alerting

Configure alerts in `config/default.yaml`:

```yaml
monitoring:
  alerting:
    consecutiveRevertThreshold: 5
    latencyThresholdMs: 300
    successRateThreshold: 0.7
```

## Troubleshooting

### Common Issues

#### 1. No Opportunities Detected

**Symptoms:**
- `totalOpportunities: 0` in metrics
- No "Opportunity detected" logs

**Possible Causes:**
- Pool allowlist too restrictive
- Profit thresholds too high
- RPC connection issues
- Insufficient liquidity in monitored pools

**Solutions:**
```bash
# Check RPC connection
curl http://localhost:3002/health | jq '.checks.rpcConnection'

# Review configuration
cat config/default.yaml | grep -A 10 "strategies:"

# Check pool monitoring
grep "pool" logs/combined.log | tail -20
```

#### 2. Circuit Breaker Open

**Symptoms:**
- `circuitBreakerStatus: "open"` in health check
- "Circuit breaker open" warnings in logs

**Possible Causes:**
- Multiple consecutive failures
- RPC endpoint issues
- Gas price spikes
- Competition too high

**Solutions:**
```bash
# Check circuit breaker metrics
curl http://localhost:3002/health | jq '.checks.circuitBreaker'

# Review recent failures
grep "failure" logs/error.log | tail -20

# Manual reset (if needed)
# Restart the platform to reset circuit breaker
docker-compose restart base-mev-platform
```

#### 3. High Memory Usage

**Symptoms:**
- `memoryUsage` status degraded or unhealthy
- Platform slowdown or crashes

**Possible Causes:**
- Memory leaks
- Too many cached opportunities
- Large transaction history

**Solutions:**
```bash
# Check memory usage
curl http://localhost:3002/health | jq '.checks.memoryUsage'

# Restart platform
docker-compose restart base-mev-platform

# Adjust cache settings in config
# Reduce cacheSize and cacheTtlMs
```

#### 4. Low Win Rate

**Symptoms:**
- Win rate <50%
- Many failed transactions

**Possible Causes:**
- High competition
- Slow execution
- Insufficient gas prices
- Stale pool data

**Solutions:**
```bash
# Check competition metrics
grep "competition" logs/combined.log | tail -20

# Increase gas prices
# Edit config/default.yaml:
# gas.maxGasPrice: 100  # Increase from 50

# Reduce latency
# Check performance metrics
curl http://localhost:3002/metrics | jq '.performance'
```

### Debug Mode

Enable debug logging:

```yaml
# config/default.yaml
monitoring:
  logLevel: "debug"
debug: true
```

Or via environment variable:
```bash
LOG_LEVEL=debug npm start
```

### Dry Run Mode

Test without executing real transactions:

```yaml
# config/default.yaml
dryRun: true
```

## Maintenance

### Regular Tasks

#### Daily
- [ ] Check health status
- [ ] Review profit metrics
- [ ] Monitor win rate
- [ ] Check for errors in logs

#### Weekly
- [ ] Review and optimize strategy parameters
- [ ] Update pool allowlists
- [ ] Check for software updates
- [ ] Analyze competition patterns
- [ ] Review gas usage

#### Monthly
- [ ] Full system audit
- [ ] Update dependencies
- [ ] Review and update documentation
- [ ] Backup configuration
- [ ] Performance optimization review

### Updates and Upgrades

1. **Backup Current State**
   ```bash
   docker-compose stop
   cp -r config config.backup
   cp .env .env.backup
   ```

2. **Pull Latest Changes**
   ```bash
   git pull origin main
   npm install
   ```

3. **Test in Dry Run**
   ```bash
   # Set dryRun: true in config
   npm run build
   npm start
   # Monitor for 1 hour
   ```

4. **Deploy to Production**
   ```bash
   # Set dryRun: false
   docker-compose build
   docker-compose up -d
   ```

### Backup and Recovery

**Configuration Backup:**
```bash
tar -czf backup-$(date +%Y%m%d).tar.gz config/ .env logs/
```

**Recovery:**
```bash
tar -xzf backup-YYYYMMDD.tar.gz
docker-compose up -d
```

## Emergency Procedures

### Emergency Stop

**Immediate shutdown:**
```bash
docker-compose stop base-mev-platform
```

**Graceful shutdown:**
```bash
docker-compose exec base-mev-platform kill -SIGTERM 1
```

### Circuit Breaker Manual Activation

If you need to stop trading immediately but keep the platform running:

1. Set `emergencyStop: true` in config
2. Reload configuration (restart platform)

### Recovering from Failures

#### RPC Connection Lost

1. Check RPC endpoint availability
2. Switch to fallback RPC in config
3. Restart platform

#### Out of Gas

1. Check wallet balance
2. Transfer ETH to wallet
3. Platform will resume automatically

#### Stuck Transactions

1. Check pending transactions
2. Use higher gas price for replacement
3. Monitor transaction status

### Incident Response

1. **Detect**: Monitor alerts and health checks
2. **Assess**: Check logs and metrics
3. **Contain**: Enable circuit breaker or emergency stop
4. **Resolve**: Fix underlying issue
5. **Recover**: Gradually resume operations
6. **Review**: Post-incident analysis

### Contact and Escalation

- Check logs first: `logs/error.log`
- Review metrics: `http://localhost:3002/metrics`
- Check health: `http://localhost:3002/health`
- Review documentation: `docs/`

## Performance Optimization

### Latency Reduction

1. Use local Base node (fastest)
2. Enable performance optimizations
3. Optimize pool monitoring intervals
4. Use WebSocket connections

### Gas Optimization

1. Set appropriate gas limits
2. Use dynamic gas pricing
3. Monitor gas usage patterns
4. Optimize transaction timing

### Resource Optimization

1. Adjust cache sizes
2. Limit concurrent operations
3. Optimize logging levels
4. Monitor memory usage

## Security Best Practices

1. **Never commit private keys**
2. Use environment variables for secrets
3. Rotate keys regularly
4. Monitor for unauthorized access
5. Use private relays for all transactions
6. Enable rate limiting
7. Keep dependencies updated
8. Regular security audits
9. Implement proper access controls
10. Monitor for suspicious activity
