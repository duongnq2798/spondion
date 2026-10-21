import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlStatement, SqlValue } from '../store.ts';

/** Real SQLite with the small, asynchronous D1 surface used by the service. */
export function sqliteDatabase(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const db: SqlDatabase = {
    prepare(query: string): SqlStatement {
      let values: SqlValue[] = [];
      const statement: SqlStatement = {
        bind(...bound: SqlValue[]) { values = bound; return statement; },
        async first<T>() {
          return (sqlite.prepare(query).get(...values) as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: sqlite.prepare(query).all(...values) as T[] };
        },
        async run() {
          const result = sqlite.prepare(query).run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
  };
  return { db, sqlite, close: () => sqlite.close() };
}
