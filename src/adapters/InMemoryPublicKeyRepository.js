export class InMemoryPublicKeyRepository {
  constructor() {
    this._keys = new Map()  // userId → { user_id, public_key_jwk, created_at, updated_at }
  }

  getByUserId({ userId }) {
    return this._keys.get(userId) ?? null
  }

  upsert({ userId, publicKeyJwk, now }) {
    const existing = this._keys.get(userId)
    this._keys.set(userId, {
      user_id:        userId,
      public_key_jwk: publicKeyJwk,
      created_at:     existing?.created_at ?? now,
      updated_at:     now,
    })
  }
}
