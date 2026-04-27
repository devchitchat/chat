import { test, expect, beforeEach } from 'bun:test'
import { UserSettingsService } from '../src/services/UserSettingsService.js'
import { InMemoryUserSettingsRepository } from '../src/adapters/InMemoryUserSettingsRepository.js'

let repo, service

beforeEach(() => {
  repo = new InMemoryUserSettingsRepository()
  service = new UserSettingsService({ userSettingsRepo: repo })
})

test('getSettings returns empty settings for unknown user', () => {
  const result = service.getSettings('u_unknown')
  expect(result).toEqual({ settings: {}, updated_at: 0 })
})

test('putSettings persists allowed keys', () => {
  service.putSettings('u1', { last_channel_id: 'c_abc' }, 1000)
  const result = service.getSettings('u1')
  expect(result.settings.last_channel_id).toBe('c_abc')
  expect(result.updated_at).toBe(1000)
})

test('putSettings persists mobile_chat_open', () => {
  service.putSettings('u1', { mobile_chat_open: true }, 1000)
  expect(service.getSettings('u1').settings.mobile_chat_open).toBe(true)
})

test('putSettings strips unknown keys', () => {
  service.putSettings('u1', { last_channel_id: 'c_abc', evil_key: 'bad' }, 1000)
  const { settings } = service.getSettings('u1')
  expect(settings.evil_key).toBeUndefined()
  expect(settings.last_channel_id).toBe('c_abc')
})

test('putSettings merges with existing settings', () => {
  service.putSettings('u1', { last_channel_id: 'c_abc' }, 1000)
  service.putSettings('u1', { mobile_chat_open: false }, 2000)
  const { settings } = service.getSettings('u1')
  expect(settings.last_channel_id).toBe('c_abc')
  expect(settings.mobile_chat_open).toBe(false)
})

test('putSettings last-write-wins: newer timestamp overwrites', () => {
  service.putSettings('u1', { last_channel_id: 'c_old' }, 1000)
  service.putSettings('u1', { last_channel_id: 'c_new' }, 2000)
  expect(service.getSettings('u1').settings.last_channel_id).toBe('c_new')
})

test('putSettings last-write-wins: stale write does not overwrite newer', () => {
  service.putSettings('u1', { last_channel_id: 'c_new' }, 2000)
  service.putSettings('u1', { last_channel_id: 'c_old' }, 1000)
  expect(service.getSettings('u1').settings.last_channel_id).toBe('c_new')
})
