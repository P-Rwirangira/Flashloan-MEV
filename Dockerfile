# Base MEV Platform Dockerfile

FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:18-alpine AS production

# Create app user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S mev -u 1001

# Set working directory
WORKDIR /app

# Copy built application
COPY --from=builder --chown=mev:nodejs /app/dist ./dist
COPY --from=builder --chown=mev:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=mev:nodejs /app/package.json ./package.json
COPY --from=builder --chown=mev:nodejs /app/config ./config

# Create logs directory
RUN mkdir -p logs && chown mev:nodejs logs

# Switch to app user
USER mev

# Expose ports
EXPOSE 3001 3002

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3002/health || exit 1

# Start the application
CMD ["node", "dist/index.js"]