import { test, expect, beforeEach } from 'bun:test'
import { SignalingService } from '../src/services/SignalingService.js'
import { InMemorySignalingRepository } from '../src/adapters/InMemorySignalingRepository.js'
import { ServiceError } from '../src/util/errors.js'

let repo, service

beforeEach(() => {
  repo = new InMemorySignalingRepository()
  service = new SignalingService({ signalingRepo: repo, nowFn: () => 1000000 })
})

// ── createCall ────────────────────────────────────────────────────────────────

test('createCall creates a new call and persists it', () => {
  const result = service.createCall({ roomId: 'c_1', createdByUserId: 'u_1' })
  expect(result.call_id).toMatch(/^call_/)
  expect(result.room_id).toBe('c_1')
  expect(result.topology).toBe('mesh')
  expect(repo.findActiveByChannel({ channelId: 'c_1' })).not.toBeNull()
})

test('createCall returns existing call for same channel', () => {
  const a = service.createCall({ roomId: 'c_1', createdByUserId: 'u_1' })
  const b = service.createCall({ roomId: 'c_1', createdByUserId: 'u_2' })
  expect(a.call_id).toBe(b.call_id)
})

test('createCall restores call from repo when not in memory', () => {
  // Simulate a call already in the repo (e.g. from a previous server run)
  repo.insertCall({ callId: 'call_restored', channelId: 'c_1', createdByUserId: 'u_1', topology: 'mesh', startedAt: 999 })
  const freshService = new SignalingService({ signalingRepo: repo })
  const result = freshService.createCall({ roomId: 'c_1', createdByUserId: 'u_2' })
  expect(result.call_id).toBe('call_restored')
})

// ── joinCall ──────────────────────────────────────────────────────────────────

test('joinCall returns peerId and full peer list', () => {
  const call = service.createCall({ roomId: 'c_1', createdByUserId: 'u_1' })
  const result = service.joinCall({ callId: call.call_id, userId: 'u_1' })
  expect(result.peerId).toMatch(/^peer_/)
  expect(result.peers).toHaveLength(1)
  expect(result.peers[0].user_id).toBe('u_1')
})

test('joinCall persists participant', () => {
  const call = service.createCall({ roomId: 'c_1', createdByUserId: 'u_1' })
  const { peerId } = service.joinCall({ callId: call.call_id, userId: 'u_1' })
  expect(repo._participants.find(p => p.peer_id === peerId)).toBeTruthy()
})

test('joinCall throws NOT_FOUND for unknown call', () => {
  expect(() => service.joinCall({ callId: 'call_nope', userId: 'u_1' })).toThrow(ServiceError)
})

// ── leaveCall ─────────────────────────────────────────────────────────────────

test('leaveCall removes peer and marks participant left in repo', () => {
  const call = service.createCall({ roomId: 'c_1', createdByUserId: 'u_1' })
  const { peerId } = service.joinCall({ callId: call.call_id, userId: 'u_1' })
  service.joinCall({ callId: call.call_id, userId: 'u_2' })

  const result = service.leaveCall({ callId: call.call_id, peerId })
  expect(result.removed).toBe(true)
  expect(result.ended).toBe(false)
  expect(repo._participants.find(p => p.peer_id === peerId)?.left_at).not.toBeNull()
})

test('leaveCall ends call when last peer leaves', () => {
  const call = service.createCall({ roomId: 'c_1', createdByUserId: 'u_1' })
  const { peerId } = service.joinCall({ callId: call.call_id, userId: 'u_1' })
  const result = service.leaveCall({ callId: call.call_id, peerId })
  expect(result.ended).toBe(true)
  expect(result.room_id).toBe('c_1')
  expect(repo.findActiveByChannel({ channelId: 'c_1' })).toBeNull()
})

test('leaveCall returns removed:false for unknown call', () => {
  const result = service.leaveCall({ callId: 'call_nope', peerId: 'peer_nope' })
  expect(result.removed).toBe(false)
})

// ── joinOrSwitch ──────────────────────────────────────────────────────────────

