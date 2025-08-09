/**
 * Helper utilities for integrating metrics throughout the codebase
 * Provides easy-to-use timing and recording functions
 */

import { getMetricsService } from '../services/metrics';
import { getLogger } from './logger';

const logger = getLogger(__filename);

/**
 * Time an async operation and record metrics
 */
export async function timeOperation<T>(
  operation: () => Promise<T>,
  recordMetric: (duration: number, result: T) => void
): Promise<T> {
  const startTime = Date.now();
  try {
    const result = await operation();
    const duration = (Date.now() - startTime) / 1000; // convert to seconds
    recordMetric(duration, result);
    return result;
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    recordMetric(duration, null as any);
    throw error;
  }
}

/**
 * Time a sync operation and record metrics
 */
export function timeOperationSync<T>(
  operation: () => T,
  recordMetric: (duration: number, result: T) => void
): T {
  const startTime = Date.now();
  try {
    const result = operation();
    const duration = (Date.now() - startTime) / 1000;
    recordMetric(duration, result);
    return result;
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    recordMetric(duration, null as any);
    throw error;
  }
}

/**
 * Record a blockchain operation with metrics
 */
export async function recordBlockchainOperation<T>(
  operationName: string,
  operation: () => Promise<T>
): Promise<T> {
  const metrics = getMetricsService();
  const startTime = Date.now();
  
  try {
    const result = await operation();
    const duration = (Date.now() - startTime) / 1000;
    
    // record success
    metrics.recordStorageOperation(operationName, 'success', duration);
    
    return result;
  } catch (error: any) {
    const duration = (Date.now() - startTime) / 1000;
    
    // record error
    metrics.recordStorageOperation(operationName, 'error', duration);
    metrics.recordStorageError(operationName, error.message || 'unknown');
    
    throw error;
  }
}

/**
 * Create a timer for manual timing
 */
export class MetricTimer {
  private startTime: number;
  
  constructor() {
    this.startTime = Date.now();
  }
  
  /**
   * Get elapsed time in seconds
   */
  elapsed(): number {
    return (Date.now() - this.startTime) / 1000;
  }
  
  /**
   * Reset the timer
   */
  reset(): void {
    this.startTime = Date.now();
  }
}

/**
 * Decorator for timing async methods (TypeScript experimental)
 */
export function TimeMetric(metricName: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const metrics = getMetricsService();
      const timer = new MetricTimer();
      
      try {
        const result = await originalMethod.apply(this, args);
        const duration = timer.elapsed();
        
        // record based on metric name
        if (metricName.includes('block')) {
          metrics.recordBlockMined(duration, 0, 0); // placeholder
        } else if (metricName.includes('transaction')) {
          metrics.recordTransactionProcessing(duration, 0, 0n);
        }
        
        return result;
      } catch (error) {
        logger.error(`Operation ${metricName} failed`, { error });
        throw error;
      }
    };
    
    return descriptor;
  };
}