/** De-duplicates repeated AI matches into one trigger per continuous scene. */
class RuleEpisodeGate {
  constructor() { this.activeBySource = new Map(); }

  update(source, matchedIds) {
    const next = new Set(Array.isArray(matchedIds) ? matchedIds : []);
    const previous = this.activeBySource.get(source) || new Set();
    const activeElsewhere = new Set([...this.activeBySource.entries()]
      .filter(([other]) => other !== source)
      .flatMap(([, ids]) => [...ids]));
    const entered = [...next].filter(id => !previous.has(id) && !activeElsewhere.has(id));
    this.activeBySource.set(source, next);
    return entered;
  }
}

module.exports = { RuleEpisodeGate };
