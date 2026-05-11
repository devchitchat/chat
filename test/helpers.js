import { Database } from 'bun:sqlite'
import { initDb } from '../src/db/initDb.js'
import { AuthService } from '../src/services/AuthService.js'
import { HubService } from '../src/services/HubService.js'
import { ChannelService } from '../src/services/ChannelService.js'
import { MessageService } from '../src/services/MessageService.js'
import { DeliveryService } from '../src/services/DeliveryService.js'
import { SearchService } from '../src/services/SearchService.js'
import { SqliteAuthRepository } from '../src/adapters/SqliteAuthRepository.js'
import { SqliteHubRepository } from '../src/adapters/SqliteHubRepository.js'
import { SqliteChannelRepository } from '../src/adapters/SqliteChannelRepository.js'
import { SqliteMessageRepository } from '../src/adapters/SqliteMessageRepository.js'
import { SqliteDeliveryRepository } from '../src/adapters/SqliteDeliveryRepository.js'
import { SqliteSearchRepository } from '../src/adapters/SqliteSearchRepository.js'

export function createTestContext() {
  const db = new Database(':memory:')
  initDb(db)

  let now = Date.now()
  const nowFn = () => now
  const advanceTime = (ms) => { now += ms }

  const authRepo = new SqliteAuthRepository({ db })
  const hubRepo = new SqliteHubRepository({ db })
  const channelRepo = new SqliteChannelRepository({ db })
  const searchRepo = new SqliteSearchRepository({ db })
  const messageRepo = new SqliteMessageRepository({ db })
  const deliveryRepo = new SqliteDeliveryRepository({ db })

  const auth = new AuthService({ authRepo, nowFn, bootstrapToken: 'test-bootstrap' })
  const hubService = new HubService({ hubRepo, nowFn })
  const channelService = new ChannelService({ channelRepo, hubService, nowFn })
  const searchService = new SearchService({ searchRepo })
  const messageService = new MessageService({ messageRepo, nowFn, channelService, searchService })
  const deliveryService = new DeliveryService({ deliveryRepo, nowFn })

  async function insertUser({ handle = 'testuser', displayName = 'Test User', roles = ['user'], password = 'secret' } = {}) {
    const result = await auth.redeemInvite({
      inviteToken: 'test-bootstrap',
      profile: { handle, display_name: displayName },
      password,
    })
    return result.user
  }

  return { db, auth, hubService, channelService, messageService, deliveryService, searchService, nowFn, advanceTime, insertUser }
}
