import { DefaultNamingStrategy, type NamingStrategyInterface } from 'typeorm';

/** camelCase properties map to the migration's snake_case columns (`totalMinor` -> `total_minor`). */
export class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
  override columnName(
    propertyName: string,
    customName: string | undefined,
    prefixes: string[],
  ): string {
    const name = customName ?? propertyName.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    return prefixes.length ? `${prefixes.join('_')}_${name}` : name;
  }
}
