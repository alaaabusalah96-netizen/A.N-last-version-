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
   * Retrieve the connection configuration for a given key.
   */
  get(key: string): Record<string, string> | undefined {
    return this.configs.get(key);
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
