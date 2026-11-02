/**
 * Connection Registry
 * Manages database connection configurations by key in-memory.
 * Safely masks credentials when logging or inspecting keys.
 */
export class ConnectionRegistry {
  private configs: Map<string, Record<string, string>> = new Map();

  /**
   * Register a connection configuration for a given key.
   */
  register(key: string, config: Record<string, string>): void {
    if (!key) {
      throw new Error('Connection key cannot be empty');
    }
    this.configs.set(key, { ...config });
  }

  /**
   * Internal only: Retrieve the raw connection configuration for a given key.
   * DO NOT USE IN PUBLIC API ROUTES OR EXPOSE DIRECTLY.
   */
  get(key: string): Record<string, string> | undefined {
    return this.configs.get(key);
  }

  /**
   * Retrieve a sanitized, public-safe metadata representation of the config.
   * Masks connection strings, passwords, and sensitive tokens.
   */
  getPublic(key: string): Record<string, string> | undefined {
    const raw = this.configs.get(key);
    if (!raw) return undefined;

    const sanitized: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (/password|secret|token|key/i.test(k)) {
        sanitized[k] = '********';
      } else if (k === 'connectionString' || k === 'url') {
        try {
          const parsed = new URL(v);
          parsed.password = '********';
          sanitized[k] = parsed.toString();
        } catch {
          sanitized[k] = 'postgresql://[REDACTED]';
        }
      } else {
        sanitized[k] = v;
      }
    }
    return sanitized;
  }

  /**
   * Check if a connection key is registered.
   */
  has(key: string): boolean {
    return this.configs.has(key);
  }

  /**
   * List all registered connection keys without leaking credentials.
   */
  listKeys(): string[] {
    return Array.from(this.configs.keys());
  }

  /**
   * Clears all registered configurations (useful for testing).
   */
  clear(): void {
    this.configs.clear();
  }
}

// Global default singleton registry instance
export const defaultRegistry = new ConnectionRegistry();
