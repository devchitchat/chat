export class SearchService {
  constructor({ searchRepo }) {
    this.searchRepo = searchRepo
    this.useFts = searchRepo.isFtsEnabled()
  }

  indexMessage({ msg_id, channel_id, seq, user_id, ts, text }) {
    this.searchRepo.indexMessage({ msg_id, channel_id, seq, user_id, ts, text })
  }

  removeMessage({ msgId }) {
    this.searchRepo.removeMessage({ msgId })
  }

  searchMessages({ channelId, query, limit = 50 }) {
    if (this.useFts) {
      return this.searchRepo.searchFts({ channelId, query, limit })
    }
    return this.searchRepo.searchLike({ channelId, query, limit })
  }

  searchGlobal({ channelIds, query, limit = 20 }) {
    if (!channelIds?.length) return []
    if (this.useFts) {
      return this.searchRepo.searchFtsGlobal({ channelIds, query, limit })
    }
    return this.searchRepo.searchLikeGlobal({ channelIds, query, limit })
  }
}
