import { test, expect, describe, beforeEach } from 'bun:test'
import { SignalingService } from '../src/services/SignalingService.js'
import { ServiceError } from '../src/util/errors.js'

describe('SignalingService', () => {
  let svc

  beforeEach(() => { svc = new SignalingService() })

  test('createCall returns a call for a room', () => {
    const call = svc.createCall({ roomId: 'room1', createdByUserId: 'u1' })
    expect(call.call_id).toBeTruthy()
    expect(call.room_id).toBe('room1')
  })

  test('createCall for same room returns existing call', () => {
    const a = svc.createCall({ roomId: 'room1', createdByUserId: 'u1' })
    const b = svc.createCall({ roomId: 'room1', createdByUserId: 'u2' })
    expect(a.call_id).toBe(b.call_id)
  })

  test('joinCall assigns unique peer IDs', () => {
    const { call_id } = svc.createCall({ roomId: 'room1', createdByUserId: 'u1' })
    const r1 = svc.joinCall({ callId: call_id, userId: 'u1' })
    const r2 = svc.joinCall({ callId: call_id, userId: 'u2' })
    expect(r1.peerId).not.toBe(r2.peerId)
  })

  test('joinCall includes existing peers in response', () => {
    const { call_id } = svc.createCall({ roomId: 'room1', createdByUserId: 'u1' })
    const { peerId: p1 } = svc.joinCall({ callId: call_id, userId: 'u1' })
    const { peers } = svc.joinCall({ callId: call_id, userId: 'u2' })
    expect(peers.map(p => p.peer_id)).toContain(p1)
  })

  test('routeOffer emits rtc.offer_event', () => {
    const { call_id } = svc.createCall({ roomId: 'room1', createdByUserId: 'u1' })
    const { peerId: p1 } = svc.joinCall({ callId: call_id, userId: 'u1' })
    const { peerId: p2 } = svc.joinCall({ callId: call_id, userId: 'u2' })

    const events = []
    svc.onEvent(e => events.push(e))
    svc.routeOffer({ callId: call_id, fromPeerId: p1, toPeerId: p2, sdp: 'sdp-offer' })

    expect(events).toHaveLength(1)
    expect(events[0].t).toBe('rtc.offer_event')
    expect(events[0].body.to_peer_id).toBe(p2)
  })

  test('leaveCall ends call when last peer leaves', () => {
    const { call_id } = svc.createCall({ roomId: 'room1', createdByUserId: 'u1' })
    const { peerId } = svc.joinCall({ callId: call_id, userId: 'u1' })
    const result = svc.leaveCall({ callId: call_id, peerId })
    expect(result.ended).toBe(true)
    expect(svc.getCall(call_id)).toBeUndefined()
  })
})
