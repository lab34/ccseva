import type {
  ActualResetInfo,
  DailyUsage,
  MenuBarData,
  PredictionInfo,
  ResetTimeInfo,
  UsageStats,
  VelocityInfo,
  ZaiModelUsageResponse,
  ZaiQuotaLimit,
  ZaiQuotaResponse,
} from '../types/usage.js';
import { ResetTimeService } from './resetTimeService.js';

/**
 * ZAIService - Service for fetching Claude usage data from z.ai API
 *
 * This service replaces CCUsageService for users who want to use the z.ai API
 * instead of reading local JSONL files from ~/.claude directory.
 */
export class ZAIService {
  private static instance: ZAIService;
  private apiKey: string;
  private baseUrl: string = 'https://api.z.ai';
  private cachedStats: UsageStats | null = null;
  private lastUpdate = 0;
  private readonly CACHE_DURATION = 30000; // 30 seconds
  private resetTimeService: ResetTimeService;
  private lastQuotaData: ZaiQuotaLimit | null = null;
  private lastModelUsageData: ZaiModelUsageResponse | null = null;

  constructor() {
    // Get API key from environment variable
    this.apiKey = process.env.ANTHROPIC_AUTH_TOKEN || '';
    if (!this.apiKey) {
      console.warn(
        'ZAIService: ANTHROPIC_AUTH_TOKEN not found in environment. Service will use mock data.'
      );
    }
    this.resetTimeService = ResetTimeService.getInstance();
  }

  static getInstance(): ZAIService {
    if (!ZAIService.instance) {
      ZAIService.instance = new ZAIService();
    }
    return ZAIService.instance;
  }

  /**
   * Main method to get usage stats from z.ai API
   * Implements caching to avoid excessive API calls
   */
  async getUsageStats(): Promise<UsageStats> {
    const now = Date.now();

    // Return cached data if it's still fresh
    if (this.cachedStats && now - this.lastUpdate < this.CACHE_DURATION) {
      return this.cachedStats;
    }

    try {
      if (!this.apiKey) {
        console.warn('ZAIService: No API key configured, returning mock data');
        return this.getMockStats();
      }

      // Fetch data from z.ai API in parallel
      const [quotaData, modelUsageData] = await Promise.all([
        this.fetchQuotaLimit(),
        this.fetchModelUsage(),
      ]);

      // Store for potential use in other methods
      this.lastQuotaData = quotaData;
      this.lastModelUsageData = modelUsageData;

      // Map z.ai data to UsageStats
      const stats = this.mapZaiToUsageStats(quotaData, modelUsageData);

      this.cachedStats = stats;
      this.lastUpdate = now;

      return stats;
    } catch (error) {
      console.error('ZAIService: Error fetching usage stats:', error);

      // Return cached data if available, otherwise mock data
      if (this.cachedStats) {
        console.warn('ZAIService: Returning cached data due to error');
        return this.cachedStats;
      }

      console.warn('ZAIService: No cached data available, returning mock data');
      return this.getMockStats();
    }
  }

