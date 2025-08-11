import { getLogger } from '../utils/logger';
import { EventEmitter } from 'events';

const logger = getLogger(__filename);

// task types
export enum TaskType {
  VALIDATE_BLOCK = 'validate_block',
  VERIFY_TRANSACTION = 'verify_transaction',
  MINE_BLOCK = 'mine_block',
  CALCULATE_MERKLE = 'calculate_merkle',
  VERIFY_SIGNATURE = 'verify_signature',
}

// task priority levels
export enum TaskPriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  CRITICAL = 3,
}

// worker state
enum WorkerState {
  IDLE = 'idle',
  BUSY = 'busy',
  ERROR = 'error',
  TERMINATED = 'terminated',
}

// task interface
export interface Task {
  id: string;
  type: TaskType;
  priority: TaskPriority;
  data: any;
  timeout?: number;
  retries?: number;
}

// task result
export interface TaskResult {
  taskId: string;
  success: boolean;
  result?: any;
  error?: string;
  duration: number;
}

// worker info
interface WorkerInfo {
  id: number;
  worker: Worker;
  state: WorkerState;
  currentTask?: Task;
  taskStartTime?: number;
  tasksCompleted: number;
  errors: number;
  totalTime: number;
  restartCount: number;
  lastRestartTime?: number;
}

// pool configuration
export interface WorkerPoolConfig {
  minWorkers?: number;
  maxWorkers?: number;
  workerPath?: string;
  taskTimeout?: number;
  maxRetries?: number;
  scaleUpThreshold?: number;
  scaleDownThreshold?: number;
  monitorInterval?: number;
}

/**
 * bun-optimized worker pool manager
 * uses bun's native Worker API for better performance
 */
export class WorkerPool extends EventEmitter {
  private workers: Map<number, WorkerInfo> = new Map();
  private taskQueue: Task[] = [];
  private pendingTasks: Map<string, {
    task: Task;
    resolve: (result: TaskResult) => void;
    reject: (error: Error) => void;
    timer?: Timer;
  }> = new Map();
  
  private config: Required<WorkerPoolConfig>;
  private nextWorkerId = 0;
  private isRunning = false;
  private monitorTimer?: Timer;
  
  // metrics
  private metrics = {
    tasksQueued: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    averageTime: 0,
    queueLength: 0,
    activeWorkers: 0,
  };

  constructor(config: WorkerPoolConfig = {}) {
    super();
    this.config = {
      minWorkers: config.minWorkers || 2,
      maxWorkers: config.maxWorkers || navigator.hardwareConcurrency || 4,
      workerPath: config.workerPath || './src/workers/worker-script.ts',
      taskTimeout: config.taskTimeout || 30000,
      maxRetries: config.maxRetries || 3,
      scaleUpThreshold: config.scaleUpThreshold || 0.8,
      scaleDownThreshold: config.scaleDownThreshold || 0.2,
      monitorInterval: config.monitorInterval || 5000,
    };
  }

  /**
   * start the worker pool
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('worker pool already running');
    }

    logger.info(`starting worker pool with ${this.config.minWorkers}-${this.config.maxWorkers} workers`);

    // spawn minimum workers using bun's Worker
    for (let i = 0; i < this.config.minWorkers; i++) {
      this.spawnWorker();
    }

    this.isRunning = true;

    // start monitoring
    this.monitorTimer = setInterval(() => this.monitor(), this.config.monitorInterval);

    logger.info(`worker pool started with ${this.workers.size} workers`);
  }

  /**
   * stop the worker pool
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('stopping worker pool');

    // stop monitoring
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }

    // cancel pending tasks
    for (const [taskId, pending] of this.pendingTasks) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('worker pool stopped'));
    }
    this.pendingTasks.clear();
    this.taskQueue = [];

    // terminate all workers
    for (const [workerId, info] of this.workers) {
      info.worker.terminate();
      info.state = WorkerState.TERMINATED;
    }
    this.workers.clear();

    this.isRunning = false;
    logger.info('worker pool stopped');
  }

  /**
   * submit a task to the pool
   */
  async submitTask(task: Task): Promise<TaskResult> {
    if (!this.isRunning) {
      throw new Error('worker pool not running');
    }

    return new Promise((resolve, reject) => {
      // add to pending
      this.pendingTasks.set(task.id, { task, resolve, reject });

      // add to queue
      this.addToQueue(task);

      // set timeout
      const timeout = task.timeout || this.config.taskTimeout;
      const timer = setTimeout(() => {
        const pending = this.pendingTasks.get(task.id);
        if (pending) {
          this.pendingTasks.delete(task.id);
          reject(new Error(`task ${task.id} timed out`));
        }
      }, timeout);

      this.pendingTasks.get(task.id)!.timer = timer;

      // try to assign immediately
      this.assignTasks();
    });
  }

