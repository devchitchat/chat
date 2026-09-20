export class TokenUsageService {
  constructor({ tokenUsageRepo }) {
    this.repo = tokenUsageRepo
  }

  record(entry) {
    this.repo.insert({ ...entry, ts: entry.ts ?? Date.now() })
  }

  getDashboard({ sinceTs = 0 } = {}) {
    return {
      summary:    this.repo.summary({ sinceTs }),
      byActor:    this.repo.byActor({ sinceTs }),
      byChannel:  this.repo.byChannel({ sinceTs }),
      byRepo:     this.repo.byRepo({ sinceTs }),
      recent:     this.repo.recent({ sinceTs, limit: 50 }),
    }
  }
}
