class LogStore {
  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
    this.entries = [];
    this.filterableFields = ['caller', 'routeId', 'statusCode', 'cacheHit', 'method', 'target'];
  }

  add(entry) {
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.pop();
    }
  }

  query(filters = {}, limit = 100, offset = 0) {
    let results = [...this.entries];

    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;

      if (key === 'statusCode') {
        const code = parseInt(value);
        results = results.filter(e => e.statusCode === code);
      } else if (key === 'cacheHit') {
        const hit = value === 'true' || value === true;
        results = results.filter(e => e.cacheHit === hit);
      } else if (key === 'startTime') {
        const start = new Date(value).getTime();
        results = results.filter(e => new Date(e.timestamp).getTime() >= start);
      } else if (key === 'endTime') {
        const end = new Date(value).getTime();
        results = results.filter(e => new Date(e.timestamp).getTime() <= end);
      } else if (this.filterableFields.includes(key)) {
        results = results.filter(e => e[key] === value);
      }
    }

    const total = results.length;
    const data = results.slice(offset, offset + limit);

    return { total, offset, limit, data };
  }

  getById(id) {
    return this.entries.find(e => e.id === id) || null;
  }

  getStats() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const fiveMinutesAgo = now - 300000;

    const stats = {
      total: this.entries.length,
      errorCount: this.entries.filter(e => e.statusCode >= 400).length,
      cacheHitCount: this.entries.filter(e => e.cacheHit).length,
      lastMinute: {
        count: 0,
        errors: 0,
        avgDuration: 0
      },
      last5Minutes: {
        count: 0,
        errors: 0,
        avgDuration: 0
      }
    };

    let minuteTotal = 0, minuteCount = 0;
    let fiveMinTotal = 0, fiveMinCount = 0;

    for (const entry of this.entries) {
      const ts = new Date(entry.timestamp).getTime();
      const dur = parseFloat(entry.durationMs);

      if (ts >= oneMinuteAgo) {
        stats.lastMinute.count++;
        minuteCount++;
        minuteTotal += dur;
        if (entry.statusCode >= 400) stats.lastMinute.errors++;
      }
      if (ts >= fiveMinutesAgo) {
        stats.last5Minutes.count++;
        fiveMinCount++;
        fiveMinTotal += dur;
        if (entry.statusCode >= 400) stats.last5Minutes.errors++;
      }
    }

    stats.lastMinute.avgDuration = minuteCount > 0 ? (minuteTotal / minuteCount).toFixed(2) : 0;
    stats.last5Minutes.avgDuration = fiveMinCount > 0 ? (fiveMinTotal / fiveMinCount).toFixed(2) : 0;

    return stats;
  }

  getDistinctValues(field) {
    if (!this.filterableFields.includes(field)) return [];
    const values = new Set();
    for (const entry of this.entries) {
      if (entry[field] !== undefined && entry[field] !== null) {
        values.add(entry[field]);
      }
    }
    return Array.from(values);
  }

  clear() {
    this.entries = [];
  }
}

module.exports = LogStore;
