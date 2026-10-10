/**
 * SQLite-backed append ledger for household events and decision outcomes.
 * State snapshots stay JSON for simple recovery; growing histories live here
 * so reads are indexed and no longer rewrite megabyte-sized arrays.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class RuntimeLedger {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS household_events (
        id TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        correlation_id TEXT,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_time ON household_events(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_type_time ON household_events(type, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_correlation ON household_events(correlation_id);
      CREATE TABLE IF NOT EXISTS decision_runs (
        correlation_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        outcome TEXT,
        dry_run INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_time ON decision_runs(started_at DESC);
      CREATE TABLE IF NOT EXISTS corrections (
        id TEXT PRIMARY KEY,
        corrected_at INTEGER NOT NULL,
        correlation_id TEXT,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_corrections_time ON corrections(corrected_at DESC);
    `);
    this.insertEvent = this.db.prepare('INSERT OR IGNORE INTO household_events (id, occurred_at, type, correlation_id, body) VALUES (?, ?, ?, ?, ?)');
    this.upsertRun = this.db.prepare(`INSERT INTO decision_runs (correlation_id, started_at, completed_at, outcome, dry_run, body)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(correlation_id) DO UPDATE SET completed_at=excluded.completed_at, outcome=excluded.outcome, dry_run=excluded.dry_run, body=excluded.body`);
    this.upsertCorrection = this.db.prepare(`INSERT INTO corrections (id, corrected_at, correlation_id, body) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET corrected_at=excluded.corrected_at, correlation_id=excluded.correlation_id, body=excluded.body`);
    this.retentionDays = Math.max(7, Number(options.retentionDays) || 30);
    this.prune();
  }

  appendEvents(events) {
    if (!Array.isArray(events) || !events.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) this.insertEvent.run(event.id, event.occurredAt, event.type, event.correlationId || null, JSON.stringify(event));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recentEvents({ limit = 100, type } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 100, 500));
    const rows = type
      ? this.db.prepare('SELECT body FROM household_events WHERE type = ? ORDER BY occurred_at DESC LIMIT ?').all(type, bounded)
      : this.db.prepare('SELECT body FROM household_events ORDER BY occurred_at DESC LIMIT ?').all(bounded);
    return rows.map(row => JSON.parse(row.body));
  }

  eventsBetween({ since, until, types = [], limit = 10000 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 10000, 20000));
    const from = Number(since) || 0;
    const to = Number(until) || Date.now();
    if (!types.length) {
      return this.db.prepare('SELECT body FROM household_events WHERE occurred_at BETWEEN ? AND ? ORDER BY occurred_at ASC LIMIT ?')
        .all(from, to, bounded).map(row => JSON.parse(row.body));
    }
    const placeholders = types.map(() => '?').join(',');
    return this.db.prepare(`SELECT body FROM household_events WHERE occurred_at BETWEEN ? AND ? AND type IN (${placeholders}) ORDER BY occurred_at ASC LIMIT ?`)
      .all(from, to, ...types, bounded).map(row => JSON.parse(row.body));
  }

  eventCount() { return Number(this.db.prepare('SELECT COUNT(*) AS count FROM household_events').get().count); }

  saveDecisionRun(run) {
    this.upsertRun.run(run.correlationId, run.startedAt || Date.now(), run.completedAt || null, run.outcome || null, run.dryRun ? 1 : 0, JSON.stringify(run));
  }

  saveCorrection(item) {
    this.upsertCorrection.run(item.id, item.correctedAt || Date.now(), item.correlationId || null, JSON.stringify(item));
  }

  loadDecisionRuns(limit = 1000) {
    return this.db.prepare('SELECT body FROM decision_runs ORDER BY started_at DESC LIMIT ?').all(limit).map(row => JSON.parse(row.body));
  }

  loadCorrections(limit = 1000) {
    return this.db.prepare('SELECT body FROM corrections ORDER BY corrected_at DESC LIMIT ?').all(limit).map(row => JSON.parse(row.body));
  }

  /** Aggregates the last N days without loading the full event history. */
  qualityWindow(days = 7, now = Date.now()) {
    const since = now - Math.max(1, Number(days) || 7) * 86400000;
    const eventRows = this.db.prepare(`SELECT type, COUNT(*) AS count FROM household_events
      WHERE occurred_at >= ? AND (type LIKE 'command.%' OR type LIKE 'rule.%') GROUP BY type`).all(since);
    const counts = Object.fromEntries(eventRows.map(row => [row.type, Number(row.count)]));
    const attempts = (counts['command.verified'] || 0) + (counts['command.accepted_unverified'] || 0) + (counts['command.failed'] || 0);
    const correlated = this.db.prepare(`SELECT occurred_at, type, correlation_id FROM household_events
      WHERE occurred_at >= ? AND correlation_id IS NOT NULL AND type IN ('rule.matched','command.requested','command.verified','command.accepted_unverified','command.failed')
      ORDER BY occurred_at ASC`).all(since);
    const runs = new Map();
    for (const event of correlated) {
      const run = runs.get(event.correlation_id) || {};
      run[event.type] = Number(event.occurred_at);
      runs.set(event.correlation_id, run);
    }
    const percentile95 = values => {
      if (!values.length) return null;
      const sorted = values.sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    };
    const stateToAction = [], executionLatency = [];
    for (const run of runs.values()) {
      if (run['rule.matched'] && run['command.requested']) stateToAction.push(run['command.requested'] - run['rule.matched']);
      const completedAt = run['command.verified'] || run['command.accepted_unverified'] || run['command.failed'];
      if (run['command.requested'] && completedAt) executionLatency.push(completedAt - run['command.requested']);
    }
    const correctionCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM corrections WHERE corrected_at >= ?').get(since).count);
    return {
      days: Math.max(1, Number(days) || 7),
      since,
      commandAttempts: attempts,
      verified: counts['command.verified'] || 0,
      unverified: counts['command.accepted_unverified'] || 0,
      failed: counts['command.failed'] || 0,
      skipped: counts['command.skipped'] || 0,
      observationMatches: counts['rule.observed'] || 0,
      corrections: correctionCount,
      verificationRate: attempts ? Math.round((counts['command.verified'] || 0) / attempts * 100) : null,
      failureRate: attempts ? Math.round((counts['command.failed'] || 0) / attempts * 100) : null,
      correctionRate: attempts ? Math.round(correctionCount / attempts * 100) : null,
      stateToActionP95Ms: percentile95(stateToAction),
      executionP95Ms: percentile95(executionLatency)
    };
  }

  prune(now = Date.now()) {
    const cutoff = now - this.retentionDays * 86400000;
    this.db.prepare('DELETE FROM household_events WHERE occurred_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM decision_runs WHERE started_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM corrections WHERE corrected_at < ?').run(cutoff);
  }

  close() { this.db.close(); }
}

module.exports = { RuntimeLedger };
