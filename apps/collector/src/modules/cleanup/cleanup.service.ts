import { StatsDatabase } from '../db/db.js';
import { RetentionConfig, DEFAULT_RETENTION } from './cleanup.types.js';

/**
 * Automatic data cleanup service
 * 
 * Implements tiered data retention:
 * - Raw connection logs: Short term (configurable, default 7 days)
 * - Hourly stats: Medium term (configurable, default 30 days)  
 * - Daily/domain stats: Long term (permanent, continuously updated)
 */
export class CleanupService {
  private db: StatsDatabase;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private customInterval: number | undefined;

  constructor(db: StatsDatabase, config: Partial<RetentionConfig> = {}) {
    this.db = db;
    this.customInterval = config.cleanupInterval;
  }

  /**
   * Get current config from database
   */
  private getConfig(): RetentionConfig {
    const dbConfig = this.db.getRetentionConfig();
    return {
      ...DEFAULT_RETENTION,
      ...dbConfig,
      // Use custom interval if provided in constructor
      cleanupInterval: this.customInterval ?? DEFAULT_RETENTION.cleanupInterval,
    };
  }

  /**
   * Start automatic cleanup scheduling
   */
  start(): void {
    const config = this.getConfig();
    
    if (!config.autoCleanup) {
      console.log('[Cleanup] Auto-cleanup disabled');
      return;
    }

    if (this.cleanupTimer) {
      return; // Already running
    }

    console.log(`[Cleanup] Starting with retention policy:`, {
      connectionLogs: `${config.connectionLogsDays} days`,
      hourlyStats: `${config.hourlyStatsDays} days`,
      interval: `${config.cleanupInterval} hours`,
    });

    // Run initial cleanup
    this.runCleanup();

    // Schedule periodic cleanup
    const intervalMs = config.cleanupInterval * 60 * 60 * 1000;
    this.cleanupTimer = setInterval(() => {
      this.runCleanup();
    }, intervalMs);
  }

  /**
   * Stop automatic cleanup
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      console.log('[Cleanup] Stopped');
    }
  }

  /**
   * Run cleanup manually
   */
  async runCleanup(): Promise<void> {
    if (this.isRunning) {
      console.log('[Cleanup] Previous cleanup still running, skipping');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      // Clean up old connection logs
      const logsDeleted = this.cleanupConnectionLogs();

      // Clean up old hourly stats
      const hourlyDeleted = this.cleanupHourlyStats();

      // Clean up old health logs (same retention as hourly stats)
      this.cleanupHealthLogs();

      // Vacuum database to reclaim space (only if significant data deleted)
      const totalDeleted = logsDeleted + hourlyDeleted;
      if (totalDeleted > 10000) {
        console.log(`[Cleanup] Deleted ${totalDeleted} records, vacuuming database...`);
        this.db.vacuum();
      }

      const duration = Date.now() - startTime;
      console.log(`[Cleanup] Completed in ${duration}ms: ${logsDeleted} logs, ${hourlyDeleted} hourly records deleted`);
    } catch (err) {
      console.error('[Cleanup] Failed:', err);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Clean up old minute stats (replaced connection logs)
   */
  private cleanupConnectionLogs(): number {
    const config = this.getConfig();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - config.connectionLogsDays);
    const cutoff = cutoffDate.toISOString();

    return this.db.deleteOldMinuteStats(cutoff);
  }

  /**
   * Clean up old health logs (retention matches hourly stats)
   */
  private cleanupHealthLogs(): void {
    const config = this.getConfig();
    this.db.repos.health.pruneOldLogs(config.hourlyStatsDays);
  }

  /**
   * Clean up old hourly stats
   */
  private cleanupHourlyStats(): number {
    const config = this.getConfig();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - config.hourlyStatsDays);
    const cutoff = cutoffDate.toISOString().slice(0, 13) + ':00:00';

    return this.db.deleteOldHourlyStats(cutoff);
  }

  /**
   * Get current database size statistics
   */
  getStats(): {
    connectionLogsCount: number;
    hourlyStatsCount: number;
    oldestConnectionLog: string | null;
    oldestHourlyStat: string | null;
  } {
    return this.db.getCleanupStats();
  }

  /**
   * Update retention configuration
   */
  updateConfig(config: Partial<RetentionConfig>): void {
    // Save to database
    this.db.updateRetentionConfig({
      connectionLogsDays: config.connectionLogsDays,
      hourlyStatsDays: config.hourlyStatsDays,
      autoCleanup: config.autoCleanup,
    });
    
    // Handle interval change
    if (config.cleanupInterval !== undefined) {
      this.customInterval = config.cleanupInterval;
    }
    
    // Restart if interval changed or autoCleanup was toggled
    if ((config.cleanupInterval !== undefined || config.autoCleanup !== undefined) && this.cleanupTimer) {
      this.stop();
      this.start();
    }
  }
}