  /**
   * get pool metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      queueLength: this.taskQueue.length,
      activeWorkers: Array.from(this.workers.values()).filter(
        w => w.state === WorkerState.BUSY
      ).length,
      idleWorkers: Array.from(this.workers.values()).filter(
        w => w.state === WorkerState.IDLE
      ).length,
      totalWorkers: this.workers.size,
    };
  }

  // private methods

  /**
   * spawn a new worker using bun's Worker
   */
  private spawnWorker(): void {
    const workerId = this.nextWorkerId++;
    
    logger.debug(`spawning worker ${workerId}`);

    // use bun's native Worker (faster than node's worker_threads)
    const worker = new Worker(this.config.workerPath);

    const info: WorkerInfo = {
      id: workerId,
      worker,
      state: WorkerState.IDLE,
      tasksCompleted: 0,
      errors: 0,
      totalTime: 0,
      restartCount: 0,
      lastRestartTime: undefined,
    };

    // set up event handlers (bun style)
    worker.onmessage = (event: MessageEvent) => {
      this.handleWorkerMessage(workerId, event.data);
    };

    worker.onerror = (error: ErrorEvent) => {
      this.handleWorkerError(workerId, new Error(error.message));
    };

    // send worker initialization
    worker.postMessage({
      type: 'init',
      workerId,
    });

    this.workers.set(workerId, info);
    this.emit('workerSpawned', workerId);
  }

  /**
   * add task to queue
   */
  private addToQueue(task: Task): void {
    // insert based on priority
    let inserted = false;
    for (let i = 0; i < this.taskQueue.length; i++) {
      if (task.priority > this.taskQueue[i].priority) {
        this.taskQueue.splice(i, 0, task);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.taskQueue.push(task);
    }

    this.metrics.tasksQueued++;
    logger.debug(`task ${task.id} added to queue (priority: ${task.priority})`);
  }

  /**
   * assign tasks to idle workers
   */
  private assignTasks(): void {
    if (this.taskQueue.length === 0) return;

    for (const [workerId, info] of this.workers) {
      if (info.state !== WorkerState.IDLE) continue;
      if (this.taskQueue.length === 0) break;

      const task = this.taskQueue.shift()!;
      this.assignTask(workerId, task);
    }
  }

  /**
   * assign a task to a worker
   */
  private assignTask(workerId: number, task: Task): void {
    const info = this.workers.get(workerId);
    if (!info || info.state !== WorkerState.IDLE) return;

    logger.debug(`assigning task ${task.id} to worker ${workerId}`);

    info.state = WorkerState.BUSY;
    info.currentTask = task;
    info.taskStartTime = Date.now();

    // send task to worker
    info.worker.postMessage({
      type: 'task',
      task,
    });
  }

  /**
   * handle worker message
   */
  private handleWorkerMessage(workerId: number, message: any): void {
    const info = this.workers.get(workerId);
    if (!info) return;

    if (message.type === 'result') {
      const { taskId, success, result, error } = message;
      const duration = Date.now() - (info.taskStartTime || 0);

      logger.debug(`worker ${workerId} completed task ${taskId} in ${duration}ms`);

      // update worker info
      info.state = WorkerState.IDLE;
      info.currentTask = undefined;
      info.taskStartTime = undefined;
      info.tasksCompleted++;
      info.totalTime += duration;

      // update metrics
      if (success) {
        this.metrics.tasksCompleted++;
      } else {
        this.metrics.tasksFailed++;
        info.errors++;
      }
      this.metrics.averageTime = 
        (this.metrics.averageTime * (this.metrics.tasksCompleted - 1) + duration) / 
        this.metrics.tasksCompleted;

      // resolve pending task
      const pending = this.pendingTasks.get(taskId);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingTasks.delete(taskId);
        
        const taskResult: TaskResult = {
          taskId,
          success,
          result,
          error,
          duration,
        };

        if (success) {
          pending.resolve(taskResult);
        } else if (pending.task.retries && pending.task.retries > 0) {
          // retry task
          pending.task.retries--;
          logger.debug(`retrying task ${taskId} (${pending.task.retries} retries left)`);
          this.addToQueue(pending.task);
        } else {
          pending.resolve(taskResult);
        }
      }

      // assign next task
      this.assignTasks();
    }
  }

