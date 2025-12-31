# Base MEV Platform API Documentation

## Overview

The Base MEV Platform provides HTTP endpoints for health checks, metrics, and system monitoring. All endpoints return JSON responses.

## Base URL

```
http://localhost:3002
```

Configure the port using the `HEALTH_CHECK_PORT` environment variable.

## Endpoints

### Health Check

#### GET /health

Returns comprehensive health status of the platform including all component checks.

**Response Status Codes:**
- `200 OK` - System is healthy
- `503 Service Unavailable` - System is degraded or unhealthy

**Response Body:**

```json
{
  "status": "healthy|degraded|unhealthy",
  "timestamp": 1234567890,
  "uptime": 3600,
  "version": "1.0.0",
  "checks": {
    "rpcConnection": {
      "status": "healthy",
      "message": "RPC connection operational",
      "lastCheck": 1234567890,
      "details": {
        "networkLatency": 50
      }
    },
    "circuitBreaker": {
      "status": "healthy",
      "message": "Circuit breaker closed - normal operation",
      "lastCheck": 1234567890,
      "details": {
        "state": "closed",
        "failureCount": 0,
        "failureRate": 0
      }
    },
    "memoryUsage": {
      "status": "healthy",
      "message": "Memory usage normal: 45.2%",
      "lastCheck": 1234567890,
      "details": {
        "heapUsedMB": "120.50",
        "heapTotalMB": "266.50",
        "heapUsagePercent": "45.20",
        "rss": "180.25"
      }
    },
    "opportunityDetection": {
      "status": "healthy",
      "message": "Opportunity detection active",
      "lastCheck": 1234567890,
      "details": {
        "consecutiveFailures": 0,
        "timeSinceLastSuccess": 30
      }
    }
  },
  "metrics": {
    "totalOpportunities": 150,
    "winRate": 0.65,
    "totalProfitUSD": 1250.50,
    "activePhases": ["arbitrage(priority:1)"]
  }
}
```

### Readiness Check

#### GET /ready

Kubernetes-style readiness probe. Returns whether the system is ready to accept traffic.

**Response Status Codes:**
- `200 OK` - System is ready
- `503 Service Unavailable` - System is not ready

**Response Body:**

```json
{
  "status": "ready",
  "timestamp": 1234567890
}
```

### Liveness Check

#### GET /live

Kubernetes-style liveness probe. Returns whether the system is alive and responding.

**Response Status Codes:**
- `200 OK` - System is alive

**Response Body:**

```json
{
  "status": "alive",
  "timestamp": 1234567890
}
```

### Metrics

#### GET /metrics

Returns comprehensive platform metrics including opportunities, profit, performance, and system health.

**Response Status Codes:**
- `200 OK` - Metrics retrieved successfully

**Response Body:**

```json
{
  "opportunity": {
    "totalOpportunities": 150,
    "detectedOpportunities": 150,
    "simulatedOpportunities": 120,
    "submittedOpportunities": 100,
    "successfulOpportunities": 65,
    "opportunityRate": 25.5,
    "detectionRate": 25.5,
    "simulationRate": 20.0,
    "submissionRate": 16.7,
    "winRate": 0.65
  },
  "profit": {
    "totalProfitWei": "1250500000000000000",
    "totalProfitUSD": 1250.50,
    "averageProfitWei": "19238461538461538",
    "averageProfitUSD": 19.24,
    "totalGasCostWei": "150000000000000000",
    "totalGasCostUSD": 150.00,
    "averageGasCostWei": "2307692307692307",
    "averageGasCostUSD": 2.31,
    "totalBribesWei": "50000000000000000",
    "totalBribesUSD": 50.00,
    "averageBribeWei": "769230769230769",
    "averageBribeUSD": 0.77,
    "netProfitWei": "1050500000000000000",
    "netProfitUSD": 1050.50,
    "profitMargin": 525.25
  },
  "performance": {
    "averageDetectionLatency": 45.5,
    "averageSimulationLatency": 120.3,
    "averageSubmissionLatency": 250.8,
    "averageEndToEndLatency": 416.6,
    "p50DetectionLatency": 40.0,
    "p95DetectionLatency": 80.0,
    "p99DetectionLatency": 120.0,
    "p50SubmissionLatency": 200.0,
    "p95SubmissionLatency": 400.0,
    "p99SubmissionLatency": 600.0
  },
  "relays": [
    {
      "provider": "flashbots_protect",
      "totalSubmissions": 80,
      "successfulSubmissions": 52,
      "failedSubmissions": 28,
      "inclusionRate": 0.65,
      "averageLatency": 250.5,
      "averageInclusionTime": 12500,
      "totalBribes": "40000000000000000",
      "averageBribe": "500000000000000"
    }
  ],
  "system": {
    "uptime": 3600,
    "memoryUsage": 120.50,
    "cpuUsage": 0,
    "networkLatency": 50,
    "rpcConnectionHealth": true,
    "lastSuccessfulOperation": 1234567890,
    "consecutiveFailures": 0,
    "circuitBreakerStatus": "closed"
  },
  "timeSeries": {
    "opportunity": {
      "timestamps": [1234567890, 1234567920, 1234567950],
      "values": [1, 2, 3]
    },
    "profit": {
      "timestamps": [1234567890, 1234567920],
      "values": [19.24, 18.50]
    },
    "performance": {
      "timestamps": [1234567890, 1234567920],
      "values": [250.5, 245.8]
    }
  }
}
```

### Status

#### GET /status

Returns simplified status information for quick checks.

**Response Status Codes:**
- `200 OK` - Status retrieved successfully

**Response Body:**

```json
{
  "status": "healthy",
  "uptime": 3600,
  "version": "1.0.0",
  "timestamp": 1234567890
}
```

## Health Status Values

### System Status
- `healthy` - All components operational
- `degraded` - Some components experiencing issues but system is functional
- `unhealthy` - Critical components failing, system may not be operational

### Component Status
Each component (RPC connection, circuit breaker, memory usage, opportunity detection) can have:
- `healthy` - Component operating normally
- `degraded` - Component experiencing issues but still functional
- `unhealthy` - Component failing or not operational

## Error Responses

All endpoints may return error responses in the following format:

```json
{
  "error": "Error message description"
}
```

**Common Error Status Codes:**
- `404 Not Found` - Endpoint does not exist
- `405 Method Not Allowed` - HTTP method not supported
- `500 Internal Server Error` - Unexpected server error

## CORS

All endpoints support CORS with the following headers:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`

## Rate Limiting

Currently, no rate limiting is enforced on health check endpoints. These are designed for frequent polling by monitoring systems and load balancers.

## Integration Examples

### Kubernetes Probes

```yaml
livenessProbe:
  httpGet:
    path: /live
    port: 3002
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /ready
    port: 3002
  initialDelaySeconds: 10
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
```

### Docker Health Check

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3002/health || exit 1
```

### Load Balancer Health Check

Configure your load balancer to poll `/health` endpoint every 30 seconds with a 3-second timeout.

### Monitoring Integration

Use `/metrics` endpoint to collect platform metrics for Prometheus, Grafana, or other monitoring systems.

```bash
# Example: Fetch metrics every minute
*/1 * * * * curl -s http://localhost:3002/metrics | jq '.' > /var/log/mev-metrics.json
```
