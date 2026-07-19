import Database from 'better-sqlite3';

/**
 * The single SQLite database behind `EventStorePort`: an append-only `events` table whose
 * `global_seq` gives the total order that drives projections and the reactor, plus a `checkpoints`
 * table for the durable reactor. `UNIQUE(stream_id, version)` is the optimistic-concurrency
 * guard; WAL mode lets readers (projections) run concurrently with the single writer. This is the
 * service's own process log — entirely separate from beets' `library.db`, which this service never
 * touches directly.
 */
export type EventDatabase = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  global_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id      TEXT    NOT NULL,
  version        INTEGER NOT NULL,
  type           TEXT    NOT NULL,
  schema_version INTEGER NOT NULL,
  data           TEXT    NOT NULL,
  metadata       TEXT    NOT NULL,
  UNIQUE (stream_id, version)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  consumer   TEXT    PRIMARY KEY,
  global_seq INTEGER NOT NULL
);
`;

/** Open (creating if absent) the event database, enable WAL, and ensure the schema exists. */
export function openEventDatabase(filename: string): EventDatabase {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
