/**
 * Performance Monitor for Sync System
 */

export type MetricType = 'sync_duration' | 'push_duration' | 'pull_duration' | 'conflict_resolution' | 'indexeddb_read' | 'indexeddb_write' | 'network_request';

export interface PerformanceMetric {
    type: MetricType;
    duration: number;
    timestamp: number;
    metadata?: Record<string, unknown>;
}

export interface MetricStats {
    count: number;
    avgDuration: number;
    minDuration: number;
    maxDuration: number;
    p95Duration: number;
    totalDuration: number;
}

export interface PerformanceReport {
    generatedAt: number;
    periodStart: number;
    periodEnd: number;
    metrics: Record<MetricType, MetricStats>;
    totalOperations: number;
    successRate: number;
    avgSyncTime: number;
}

export class SyncPerformanceMonitor {
    private metrics: PerformanceMetric[] = [];
    private maxMetrics = 1000;
    private startTimes = new Map<string, number>();
    private successCount = 0;
    private failureCount = 0;

    startTiming(type: MetricType, operationId?: string): string {
        const id = operationId || `${type}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        this.startTimes.set(id, performance.now());
        return id;
    }

    stopTiming(operationId: string, type: MetricType, metadata?: Record<string, unknown>, success = true): number {
        const startTime = this.startTimes.get(operationId);
        this.startTimes.delete(operationId);
        if (startTime === undefined) return 0;

        const duration = performance.now() - startTime;
        this.recordMetric(type, duration, metadata);
        success ? this.successCount++ : this.failureCount++;
        return duration;
    }

    recordMetric(type: MetricType, duration: number, metadata?: Record<string, unknown>): void {
        this.metrics.push({ type, duration, timestamp: Date.now(), metadata });
        if (this.metrics.length > this.maxMetrics) this.metrics = this.metrics.slice(-this.maxMetrics);
    }

    recordSuccess(): void { this.successCount++; }
    recordFailure(): void { this.failureCount++; }

    getStats(type: MetricType, periodMs?: number): MetricStats {
        const cutoff = periodMs ? Date.now() - periodMs : 0;
        const relevantMetrics = this.metrics.filter(m => m.type === type && m.timestamp >= cutoff);

        if (relevantMetrics.length === 0) return { count: 0, avgDuration: 0, minDuration: 0, maxDuration: 0, p95Duration: 0, totalDuration: 0 };

        const durations = relevantMetrics.map(m => m.duration).sort((a, b) => a - b);
        const total = durations.reduce((sum, d) => sum + d, 0);
        const p95Index = Math.floor(durations.length * 0.95);

        return { count: durations.length, avgDuration: total / durations.length, minDuration: durations[0], maxDuration: durations[durations.length - 1], p95Duration: durations[p95Index] || durations[durations.length - 1], totalDuration: total };
    }

    generateReport(periodMs = 3600000): PerformanceReport {
        const now = Date.now();
        const metricTypes: MetricType[] = ['sync_duration', 'push_duration', 'pull_duration', 'conflict_resolution', 'indexeddb_read', 'indexeddb_write', 'network_request'];
        const metrics = {} as Record<MetricType, MetricStats>;
        for (const type of metricTypes) metrics[type] = this.getStats(type, periodMs);

        const totalOperations = this.successCount + this.failureCount;
        return { generatedAt: now, periodStart: now - periodMs, periodEnd: now, metrics, totalOperations, successRate: totalOperations > 0 ? (this.successCount / totalOperations) * 100 : 100, avgSyncTime: metrics.sync_duration.avgDuration };
    }

    async time<T>(type: MetricType, fn: () => Promise<T>, metadata?: Record<string, unknown>): Promise<T> {
        const id = this.startTiming(type);
        let success = true;
        try { return await fn(); } catch (error) { success = false; throw error; } finally { this.stopTiming(id, type, metadata, success); }
    }

    clear(): void { this.metrics = []; this.startTimes.clear(); this.successCount = 0; this.failureCount = 0; }
    getMetricsCount(): number { return this.metrics.length; }
}

export const syncPerformanceMonitor = new SyncPerformanceMonitor();