test('joinOrSwitch joins normally when peer has no prior call', () => {
  const { call_id } = service.createCall({ roomId: 'c_1', createdByUserId: 'u_1' })
  const result = service.joinOrSwitch({ callId: call_id, userId: 'u_1', displayName: 'Alice', currentPeerId: null, currentCallId: null })
  expect(result.status).toBe('joined')
  expect(result.peerId).toMatch(/^peer_/)
  expect(result.peers).toHaveLength(1)
  expect(result.previousLeft).toBeUndefined()
})

test('joinOrSwitch returns already_in_call when peer is already in this call', () => {
  const { call_id } = service.createCall({ roomId: 'c_1', createdByUserId: 'u_1' })
  const joined = service.joinCall({ callId: call_id, userId: 'u_1', displayName: 'Alice' })
  const result = service.joinOrSwitch({ callId: call_id, userId: 'u_1', displayName: 'Alice', currentPeerId: joined.peerId, currentCallId: call_id })
  expect(result.status).toBe('already_in_call')
  expect(result.peerId).toBe(joined.peerId)
  expect(result.peers).toHaveLength(1)
})

test('joinOrSwitch switches calls when peer is in a different call', () => {
  const { call_id: call_a } = service.createCall({ roomId: 'c_1', createdByUserId: 'u_1' })
  const { call_id: call_b } = service.createCall({ roomId: 'c_2', createdByUserId: 'u_2' })
  service.joinCall({ callId: call_a, userId: 'u_2', displayName: 'Bob' })  // another peer in call_a so it won't end
  const { peerId: peerInA } = service.joinCall({ callId: call_a, userId: 'u_1', displayName: 'Alice' })

  const result = service.joinOrSwitch({ callId: call_b, userId: 'u_1', displayName: 'Alice', currentPeerId: peerInA, currentCallId: call_a })
  expect(result.status).toBe('switched')
  expect(result.peerId).toMatch(/^peer_/)
  expect(result.peers).toHaveLength(1)
  expect(result.previousLeft.call_id).toBe(call_a)
  expect(result.previousLeft.room_id).toBe('c_1')
  expect(result.previousLeft.peerId).toBe(peerInA)
  expect(result.previousLeft.removed).toBe(true)
  expect(result.previousLeft.ended).toBe(false)
  // peer is no longer in call_a
  expect(service.getCall(call_a)?.peers.has(peerInA)).toBe(false)
})

test('joinOrSwitch switches calls and the previous call ends when last peer leaves', () => {
  const { call_id: call_a } = service.createCall({ roomId: 'c_1', createdByUserId: 'u_1' })
  const { call_id: call_b } = service.createCall({ roomId: 'c_2', createdByUserId: 'u_2' })
  const { peerId: peerInA } = service.joinCall({ callId: call_a, userId: 'u_1', displayName: 'Alice' })

  const result = service.joinOrSwitch({ callId: call_b, userId: 'u_1', displayName: 'Alice', currentPeerId: peerInA, currentCallId: call_a })
  expect(result.status).toBe('switched')
  expect(result.previousLeft.ended).toBe(true)
  expect(result.previousLeft.room_id).toBe('c_1')
  expect(service.getCall(call_a)).toBeUndefined()
})

// ── getActiveCallForChannel ───────────────────────────────────────────────────

test('getActiveCallForChannel returns null when no call', () => {
  expect(service.getActiveCallForChannel('c_1')).toBeNull()
})

test('getActiveCallForChannel returns call after createCall', () => {
  service.createCall({ roomId: 'c_1', createdByUserId: 'u_1' })
  expect(service.getActiveCallForChannel('c_1')).not.toBeNull()
})

// ── startup restore ───────────────────────────────────────────────────────────

test('startup restores active calls from repo', () => {
  repo.insertCall({ callId: 'call_alive', channelId: 'c_1', createdByUserId: 'u_1', topology: 'mesh', startedAt: 999 })
  repo.insertCall({ callId: 'call_dead', channelId: 'c_2', createdByUserId: 'u_1', topology: 'mesh', startedAt: 888 })
  repo.endCall({ callId: 'call_dead', endedAt: 900 })

  const freshService = new SignalingService({ signalingRepo: repo })
  expect(freshService.getCall('call_alive')).toBeTruthy()
  expect(freshService.getCall('call_dead')).toBeUndefined()
})