  /**
   * Fetch quota limit data from z.ai API
   * GET /api/monitor/usage/quota/limit
   */
  private async fetchQuotaLimit(): Promise<ZaiQuotaLimit> {
    try {
      const response = await fetch(`${this.baseUrl}/api/monitor/usage/quota/limit`, {
        method: 'GET',
        headers: {
          'authorization': `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('ZAIService: Authentication failed - check API key');
        }
        if (response.status === 429) {
          throw new Error('ZAIService: Rate limit exceeded');
        }
        throw new Error(`ZAIService: API request failed with status ${response.status}`);
      }

      const data = (await response.json()) as ZaiQuotaResponse;

      if (!data.success || !data.data?.limits) {
        throw new Error('ZAIService: Invalid response from quota endpoint');
      }

      // Find TOKENS_LIMIT in the limits array
      const tokensLimit = data.data.limits.find((limit) => limit.type === 'TOKENS_LIMIT');

      if (!tokensLimit) {
        throw new Error('ZAIService: TOKENS_LIMIT not found in quota response');
      }

      return tokensLimit;
    } catch (error) {
      console.error('ZAIService: Error fetching quota limit:', error);
      throw error;
    }
  }

  /**
   * Fetch model usage data from z.ai API
   * GET /api/monitor/usage/model-usage
   */
  private async fetchModelUsage(startTime?: string, endTime?: string): Promise<ZaiModelUsageResponse> {
    try {
      // Default to last 7 days if no time range specified
      const now = new Date();
      const defaultEndTime = this.formatDateTime(now);
      const defaultStartTime = this.formatDateTime(
        new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      );

      const url = new URL(`${this.baseUrl}/api/monitor/usage/model-usage`);
      url.searchParams.append('startTime', startTime || defaultStartTime);
      url.searchParams.append('endTime', endTime || defaultEndTime);

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'authorization': `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('ZAIService: Authentication failed - check API key');
        }
        if (response.status === 429) {
          throw new Error('ZAIService: Rate limit exceeded');
        }
        throw new Error(`ZAIService: API request failed with status ${response.status}`);
      }

      const data = (await response.json()) as ZaiModelUsageResponse;

      if (!data.success || !data.data) {
        throw new Error('ZAIService: Invalid response from model usage endpoint');
      }

      return data;
    } catch (error) {
      console.error('ZAIService: Error fetching model usage:', error);
      throw error;
    }
  }

  /**
   * Map z.ai API responses to UsageStats interface
   * This is the core mapping logic that converts z.ai data to CCSeva format
   */
  private mapZaiToUsageStats(
    quota: ZaiQuotaLimit,
    modelUsage: ZaiModelUsageResponse
  ): UsageStats {
    const tokensUsed = quota.currentValue;
    const tokenLimit = quota.usage;
    const tokensRemaining = quota.remaining;
    const percentageUsed = quota.percentage;

    // Calculate velocity from hourly data
    const velocity = this.calculateVelocityFromModelUsage(modelUsage);

    // Get reset time info
    const resetInfo = this.resetTimeService.calculateResetInfo();

    // Handle actual reset time from z.ai if provided
    let actualResetInfo: ActualResetInfo | undefined;
    if (quota.nextResetTime) {
      const nextResetDate = new Date(quota.nextResetTime * 1000); // Convert from seconds
      const now = new Date();
      const timeUntilReset = Math.max(0, nextResetDate.getTime() - now.getTime());

      const hours = Math.floor(timeUntilReset / (1000 * 60 * 60));
      const minutes = Math.floor((timeUntilReset % (1000 * 60 * 60)) / (1000 * 60));

      let formattedTimeRemaining: string;
      if (timeUntilReset <= 0) {
        formattedTimeRemaining = 'Reset available';
      } else if (hours > 0) {
        formattedTimeRemaining = `${hours}h ${minutes}m left`;
      } else if (minutes > 0) {
        formattedTimeRemaining = `${minutes}m left`;
      } else {
        formattedTimeRemaining = '< 1m left';
      }

      actualResetInfo = {
        nextResetTime: nextResetDate,
        timeUntilReset,
        formattedTimeRemaining,
      };
    }

    // Calculate predictions
    const prediction = this.calculatePredictionInfo(tokensUsed, tokenLimit, velocity, resetInfo);

    // Map hourly data to daily usage
    const dailyUsage = this.mapHourlyToDailyUsage(modelUsage);

    const todayStr = new Date().toISOString().split('T')[0];
    const todayData = dailyUsage.find((d) => d.date === todayStr) || this.getEmptyDailyUsage();

    // Detect plan based on token limit
    const currentPlan = this.detectPlanFromLimit(tokenLimit);

    return {
      today: todayData,
      thisWeek: dailyUsage.filter((d) => {
        const date = new Date(d.date);
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        return date >= weekAgo;
      }),
      thisMonth: dailyUsage.filter((d) => {
        const date = new Date(d.date);
        const monthAgo = new Date();
        monthAgo.setDate(monthAgo.getDate() - 30);
        return date >= monthAgo;
      }),
      burnRate: velocity.current,
      velocity,
      prediction,
      resetInfo,
      actualResetInfo,
      predictedDepleted: prediction.depletionTime,
      currentPlan,
      tokenLimit,
      tokensUsed,
      tokensRemaining,
      percentageUsed,
    };
  }

  /**
   * Calculate velocity information from model usage data
   */
  private calculateVelocityFromModelUsage(modelUsage: ZaiModelUsageResponse): VelocityInfo {
    const hourlyData = modelUsage.data.x_time || [];

    // Get current burn rate from the most recent hour
    let current = 0;
    let total24h = 0;
    let total7d = 0;

    if (hourlyData.length > 0) {
      // Look for hourly token usage data in the response
      // The structure may vary, so we'll do our best to extract it
      const totalTokens = modelUsage.data.totalUsage?.totalTokensUsage || 0;

      if (totalTokens > 0 && hourlyData.length > 0) {
        // Estimate current hourly rate from total data
        current = totalTokens / Math.max(1, hourlyData.length / 24); // Approximate
        total24h = current; // Simplified
        total7d = current * 0.8; // Assume slightly lower 7-day average
      }
    }

    // Trend analysis
    const trendPercent = total24h > 0 ? ((current - total24h) / total24h) * 100 : 0;
    let trend: 'increasing' | 'decreasing' | 'stable' = 'stable';

    if (Math.abs(trendPercent) > 15) {
      trend = trendPercent > 0 ? 'increasing' : 'decreasing';
    }

    return {
      current: Math.round(current),
      average24h: Math.round(total24h),
      average7d: Math.round(total7d),
      trend,
      trendPercent: Math.round(trendPercent * 10) / 10,
      peakHour: 14, // Default to 2 PM
      isAccelerating: trend === 'increasing' && trendPercent > 20,
    };
  }

  /**
   * Map hourly model usage data to daily usage format
   */
  private mapHourlyToDailyUsage(modelUsage: ZaiModelUsageResponse): DailyUsage[] {
    const dailyMap = new Map<string, DailyUsage>();

    const hourlyData = modelUsage.data.x_time || [];

    // If we have hourly data points, aggregate them by day
    for (const hourStr of hourlyData) {
      try {
        const datePart = hourStr.split(' ')[0]; // Extract date from "YYYY-MM-DD HH:MM:SS"
        if (!datePart) continue;

        if (!dailyMap.has(datePart)) {
          dailyMap.set(datePart, {
            date: datePart,
            totalTokens: 0,
            totalCost: 0, // z.ai doesn't provide cost, set to 0
            models: {},
          });
        }

        const daily = dailyMap.get(datePart);
        if (daily) {
          // We'll use total usage distributed across days
          // This is an approximation since we don't have hourly breakdowns
          daily.totalTokens += 0; // Will be filled in below
        }
      } catch {
        // Skip invalid date strings
      }
    }

    // Distribute total tokens across days proportionally
    const totalTokens = modelUsage.data.totalUsage?.totalTokensUsage || 0;
    if (totalTokens > 0 && dailyMap.size > 0) {
      const tokensPerDay = Math.floor(totalTokens / dailyMap.size);
      for (const daily of dailyMap.values()) {
        daily.totalTokens = tokensPerDay;
      }
    }

    // Convert to array and sort by date
    return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Calculate prediction information
   */
  private calculatePredictionInfo(
    tokensUsed: number,
    tokenLimit: number,
    velocity: VelocityInfo,
    resetInfo: ResetTimeInfo
  ): PredictionInfo {
    const tokensRemaining = Math.max(0, tokenLimit - tokensUsed);

    // Calculate confidence
    let confidence = 50;
    if (velocity.current > 0 && velocity.average24h > 0) {
      confidence = Math.min(95, confidence + 30);

      if (Math.abs(velocity.trendPercent) > 50) {
        confidence -= 20;
      }
    }

    // Predict depletion time
    let depletionTime: string | null = null;
    let daysRemaining = 0;

    if (velocity.current > 0) {
      const hoursRemaining = tokensRemaining / velocity.current;
      daysRemaining = hoursRemaining / 24;
      depletionTime = new Date(Date.now() + hoursRemaining * 60 * 60 * 1000).toISOString();
    }

    // Recommended daily limit
    const hoursUntilReset = resetInfo.timeUntilReset / (1000 * 60 * 60);
    const recommendedDailyLimit =
      hoursUntilReset > 24 ? Math.floor(tokensRemaining / (hoursUntilReset / 24)) : tokensRemaining;

    // Check if on track
    const onTrackForReset = tokensRemaining > 0 && daysRemaining >= hoursUntilReset / 24;

    return {
      depletionTime,
      confidence: Math.round(confidence),
      daysRemaining: Math.round(daysRemaining * 10) / 10,
      recommendedDailyLimit,
      onTrackForReset,
    };
  }

  /**
   * Detect plan type based on token limit
   */
  private detectPlanFromLimit(tokenLimit: number): 'Pro' | 'Max5' | 'Max20' | 'Custom' {
    if (tokenLimit <= 7000) return 'Pro';
    if (tokenLimit <= 35000) return 'Max5';
    if (tokenLimit <= 140000) return 'Max20';
    return 'Custom';
  }

  /**
   * Get menu bar data for display
   */
  async getMenuBarData(): Promise<MenuBarData> {
    const stats = await this.getUsageStats();

    return {
      tokensUsed: stats.tokensUsed,
      tokenLimit: stats.tokenLimit,
      percentageUsed: stats.percentageUsed,
      status: this.getUsageStatus(stats.percentageUsed),
      cost: 0, // z.ai doesn't provide cost information
      timeUntilReset: stats.actualResetInfo?.formattedTimeRemaining,
    };
  }

  /**
   * Get usage status based on percentage
   */
  private getUsageStatus(percentageUsed: number): 'safe' | 'warning' | 'critical' {
    if (percentageUsed >= 90) return 'critical';
    if (percentageUsed >= 70) return 'warning';
    return 'safe';
  }

  /**
   * Get empty daily usage for today
   */
  private getEmptyDailyUsage(): DailyUsage {
    return {
      date: new Date().toISOString().split('T')[0],
      totalTokens: 0,
      totalCost: 0,
      models: {},
    };
  }

  /**
   * Format date/time for z.ai API requests
   * Format: "YYYY-MM-DD HH:MM:SS"
   */
  private formatDateTime(date: Date): string {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * Get mock stats for testing when API is unavailable
   */
  private getMockStats(): UsageStats {
    const today = new Date().toISOString().split('T')[0];
    const tokensUsed = 25000;
    const tokenLimit = 40000000; // z.ai default
    const velocity: VelocityInfo = {
      current: 120,
      average24h: 100,
      average7d: 90,
      trend: 'increasing',
      trendPercent: 20,
      peakHour: 14,
      isAccelerating: true,
    };

    const prediction: PredictionInfo = {
      depletionTime: new Date(Date.now() + 138 * 60 * 60 * 1000).toISOString(),
      confidence: 85,
      daysRemaining: 5.75,
      recommendedDailyLimit: 6500,
      onTrackForReset: true,
    };

    const resetInfo = this.resetTimeService.calculateResetInfo();

    return {
      today: {
        date: today,
        totalTokens: 1200,
        totalCost: 0, // z.ai doesn't provide cost
        models: {},
      },
      thisWeek: this.generateMockDailyData(7),
      thisMonth: this.generateMockDailyData(30),
      burnRate: velocity.current,
      velocity,
      prediction,
      resetInfo,
      predictedDepleted: prediction.depletionTime,
      currentPlan: 'Custom',
      tokenLimit,
      tokensUsed,
      tokensRemaining: tokenLimit - tokensUsed,
      percentageUsed: (tokensUsed / tokenLimit) * 100,
    };
  }

  /**
   * Generate mock daily data for testing
   */
  private generateMockDailyData(days: number): DailyUsage[] {
    const result: DailyUsage[] = [];
    const now = new Date();

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0];
      const tokens = Math.floor(Math.random() * 2000) + 500;

      result.push({
        date: dateStr,
        totalTokens: tokens,
        totalCost: 0, // z.ai doesn't provide cost
        models: {},
      });
    }

    return result;
  }

  /**
   * Update configuration (for compatibility with CCUsageService interface)
   */
  updateConfiguration(_config: {
    plan?: 'auto' | 'Pro' | 'Max5' | 'Max20' | 'Custom';
    customTokenLimit?: number;
    menuBarCostSource?: 'today' | 'sessionWindow';
  }): void {
    // z.ai service doesn't use plan configuration in the same way
    // The plan is auto-detected from the API response
    // Clear cache to force refresh
    this.cachedStats = null;
  }
}
