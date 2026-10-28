/**
 * GET /api/messages/:msgId — fetch a single message including card data.
 *
 * Only accessible via bot Bearer token (bots need this to check receipt.ask
 * state after a restart when their in-memory cache is empty).
 *
 * Returns 403 if the caller is not a bot, 404 if the message does not exist
 * or is deleted.
 */
import { botUserFromRequest, messageService } from '../../../src/context.js'

export async function GET(req) {
  const bot = await botUserFromRequest(req)
  if (!bot?.user_id) return new Response('Unauthorized', { status: 401 })

  const msgId = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  const msg = messageService.getMessageById(msgId)
  if (!msg || msg.deleted_at) return new Response('Not Found', { status: 404 })

  return Response.json({
    msg_id:       msg.msg_id,
    channel_id:   msg.channel_id,
    user_id:      msg.user_id,
    ts:           msg.ts,
    text:         msg.text,
    parent_msg_id: msg.parent_msg_id ?? null,
    card:         msg.card ?? null,
  })
}
