#!/usr/bin/env bun

import { serve } from 'bun';
import { getMetrics, initializeMetrics } from '../src/services/metrics';
import { getLogger } from '../src/utils/logger';

const logger = getLogger(__filename);

const PORT = parseInt(process.env.METRICS_PORT || '7336');

// Initialize metrics
initializeMetrics();

// Create HTTP server
const server = serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    
    if (url.pathname === '/metrics') {
      // Prometheus metrics endpoint
      const metrics = await getMetrics();
      return new Response(metrics, {
        headers: {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Cache-Control': 'no-cache'
        }
      });
    }
    
    if (url.pathname === '/health') {
      // Health check endpoint
      return new Response(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        port: PORT
      }), {
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    // Default response
    return new Response(`
BOLT Blockchain Metrics Server

Endpoints:
- GET /metrics - Prometheus metrics
- GET /health  - Health check

Server running on port ${PORT}
    `.trim(), {
      headers: {
        'Content-Type': 'text/plain'
      }
    });
  }
});

logger.info(`Metrics server started on port ${PORT}`);
logger.info(`Prometheus metrics available at: http://localhost:${PORT}/metrics`);
logger.info(`Health check available at: http://localhost:${PORT}/health`);

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down metrics server...');
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down metrics server...');
  server.stop();
  process.exit(0);
});