  /**
   * handle worker error
   */
  private handleWorkerError(workerId: number, error: Error): void {
    logger.error(`worker ${workerId} error:`, error);

    const info = this.workers.get(workerId);
    if (!info) return;

    info.state = WorkerState.ERROR;
    info.errors++;

    // restart worker
    this.restartWorker(workerId);
  }

  /**
   * restart a worker
   */
  private restartWorker(workerId: number): void {
    const info = this.workers.get(workerId);
    if (!info) return;

    // check restart limit to prevent infinite loops
    const now = Date.now();
    const timeSinceLastRestart = info.lastRestartTime ? now - info.lastRestartTime : Infinity;
    
    // if restarting too frequently, don't restart
    if (info.restartCount > 5 && timeSinceLastRestart < 5000) {
      logger.error(`worker ${workerId} restarting too frequently, giving up`);
      info.worker.terminate();
      this.workers.delete(workerId);
      
      // ensure minimum workers
      if (this.workers.size < this.config.minWorkers) {
        setTimeout(() => this.spawnWorker(), 1000);
      }
      return;
    }

    logger.info(`restarting worker ${workerId} (restart #${info.restartCount + 1})`);

    // save current task
    const currentTask = info.currentTask;

    // terminate worker
    info.worker.terminate();
    this.workers.delete(workerId);

    // spawn new worker
    this.spawnWorker();

    // re-queue task if any
    if (currentTask) {
      this.addToQueue(currentTask);
    }

    // assign tasks
    this.assignTasks();
  }

  /**
   * monitor and scale workers
   */
  private monitor(): void {
    const utilization = this.calculateUtilization();
    
    logger.debug(`worker pool utilization: ${(utilization * 100).toFixed(1)}%`);

    // scale up if needed
    if (utilization > this.config.scaleUpThreshold && 
        this.workers.size < this.config.maxWorkers) {
      const toSpawn = Math.min(
        2,
        this.config.maxWorkers - this.workers.size
      );
      logger.info(`scaling up: spawning ${toSpawn} workers`);
      for (let i = 0; i < toSpawn; i++) {
        this.spawnWorker();
      }
    }

    // scale down if needed
    if (utilization < this.config.scaleDownThreshold && 
        this.workers.size > this.config.minWorkers) {
      const toTerminate = Math.min(
        2,
        this.workers.size - this.config.minWorkers
      );
      logger.info(`scaling down: terminating ${toTerminate} workers`);
      
      // terminate idle workers
      let terminated = 0;
      for (const [workerId, info] of this.workers) {
        if (terminated >= toTerminate) break;
        if (info.state === WorkerState.IDLE) {
          info.worker.terminate();
          this.workers.delete(workerId);
          terminated++;
        }
      }
    }

    // check for stuck workers
    const now = Date.now();
    for (const [workerId, info] of this.workers) {
      if (info.state === WorkerState.BUSY && info.taskStartTime) {
        const duration = now - info.taskStartTime;
        if (duration > this.config.taskTimeout * 2) {
          logger.warn(`worker ${workerId} appears stuck, restarting`);
          this.restartWorker(workerId);
        }
      }
    }
  }

  /**
   * calculate worker utilization
   */
  private calculateUtilization(): number {
    if (this.workers.size === 0) return 0;
    
    const busyWorkers = Array.from(this.workers.values()).filter(
      w => w.state === WorkerState.BUSY
    ).length;
    
    const queuePressure = Math.min(1, this.taskQueue.length / this.config.maxWorkers);
    const workerUtilization = busyWorkers / this.workers.size;
    
    return (workerUtilization + queuePressure) / 2;
  }
}