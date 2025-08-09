#!/usr/bin/env bun

import { serve } from 'bun';
import { getMetricsService } from '../src/services/metrics';
import { getLogger } from '../src/utils/logger';

const logger = getLogger(__filename);

const PORT = parseInt(process.env.METRICS_PORT || '7336');

// get metrics service instance
const metrics = getMetricsService();

// create http server for prometheus scraping
const server = serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    
    // prometheus metrics endpoint
    if (url.pathname === '/metrics') {
      try {
        const metricsData = await metrics.getMetrics();
        return new Response(metricsData, {
          headers: {
            'Content-Type': metrics.getContentType(),
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        });
      } catch (error) {
        logger.error('Failed to generate metrics', { error });
        return new Response('Internal Server Error', { status: 500 });
      }
    }
    
    // health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        port: PORT,
        service: 'bolt-metrics'
      }), {
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    // readiness check endpoint
    if (url.pathname === '/ready') {
      return new Response(JSON.stringify({
        ready: true,
        timestamp: new Date().toISOString()
      }), {
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    // default response
    return new Response(`
bolt blockchain metrics server

endpoints:
  GET /metrics - prometheus metrics
  GET /health  - health check
  GET /ready   - readiness check

prometheus scrape config:
  - job_name: 'bolt'
    static_configs:
      - targets: ['localhost:${PORT}']
    `.trim(), {
      headers: {
        'Content-Type': 'text/plain'
      }
    });
  }
});

logger.info(`Metrics server started on port ${PORT}`);
logger.info(`Prometheus metrics: http://localhost:${PORT}/metrics`);
logger.info(`Health check: http://localhost:${PORT}/health`);

// graceful shutdown
const shutdown = () => {
  logger.info('Shutting down metrics server...');
  server.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// prevent process from exiting
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', { error });
});