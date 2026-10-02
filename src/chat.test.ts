import { describe, it, expect } from 'vitest'
import { chatReducer, type Chat, type Message } from './chat'
const pending: Message = {
  key: 'local-1',
  text: 'Привет',
  timestamp: 100,
  direction: 'outgoing',
  status: 'sending',
}
const base: Chat[] = [{ id: '42', label: '+79000000000', messages: [] }]
describe('chat state', () => {
  it('deduplicates repeated text notifications', () => {
    const action = {
      type: 'receive' as const,
      message: {
        id: 'a',
        chatId: '42',
        text: 'Ответ',
        timestamp: 200,
        direction: 'incoming' as const,
      },
    }
    const once = chatReducer(base, action)
    expect(chatReducer(once, action)[0].messages).toHaveLength(1)
  })
  it('merges a send response if an outgoing notification arrived first', () => {
    const sent = chatReducer(base, { type: 'send', chatId: '42', message: pending })
    const notified = chatReducer(sent, {
      type: 'receive',
      message: {
        id: 'server-id',
        chatId: '42',
        text: 'Привет',
        timestamp: 100,
        direction: 'outgoing',
      },
    })
    const acknowledged = chatReducer(notified, {
      type: 'sent',
      chatId: '42',
      key: 'local-1',
      id: 'server-id',
    })
    expect(acknowledged[0].messages).toEqual([{ ...pending, id: 'server-id', status: 'queued' }])
  })
  it('keeps identical text with different server ids', () => {
    const first = chatReducer(base, {
      type: 'receive',
      message: { id: 'a', chatId: '42', text: 'ok', timestamp: 100, direction: 'incoming' },
    })
    const second = chatReducer(first, {
      type: 'receive',
      message: { id: 'b', chatId: '42', text: 'ok', timestamp: 200, direction: 'incoming' },
    })
    expect(second[0].messages).toHaveLength(2)
  })
  it('does not duplicate an existing phone chat', () => {
    expect(chatReducer(base, { type: 'open', id: '42', label: '+79000000000' })).toHaveLength(1)
  })
  it('preserves uncertain send for explicit user decision', () => {
    const sent = chatReducer(base, { type: 'send', chatId: '42', message: pending })
    const failed = chatReducer(sent, { type: 'uncertain', chatId: '42', key: 'local-1' })
    expect(failed[0].messages[0].status).toBe('uncertain')
  })
})

describe('authoritative delivery failures', () => {
  it('keeps a failure received before the send HTTP response', () => {
    const pendingChat = chatReducer(base, { type: 'send', chatId: '42', message: pending })
    const failure = chatReducer(pendingChat, {
      type: 'deliveryFailure',
      chatId: '42',
      id: 'server-id',
      reason: 'failed',
    })
    const sent = chatReducer(failure, {
      type: 'sent',
      chatId: '42',
      key: 'local-1',
      id: 'server-id',
    })
    expect(sent[0].messages[0].status).toBe('failed')
    expect(sent[0].deliveryError).toContain('ошибк')
  })
  it('shows a chat-level failure when the provider omits idMessage', () => {
    const state = chatReducer(base, { type: 'deliveryFailure', chatId: '42', reason: 'noAccount' })
    expect(state[0].deliveryError).toContain('не найден')
  })
})

it('does not remove an incoming message when acknowledging an outgoing id collision', () => {
  let state = chatReducer(base, {
    type: 'receive',
    message: {
      id: 'same-id',
      chatId: '42',
      text: 'Входящее',
      timestamp: 200,
      direction: 'incoming',
    },
  })
  state = chatReducer(state, { type: 'send', chatId: '42', message: pending })
  state = chatReducer(state, { type: 'sent', chatId: '42', key: 'local-1', id: 'same-id' })
  expect(state[0].messages).toHaveLength(2)
})
