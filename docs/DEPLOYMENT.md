# Base MEV Platform Deployment Guide

## Protocol Addresses Configuration

Add protocol addresses to `config/contracts.yaml` under the new `protocols` section. This decouples runtime logic from hard-coded addresses.

Example:

```
protocols:
  aaveV3:
    poolAddress: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"
  compoundLike:
    moonwell:
      comptroller: "0x8E00D5e02E65A19337Cdba98bbA9F84d4186a180"
      markets:
        - underlying: "0x4200000000000000000000000000000000000006" # WETH
          cToken: "0x..." # cWETH address
        - underlying: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" # USDC
          cToken: "0x..." # cUSDC address
    seamless:
      comptroller: "0x8E00D5e02E65A19337Cdba98bbA9F84d4186a180"
      markets:
        - underlying: "0x4200000000000000000000000000000000000006" # WETH
          cToken: "0x..."
        - underlying: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" # USDC
          cToken: "0x..."
```

Validation:
- `ContractManager.validateConfig()` now validates these addresses. Deployment will fail early if they are missing or invalid.

Usage in code:
- LiquidationEngine reads protocol addresses via `ContractManager.getProtocolAddresses()` and encodes them into the liquidation payload passed to FlashExecutor.

## Flash Executor Liquidation Entry Point

FlashExecutor now supports a dedicated liquidation entry point with robust callbacks:

- `executeLiquidationFlash(address flashPool, uint256 amount0, uint256 amount1, bytes liquidationData, bytes routeData)`
- Operation mode is set internally to LIQUIDATION and handled in `uniswapV3FlashCallback`.
- `LiquidationPayload` encodes protocol-specific data and is validated before use.

Rollout checklist:
- [ ] Update `config/contracts.yaml` with protocol addresses and optional compound-like market mappings
- [ ] Ensure `contracts.yaml` is baked into deployment artifacts or mounted in runtime
- [ ] Re-deploy/verify FlashExecutor as needed (ABI unchanged for arbitrage path)
- [ ] Update ENV: `FLASH_EXECUTOR_ADDRESS`, `FLASH_POOL_ADDRESS`, `FLASH_POOL_TOKEN_IS_TOKEN0`


## Overview

