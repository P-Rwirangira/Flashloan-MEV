/**
 * HTTP Client
 *
 * HTTP client for blockchain RPC calls with retry logic and rate limiting.
 */

import { createComponentLogger } from '../utils/logger';

export interface HttpClientOptions {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  rateLimit?: number; // requests per second
  headers?: Record<string, string>;
}

export interface HttpResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export class HttpClient {
  private readonly logger = createComponentLogger('http-client');
  private readonly options: Required<HttpClientOptions>;
  private requestQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;
  private lastRequestTime = 0;

  constructor(options: HttpClientOptions = {}) {
    this.options = {
      timeout: 30000,
      retries: 3,
      retryDelay: 1000,
      rateLimit: 10, // 10 requests per second
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Base-MEV-Bot/1.0.0',
      },
      ...options,
    };
  }

  async get<T = any>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    return this.request<T>('GET', url, undefined, headers);
  }

  async post<T = any>(
    url: string,
    data?: any,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    return this.request<T>('POST', url, data, headers);
  }

  async put<T = any>(
    url: string,
    data?: any,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', url, data, headers);
  }

  async delete<T = any>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', url, undefined, headers);
  }

  private async request<T>(
    method: string,
    url: string,
    data?: any,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          const response = await this.executeRequest<T>(method, url, data, headers);
          resolve(response);
        } catch (error) {
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  private async executeRequest<T>(
    method: string,
    url: string,
    data?: any,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    const requestHeaders = { ...this.options.headers, ...headers };
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        this.logger.debug('Making HTTP request', {
          method,
          url,
          attempt: attempt + 1,
          maxAttempts: this.options.retries + 1,
        });

        // Rate limiting
        await this.enforceRateLimit();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.options.timeout);

        const fetchOptions: RequestInit = {
          method,
          headers: requestHeaders,
          signal: controller.signal,
        };

        if (data && (method === 'POST' || method === 'PUT')) {
          fetchOptions.body = JSON.stringify(data);
        }

        const response = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        const responseText = await response.text();
        let responseData: T;

        try {
          responseData = responseText ? JSON.parse(responseText) : null;
        } catch (parseError) {
          responseData = responseText as unknown as T;
        }

        const result: HttpResponse<T> = {
          data: responseData,
          status: response.status,
          statusText: response.statusText,
          headers: this.parseHeaders(response.headers),
        };

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        this.logger.debug('HTTP request successful', {
          method,
          url,
          status: response.status,
          attempt: attempt + 1,
        });

        return result;
      } catch (error) {
        lastError = error as Error;

        this.logger.warn('HTTP request failed', {
          method,
          url,
          attempt: attempt + 1,
          error: lastError.message,
        });

        if (attempt < this.options.retries) {
          const delay = this.options.retryDelay * Math.pow(2, attempt);
          this.logger.debug('Retrying HTTP request', { delay, nextAttempt: attempt + 2 });
          await this.sleep(delay);
        }
      }
    }

    this.logger.logError(lastError!, {
      method,
      url,
      operation: 'http-request',
      totalAttempts: this.options.retries + 1,
    });

    throw lastError;
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      if (request) {
        try {
          await request();
        } catch (error) {
          // Error is handled by the individual request
        }
      }
    }

    this.isProcessingQueue = false;
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const minInterval = 1000 / this.options.rateLimit; // milliseconds between requests
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < minInterval) {
      const delay = minInterval - timeSinceLastRequest;
      await this.sleep(delay);
    }

    this.lastRequestTime = Date.now();
  }

  private parseHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      queueLength: this.requestQueue.length,
      isProcessingQueue: this.isProcessingQueue,
      rateLimit: this.options.rateLimit,
      timeout: this.options.timeout,
      retries: this.options.retries,
    };
  }
}
