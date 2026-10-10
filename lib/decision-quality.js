/** Persistent quality ledger for NOVA decisions, executions and corrections. */
const fs = require('fs');
const path = require('path');

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = `${filePath}.next`;
  fs.writeFileSync(next, JSON.stringify(value, null, 2));
  fs.renameSync(next, filePath);
}

class DecisionQualityStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.limit = options.limit || 1000;
    this.ledger = options.ledger || null;
    this.data = { schemaVersion: 1, runs: [], corrections: [], updatedAt: 0 };
    this.load();
  }
  load() {
    try {
      if (this.ledger) {
        this.data.runs = this.ledger.loadDecisionRuns(this.limit);
        this.data.corrections = this.ledger.loadCorrections(this.limit);
        if (!this.data.runs.length && fs.existsSync(this.filePath)) {
          const legacy = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
          this.data = { ...this.data, ...legacy };
          for (const run of this.data.runs) this.ledger.saveDecisionRun(run);
          for (const correction of this.data.corrections) this.ledger.saveCorrection(correction);
        }
      } else if (fs.existsSync(this.filePath)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.filePath, 'utf8')) };
    }
    catch (error) { console.warn('[DecisionQuality] load failed:', error.message); }
  }
  save(run, correction) {
    this.data.updatedAt = Date.now();
    if (this.ledger) {
      if (run) this.ledger.saveDecisionRun(run);
      if (correction) this.ledger.saveCorrection(correction);
      return;
    }
    atomicWrite(this.filePath, this.data);
  }
  observe(event) {
    if (!event?.correlationId) return;
    let run = this.data.runs.find(item => item.correlationId === event.correlationId);
    if (event.type === 'rule.triggered') {
      run = run || { correlationId: event.correlationId, startedAt: event.occurredAt, steps: [] };
      run.ruleId = event.payload?.ruleId;
      run.ruleName = event.payload?.ruleName;
      run.dryRun = !!event.payload?.dryRun;
      run.condition = event.payload?.condition;
      run.action = event.payload?.action;
      if (!this.data.runs.includes(run)) this.data.runs.unshift(run);
    }
    if (!run) return;
    run.steps.push({ type: event.type, occurredAt: event.occurredAt, payload: event.payload });
    run.completedAt = event.occurredAt;
    if (event.type === 'command.verified' || event.type === 'rule.completed') run.outcome = 'success';
    if (event.type.endsWith('failed')) run.outcome = 'failed';
    if (event.type.endsWith('skipped') || event.type === 'rule.observed') run.outcome = 'skipped';
    this.data.runs = this.data.runs.slice(0, this.limit);
    this.save(run);
  }
  recordCorrection(correction) {
    const run = this.data.runs.find(item => item.correlationId === correction.correlationId);
    const item = { ...correction, ruleId: run?.ruleId || null, ruleName: run?.ruleName || null };
    this.data.corrections.unshift(item);
    this.data.corrections = this.data.corrections.slice(0, this.limit);
    if (run) { run.corrected = true; run.outcome = 'corrected'; }
    this.save(run, item);
    const correctionCount = item.ruleId ? this.data.corrections.filter(entry => entry.ruleId === item.ruleId).length : 0;
    return { item, correctionCount, shouldWarn: correctionCount >= 2, shouldPause: correctionCount >= 3 };
  }
  summary() {
    const runs = this.data.runs;
    const count = type => runs.filter(item => item.outcome === type).length;
    // Observation-mode matches are learning samples, not execution attempts.
    // Keeping the denominators separate prevents a safe dry-run period from
    // appearing as a 0% automation success rate.
    const observations = runs.filter(item => item.dryRun);
    const executionAttempts = runs.filter(item => !item.dryRun && item.outcome);
    const successfulExecutions = executionAttempts.filter(item => item.outcome === 'success');
    const verifiedExecutions = successfulExecutions.filter(item => item.steps?.some(step => step.type === 'command.verified'));
    const correctedExecutions = executionAttempts.filter(item => item.outcome === 'corrected' || item.corrected);
    const latency = executionAttempts.map(item => Math.max(0, (item.completedAt || item.startedAt) - item.startedAt));
    return {
      updatedAt: this.data.updatedAt,
      metrics: {
        totalDecisions: runs.length,
        observationMatches: observations.length,
        executionAttempts: executionAttempts.length,
        success: count('success'), failed: count('failed'), skipped: count('skipped'), corrected: count('corrected'),
        successRate: executionAttempts.length ? Math.round(successfulExecutions.length / executionAttempts.length * 100) : null,
        verificationRate: successfulExecutions.length ? Math.round(verifiedExecutions.length / successfulExecutions.length * 100) : null,
        correctionRate: executionAttempts.length ? Math.round(correctedExecutions.length / executionAttempts.length * 100) : null,
        averageLatencyMs: latency.length ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length) : null
      },
      recent: runs.slice(0, 30),
      corrections: this.data.corrections.slice(0, 30)
    };
  }
}
module.exports = { DecisionQualityStore };
