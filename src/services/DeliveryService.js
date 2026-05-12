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

  advanceMention({ channelId, userId, mentionSeq }) {
    this.deliveryRepo.advanceMention({ channelId, userId, mentionSeq })
  }

  buildDigestData({ userId }) {
    return this.deliveryRepo.buildDigestData({ userId })
  }
}
