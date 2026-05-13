export class DeliveryService {
  constructor({ deliveryRepo, nowFn = () => Date.now() }) {
    this.deliveryRepo = deliveryRepo
    this.nowFn = nowFn
  }

  getOrCreate({ channelId, userId }) {
    const existing = this.deliveryRepo.findByChannelAndUser({ channelId, userId })
    if (existing) return existing
    return this.deliveryRepo.create({ channelId, userId, now: this.nowFn() })
  }

  advance({ channelId, userId, afterSeq }) {
    this.deliveryRepo.advance({ channelId, userId, afterSeq, now: this.nowFn() })
  }

  advanceMention({ channelId, userId, mentionSeq, priority = 'normal' }) {
    // Ensure a delivery row exists before updating mention_seq.
    // If Linda has never navigated to this channel, there is no row yet and
    // the UPDATE in advanceMention would silently affect 0 rows, losing the mention.
    this.getOrCreate({ channelId, userId })
    this.deliveryRepo.advanceMention({ channelId, userId, mentionSeq, priority })
  }

  buildDigestData({ userId }) {
    return this.deliveryRepo.buildDigestData({ userId })
  }
}
