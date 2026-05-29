import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ComputeTask {
  type: "biomeArea" | "locateBiome" | "structuresArea";
  id: number;
  [key: string]: unknown;
}

export interface ComputeResult {
  id: number;
  data?: unknown;
  error?: string;
}

interface PendingTask {
  task: ComputeTask;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Worker 线程池
 * 将 CPU 密集型计算分发到独立线程，不阻塞事件循环
 */
export class WorkerPool {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private taskQueue: PendingTask[] = [];
  private busyWorkers = new Map<Worker, number>();
  private taskIdCounter = 0;
  private taskCallbacks = new Map<number, { resolve: (v: unknown) => void; reject: (r: unknown) => void }>();
  private initialized = false;

  constructor(
    private poolSize: number,
    private workerScript: string
  ) {}

  public async initialize(): Promise<void> {
    if (this.poolSize <= 0) return;

    const workerPath = path.resolve(__dirname, this.workerScript);
    console.log(`[WorkerPool] Initializing ${this.poolSize} workers from ${workerPath}`);

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(workerPath);
      worker.on("message", (result: ComputeResult) => this.handleResult(worker, result));
      worker.on("error", (err) => this.handleError(worker, err));
      worker.on("exit", (code) => {
        if (code !== 0) {
          console.warn(`[WorkerPool] Worker exited with code ${code}, restarting...`);
          this.restartWorker(worker);
        }
      });
      this.workers.push(worker);
      this.idleWorkers.push(worker);
    }

    this.initialized = true;
    console.log(`[WorkerPool] ${this.poolSize} workers ready`);
  }

  private restartWorker(oldWorker: Worker): void {
    const idx = this.workers.indexOf(oldWorker);
    if (idx === -1) return;

    const workerPath = path.resolve(__dirname, this.workerScript);
    const worker = new Worker(workerPath);
    worker.on("message", (result: ComputeResult) => this.handleResult(worker, result));
    worker.on("error", (err) => this.handleError(worker, err));
    this.workers[idx] = worker;

    // 清理旧 worker 的任务
    const taskId = this.busyWorkers.get(oldWorker);
    if (taskId !== undefined) {
      this.busyWorkers.delete(oldWorker);
      const cb = this.taskCallbacks.get(taskId);
      if (cb) {
        cb.reject(new Error("Worker crashed"));
        this.taskCallbacks.delete(taskId);
      }
    }

    this.idleWorkers.push(worker);
    this.processQueue();
  }

  private handleResult(worker: Worker, result: ComputeResult): void {
    this.busyWorkers.delete(worker);
    this.idleWorkers.push(worker);

    const cb = this.taskCallbacks.get(result.id);
    if (cb) {
      this.taskCallbacks.delete(result.id);
      if (result.error) {
        cb.reject(new Error(result.error));
      } else {
        cb.resolve(result.data);
      }
    }

    this.processQueue();
  }

  private handleError(worker: Worker, err: Error): void {
    console.error(`[WorkerPool] Worker error:`, err.message);
    const taskId = this.busyWorkers.get(worker);
    if (taskId !== undefined) {
      this.busyWorkers.delete(worker);
      const cb = this.taskCallbacks.get(taskId);
      if (cb) {
        cb.reject(err);
        this.taskCallbacks.delete(taskId);
      }
    }
    this.restartWorker(worker);
  }

  private processQueue(): void {
    while (this.taskQueue.length > 0 && this.idleWorkers.length > 0) {
      const pending = this.taskQueue.shift()!;
      const worker = this.idleWorkers.pop()!;
      this.busyWorkers.set(worker, pending.task.id);
      this.taskCallbacks.set(pending.task.id, {
        resolve: pending.resolve,
        reject: pending.reject,
      });
      worker.postMessage(pending.task);
    }
  }

  /**
   * 提交计算任务到线程池
   */
  public submit<T>(task: Omit<ComputeTask, "id">): Promise<T> {
    if (!this.initialized || this.poolSize <= 0) {
      return Promise.reject(new Error("WorkerPool not initialized"));
    }

    return new Promise<T>((resolve, reject) => {
      const id = ++this.taskIdCounter;
      const fullTask: ComputeTask = { ...task, id } as ComputeTask;

      const idle = this.idleWorkers.pop();
      if (idle) {
        this.busyWorkers.set(idle, id);
        this.taskCallbacks.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        idle.postMessage(fullTask);
      } else {
        this.taskQueue.push({
          task: fullTask,
          resolve: resolve as (v: unknown) => void,
          reject,
        });
      }
    });
  }

  /**
   * 是否已初始化且可用
   */
  public isReady(): boolean {
    return this.initialized && this.poolSize > 0;
  }

  /**
   * 关闭所有 worker
   */
  public async shutdown(): Promise<void> {
    for (const worker of this.workers) {
      await worker.terminate();
    }
    this.workers = [];
    this.idleWorkers = [];
    this.taskQueue = [];
    this.taskCallbacks.clear();
    this.busyWorkers.clear();
    this.initialized = false;
  }
}