This guide covers deploying the Base MEV Platform in various environments, from local development to production.

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Local Development](#local-development)
3. [Docker Deployment](#docker-deployment)
4. [Production Deployment](#production-deployment)
5. [Kubernetes Deployment](#kubernetes-deployment)
6. [Scaling](#scaling)

## System Requirements

### Minimum Requirements

- **CPU**: 2 cores
- **RAM**: 4 GB
- **Storage**: 20 GB SSD
- **Network**: Stable internet connection with low latency to Base RPC

### Recommended Requirements

- **CPU**: 4+ cores
- **RAM**: 8+ GB
- **Storage**: 50+ GB NVMe SSD
- **Network**: Dedicated connection with <50ms latency to Base RPC
- **OS**: Ubuntu 22.04 LTS or similar

### Software Dependencies

- Node.js 18.x or higher
- npm 9.x or higher
- Docker 24.x (for containerized deployment)
- Docker Compose 2.x (for multi-container setup)
- Git

## Local Development

### Quick Start

1. **Clone Repository**
   ```bash
   git clone <repository-url>
   cd base-mev-platform
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Configure Environment**
   ```bash
   cp .env.example .env
   ```

   Edit `.env` with your configuration:
   ```bash
   # Required
   BASE_RPC_URL=http://localhost:8545
   BASE_WS_URL=ws://localhost:8546
   PRIVATE_KEY=your_private_key_here

   # Optional but recommended
   BLOXROUTE_API_KEY=your_api_key
   FLASHBOTS_AUTH_KEY=your_auth_key
   ```

   **Security Note**: The `.env` file contains sensitive information including your private key. Never commit `.env` to version control. For production deployments, use a secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault) instead of storing secrets in files. See the [Security Hardening](#security-hardening) section for detailed security practices.

4. **Build Project**
   ```bash
   npm run build
   ```

5. **Run in Dry-Run Mode** (recommended for testing)
   ```bash
   # Ensure dryRun: true in config/default.yaml
   npm start
   ```

6. **Verify Deployment**
   ```bash
   curl http://localhost:3002/health
   ```

### Development Workflow

```bash
# Type checking
npm run typecheck

# Build
npm run build

# Run in development mode with watch
npm run dev

# Format code
npm run format

# Lint code
npm run lint
```

## Docker Deployment

### Single Container

1. **Build Image**
   ```bash
   docker build -t base-mev-platform:latest .
   ```

2. **Run Container**
   ```bash
   docker run -d \
     --name base-mev-platform \
     --env-file .env \
     -p 3002:3002 \
     -v $(pwd)/config:/app/config:ro \
     -v $(pwd)/logs:/app/logs \
     base-mev-platform:latest
   ```

3. **Check Logs**
   ```bash
   docker logs -f base-mev-platform
   ```

4. **Check Health**
   ```bash
   curl http://localhost:3002/health
   ```

### Docker Compose

1. **Start Services**
   ```bash
   docker-compose up -d
   ```

   This starts:
   - Base MEV Platform
   - Redis (for caching)
   - Prometheus (for metrics)
   - Grafana (for visualization)

2. **View Logs**
   ```bash
   docker-compose logs -f base-mev-platform
   ```

3. **Stop Services**
   ```bash
   docker-compose down
   ```

4. **Update and Restart**
   ```bash
   git pull
   docker-compose build
   docker-compose up -d
   ```

### Docker Compose Services

- **base-mev-platform**: Main application (port 3002)
- **redis**: Caching layer (port 6379)
- **prometheus**: Metrics collection (port 9090)
- **grafana**: Metrics visualization (port 3000)

Access Grafana at `http://localhost:3000` (default credentials: admin/admin - **immediately change these credentials** and configure a secure admin account for production use)

## Production Deployment

### Pre-Deployment Checklist

- [ ] Secure private keys stored in secrets manager
- [ ] Environment variables configured
- [ ] RPC endpoints tested and verified
- [ ] Monitoring and alerting configured
- [ ] Log aggregation set up
- [ ] Backup strategy in place
- [ ] Resource limits configured
- [ ] Security audit completed
- [ ] Dry-run testing completed
- [ ] Rollback plan prepared

### Environment Configuration

1. **Set Production Environment**
   ```bash
   export NODE_ENV=production
   ```

2. **Configure Production Settings**
   
   Edit `config/default.yaml`:
   ```yaml
   environment: "production"
   debug: false
   dryRun: false  # Only after thorough testing!
   
   monitoring:
     logLevel: "info"
     alerting:
       slack:
         enabled: true
         webhook: "${SLACK_WEBHOOK_URL}"
       email:
         enabled: true
         email: "${ALERT_EMAIL}"
   ```

3. **Set Resource Limits**
   
   In `docker-compose.yml`:
   ```yaml
   services:
     base-mev-platform:
       deploy:
         resources:
           limits:
             cpus: '4'
             memory: 8G
           reservations:
             cpus: '2'
             memory: 4G
   ```

### Deployment Steps

1. **Prepare Server**
   ```bash
   # Update system
   sudo apt update && sudo apt upgrade -y
   
   # Install Docker
   curl -fsSL https://get.docker.com -o get-docker.sh
   sudo sh get-docker.sh
   
   # Install Docker Compose
   sudo apt install docker-compose-plugin -y
   ```

2. **Clone and Configure**
   ```bash
   git clone <repository-url>
   cd base-mev-platform
   cp .env.example .env
   # Edit .env with production values
   ```

3. **Build and Deploy**
   ```bash
   docker-compose build
   docker-compose up -d
   ```

4. **Verify Deployment**
   ```bash
   # Check health
   curl http://localhost:3002/health
   
   # Check logs
   docker-compose logs -f base-mev-platform
   
   # Monitor metrics
   curl http://localhost:3002/metrics
   ```

5. **Configure Monitoring**
   ```bash
   # Set up log rotation
   sudo nano /etc/logrotate.d/mev-platform
   
   # Configure system monitoring
   # Set up Prometheus alerts
   # Configure Grafana dashboards
   ```

### Security Hardening

1. **Firewall Configuration**
   ```bash
   # Allow only necessary ports
   sudo ufw allow 22/tcp    # SSH
   
   # Health checks - PRODUCTION SECURITY NOTE:
   # The health endpoint (port 3002) must be restricted to internal monitoring systems only.
   # Public exposure can leak system information. Choose one of these secure approaches:
   
   # RECOMMENDED: Option 1 - Reverse proxy with authentication (best practice)
   # Configure nginx/apache with HTTP basic auth or OAuth
   # Bind health endpoint to localhost only, then proxy with authentication
   
   # Option 2: Allow from specific monitoring subnet
   sudo ufw allow from 10.0.1.0/24 to any port 3002
   
   # Option 3: Allow from specific monitoring IPs
   sudo ufw allow from 192.168.1.100 to any port 3002
   sudo ufw allow from 192.168.1.101 to any port 3002
   
   # Option 4: VPN + private subnet access
   # Deploy in private subnet with VPN-only access for monitoring
   
   sudo ufw enable
   ```

   **Alternative secure approaches:**
   - **Reverse Proxy**: Use nginx/apache with HTTP basic auth
   - **VPN Access**: Require VPN connection for monitoring access  
   - **Private Network**: Deploy in private subnet with bastion host
   - **Service Mesh**: Use Istio/Linkerd for mTLS and access control

2. **Secrets Management**
   ```bash
   # Use Docker secrets or external secrets manager
   # Never commit .env to version control
   # Rotate keys regularly
   ```

3. **Network Security**
   ```bash
   # Use private networks for internal communication
   # Enable TLS for external endpoints
   # Implement rate limiting
   ```

## Kubernetes Deployment

### Prerequisites

- Kubernetes cluster (1.24+)
- kubectl configured
- Helm 3.x (optional)

### Kubernetes Manifests

1. **Create Namespace**
   ```yaml
   # namespace.yaml
   apiVersion: v1
   kind: Namespace
   metadata:
     name: mev-platform
   ```

2. **Create ConfigMap**
   ```yaml
   # configmap.yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: mev-config
     namespace: mev-platform
   data:
     default.yaml: |
       # Your config here
   ```

3. **Create Secret**
   ```yaml
   # secret.yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: mev-secrets
     namespace: mev-platform
   type: Opaque
   stringData:
     PRIVATE_KEY: "your_private_key"
     BLOXROUTE_API_KEY: "your_api_key"
     FLASHBOTS_AUTH_KEY: "your_auth_key"
   ```

4. **Create Deployment**
   ```yaml
   # deployment.yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: base-mev-platform
     namespace: mev-platform
   spec:
     replicas: 1  # Single instance recommended
     selector:
       matchLabels:
         app: base-mev-platform
     template:
       metadata:
         labels:
           app: base-mev-platform
       spec:
         containers:
         - name: platform
           image: base-mev-platform:latest
           ports:
           - containerPort: 3002
             name: health
           env:
           - name: NODE_ENV
             value: "production"
           envFrom:
           - secretRef:
               name: mev-secrets
           volumeMounts:
           - name: config
             mountPath: /app/config
             readOnly: true
           - name: logs
             mountPath: /app/logs
           resources:
             requests:
               memory: "4Gi"
               cpu: "2"
             limits:
               memory: "8Gi"
               cpu: "4"
           livenessProbe:
             httpGet:
               path: /live
               port: 3002
             initialDelaySeconds: 30
             periodSeconds: 10
           readinessProbe:
             httpGet:
               path: /ready
               port: 3002
             initialDelaySeconds: 10
             periodSeconds: 5
         volumes:
         - name: config
           configMap:
             name: mev-config
         - name: logs
           emptyDir: {}
   ```

5. **Create Service**
   ```yaml
   # service.yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: base-mev-platform
     namespace: mev-platform
   spec:
     selector:
       app: base-mev-platform
     ports:
     - port: 3002
       targetPort: 3002
       name: health
     type: ClusterIP
   ```

### Deploy to Kubernetes

```bash
# Apply manifests
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml

# Check deployment
kubectl get pods -n mev-platform
kubectl logs -f -n mev-platform deployment/base-mev-platform

# Check health
kubectl port-forward -n mev-platform svc/base-mev-platform 3002:3002
curl http://localhost:3002/health
```

## Scaling

### Horizontal Scaling

**Note**: The MEV platform is designed to run as a single instance to avoid duplicate opportunity execution. Horizontal scaling is not recommended for the core platform.

For high availability:
1. Use active-passive setup with failover
2. Implement leader election if multiple instances needed
3. Use distributed locking for opportunity execution

### Vertical Scaling

Increase resources for better performance:

```yaml
# Docker Compose
services:
  base-mev-platform:
    deploy:
      resources:
        limits:
          cpus: '8'
          memory: 16G
```

```yaml
# Kubernetes
resources:
  requests:
    memory: "8Gi"
    cpu: "4"
  limits:
    memory: "16Gi"
    cpu: "8"
```

### Performance Tuning

1. **Optimize RPC Connection**
   - Use local Base node for lowest latency
   - Configure connection pooling
   - Enable WebSocket for real-time updates

2. **Adjust Monitoring Intervals**
   ```yaml
   strategies:
     arbitrage:
       scanIntervalMs: 500  # Reduce for faster detection
   ```

3. **Optimize Memory Usage**
   ```yaml
   performance:
     cacheSize: 2000
     cacheTtlMs: 60000
   ```

## Monitoring and Maintenance

### Health Monitoring

Set up automated health checks:

```bash
# Cron job for health monitoring
*/5 * * * * curl -f http://localhost:3002/health || /path/to/alert.sh
```

### Log Management

Configure log rotation:

```bash
# /etc/logrotate.d/mev-platform
/path/to/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
}
```

### Backup Strategy

```bash
# Daily backup script
#!/bin/bash
DATE=$(date +%Y%m%d)

# SECURITY WARNING: Never backup .env files containing secrets
# Use a secrets manager or encrypted backup workflow for environment secrets
tar -czf /backup/mev-platform-$DATE.tar.gz \
    config/ \
    logs/ \
    --exclude='.env*'

# For secrets backup (if absolutely required):
# Use encrypted storage with GPG or cloud KMS
# gpg --cipher-algo AES256 --compress-algo 1 --s2k-mode 3 \
#     --s2k-digest-algo SHA512 --s2k-count 65536 --symmetric \
#     --output /secure-backup/secrets-$DATE.gpg .env
# 
# Store in access-controlled encrypted storage with:
# - Restricted file permissions (600)
# - Short retention period (7 days max)
# - Audit logging of access

# Keep last 30 days
find /backup -name "mev-platform-*.tar.gz" -mtime +30 -delete
```

## Troubleshooting

### Common Deployment Issues

1. **Container won't start**
   ```bash
   docker logs base-mev-platform
   # Check for configuration errors
   ```

2. **Health check failing**
   ```bash
   curl -v http://localhost:3002/health
   # Check RPC connectivity
   # Verify configuration
   ```

3. **Out of memory**
   ```bash
   # Increase memory limits
   # Check for memory leaks
   # Optimize cache settings
   ```

## Rollback Procedure

If deployment fails:

```bash
# Docker Compose
docker-compose down
git checkout <previous-version>
docker-compose build
docker-compose up -d

# Kubernetes
kubectl rollout undo deployment/base-mev-platform -n mev-platform
```

## Support and Resources

- Documentation: `docs/`
- API Reference: `docs/API.md`
- Operations Guide: `docs/OPERATIONS.md`
- Configuration: `config/default.yaml`
- Logs: `logs/`
