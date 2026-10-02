import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatGateway, NotificationEnvelope } from './gateway'
import { ApiError } from './gateway'
import { parseDeliveryFailure, parseIncoming, pollNotifications } from './notifications'

const body = (overrides: Record<string, unknown> = {}) => ({
  typeWebhook: 'incomingMessageReceived',
  idMessage: '1763115112345',
  timestamp: 1763115112,
  senderData: { chatId: '10000000' },
  messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Привет' } },
  ...overrides,
})
const envelope = (
  receiptId = 1,
  overrides: Record<string, unknown> = {},
): NotificationEnvelope => ({ receiptId, body: body(overrides) })
const baseGateway = (patch: Partial<ChatGateway>): ChatGateway => ({
  getState: async () => 'authorized',
  getSettings: async () => ({ incomingWebhook: 'yes', webhookUrl: '' }),
  resolvePhone: async () => '10000000',
  sendText: async () => '1',
  receive: async () => null,
  acknowledge: async () => {},
  ...patch,
})

// Fixtures preserve the documented provider structure; all test contacts and IDs are synthetic.
describe('notification parser', () => {
  it('parses incoming plain text and converts seconds to UI milliseconds', () => {
    expect(parseIncoming(body())).toEqual({
      id: '1763115112345',
      chatId: '10000000',
      text: 'Привет',
      timestamp: 1763115112000,
      direction: 'incoming',
    })
  })
  it('rejects timestamps outside the JavaScript Date range before the UI can process them', () => {
    expect(parseIncoming(body({ timestamp: 8_640_000_000_001 }))).toBeNull()
    const lastValid = parseIncoming(body({ timestamp: 8_640_000_000_000 }))
    expect(lastValid?.timestamp).toBe(8_640_000_000_000_000)
    expect(Number.isFinite(new Date(lastValid!.timestamp).getTime())).toBe(true)
  })
  it('parses extended text without rendering previews or markup', () => {
    expect(
      parseIncoming(
        body({
          messageData: {
            typeMessage: 'extendedTextMessage',
            extendedTextMessageData: {
              text: '<script>alert(1)</script> https://green-api.com',
              title: 'ignored',
            },
          },
        }),
      )?.text,
    ).toBe('<script>alert(1)</script> https://green-api.com')
  })
  it.each(['outgoingMessageReceived', 'outgoingAPIMessageReceived'])(
    'recognizes documented outgoing event %s',
    (typeWebhook) => {
      expect(parseIncoming(body({ typeWebhook }))?.direction).toBe('outgoing')
    },
  )
  it.each([
    null,
    [],
    {},
    { typeWebhook: 'outgoingMessageStatus' },
    body({ timestamp: '1763115112' }),
    body({ timestamp: Infinity }),
    body({ timestamp: Number.MAX_VALUE }),
    body({ idMessage: '' }),
    body({ senderData: {} }),
    body({
      messageData: { typeMessage: 'imageMessage', fileMessageData: { caption: 'not text' } },
    }),
  ])('ignores unsupported or malformed payload %#', (payload) => {
    expect(parseIncoming(payload)).toBeNull()
  })
})

describe('outgoing delivery failure parser', () => {
  it.each(['failed', 'noAccount'] as const)(
    'extracts the %s status without provider description',
    (status) => {
      expect(
        parseDeliveryFailure({
          typeWebhook: 'outgoingMessageStatus',
          chatId: '10000000',
          idMessage: '1763115112345',
          status,
          description: 'secret from provider',
        }),
      ).toEqual({ chatId: '10000000', id: '1763115112345', reason: status })
    },
  )
  it('supports the documented failure shape without an idMessage using chatId', () => {
    expect(
      parseDeliveryFailure({
        typeWebhook: 'outgoingMessageStatus',
        chatId: '79991234567@c.us',
        status: 'noAccount',
        sendByApi: true,
      }),
    ).toEqual({ chatId: '79991234567@c.us', reason: 'noAccount' })
  })
  it('does not expose an unusable optional message ID', () => {
    expect(
      parseDeliveryFailure({
        typeWebhook: 'outgoingMessageStatus',
        chatId: '10000000',
        idMessage: { untrusted: true },
        status: 'failed',
      }),
    ).toEqual({ chatId: '10000000', reason: 'failed' })
  })
  it.each([
    null,
    [],
    {},
    { typeWebhook: 'incomingMessageReceived', chatId: '10000000', status: 'failed' },
    { typeWebhook: 'outgoingMessageStatus', status: 'failed' },
    { typeWebhook: 'outgoingMessageStatus', chatId: '  ', status: 'failed' },
    { typeWebhook: 'outgoingMessageStatus', chatId: 123, status: 'failed' },
    { typeWebhook: 'outgoingMessageStatus', chatId: '10000000', status: 'delivered' },
    { typeWebhook: 'outgoingMessageStatus', chatId: '10000000', status: 'read' },
  ])('ignores malformed or non-failure event %#', (payload) => {
    expect(parseDeliveryFailure(payload)).toBeNull()
  })
})

describe('sequential notification polling', () => {
  afterEach(() => vi.useRealTimers())

  it('displays before acknowledging and never overlaps receive calls', async () => {
    const controller = new AbortController()
    const events: string[] = []
    let request = 0
    const gateway = baseGateway({
      receive: async () => {
        events.push('receive')
        return envelope(++request)
      },
      acknowledge: async () => {
        events.push('ack')
        controller.abort()
      },
    })
    await pollNotifications(
      gateway,
      {
        onMessage: async () => {
          await Promise.resolve()
          events.push('display')
        },
        onStatus: () => {},
      },
      controller.signal,
    )
    expect(events).toEqual(['receive', 'display', 'ack'])
  })
  it('processes a delivery failure before acknowledging its receipt', async () => {
    const controller = new AbortController()
    const events: string[] = []
    const gateway = baseGateway({
      receive: async () => ({
        receiptId: 7,
        body: {
          typeWebhook: 'outgoingMessageStatus',
          chatId: '10000000',
          status: 'failed',
          description: 'untrusted secret',
        },
      }),
      acknowledge: async () => {
        events.push('ack')
        controller.abort()
      },
    })
    await pollNotifications(
      gateway,
      {
        onMessage: () => {
          events.push('message')
        },
        onStatus: () => {},
        onDeliveryFailure: async (failure) => {
          await Promise.resolve()
          events.push(JSON.stringify(failure))
        },
      },
      controller.signal,
    )
    expect(events).toEqual([JSON.stringify({ chatId: '10000000', reason: 'failed' }), 'ack'])
  })
  it('does not process the failure callback twice when its ACK is retried', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const events: string[] = []
    let attempts = 0
    const gateway = baseGateway({
      receive: async () => {
        events.push('receive')
        return {
          receiptId: 8,
          body: {
            typeWebhook: 'outgoingMessageStatus',
            chatId: '10000000',
            idMessage: '1763115112345',
            status: 'noAccount',
          },
        }
      },
      acknowledge: async () => {
        events.push('ack')
        if (++attempts === 1) throw new ApiError('Временно недоступно', 503, true)
        controller.abort()
      },
    })
    const pending = pollNotifications(
      gateway,
      {
        onMessage: () => {},
        onStatus: () => {},
        onDeliveryFailure: () => {
          events.push('failure')
        },
      },
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    expect(events).toEqual(['receive', 'failure', 'ack', 'ack'])
  })
  it('does not acknowledge a delivery failure if its handler is interrupted', async () => {
    const controller = new AbortController()
    const acknowledge = vi.fn()
    const gateway = baseGateway({
      receive: async () => ({
        receiptId: 9,
        body: { typeWebhook: 'outgoingMessageStatus', chatId: '10000000', status: 'failed' },
      }),
      acknowledge: async () => {
        acknowledge()
        controller.abort()
      },
    })
    await pollNotifications(
      gateway,
      {
        onMessage: () => {},
        onStatus: () => {},
        onDeliveryFailure: () => {
          controller.abort()
          throw new Error('Handler interrupted')
        },
      },
      controller.signal,
    )
    expect(acknowledge).not.toHaveBeenCalled()
  })
  it('acknowledges duplicates without displaying them again', async () => {
    const controller = new AbortController()
    let receipt = 0
    const messages: string[] = []
    const acknowledged: number[] = []
    const gateway = baseGateway({
      receive: async () => envelope(++receipt),
      acknowledge: async (id) => {
        acknowledged.push(id)
        if (id === 2) controller.abort()
      },
    })
    await pollNotifications(
      gateway,
      {
        onMessage: (message) => {
          messages.push(message.id)
        },
        onStatus: () => {},
      },
      controller.signal,
    )
    expect(messages).toEqual(['1763115112345'])
    expect(acknowledged).toEqual([1, 2])
  })
  it('deduplicates per chat, not only by message ID', async () => {
    const controller = new AbortController()
    let receipt = 0
    const messages: string[] = []
    const gateway = baseGateway({
      receive: async () => envelope(++receipt, { senderData: { chatId: `chat-${receipt}` } }),
      acknowledge: async (id) => {
        if (id === 2) controller.abort()
      },
    })
    await pollNotifications(
      gateway,
      {
        onMessage: (message) => {
          messages.push(message.chatId)
        },
        onStatus: () => {},
      },
      controller.signal,
    )
    expect(messages).toEqual(['chat-1', 'chat-2'])
  })
  it('acknowledges unsupported notifications so the queue is not stuck', async () => {
    const controller = new AbortController()
    const acknowledged: number[] = []
    const gateway = baseGateway({
      receive: async () => envelope(7, { typeWebhook: 'outgoingMessageStatus' }),
      acknowledge: async (id) => {
        acknowledged.push(id)
        controller.abort()
      },
    })
    const onMessage = vi.fn()
    await pollNotifications(gateway, { onMessage, onStatus: () => {} }, controller.signal)
    expect(onMessage).not.toHaveBeenCalled()
    expect(acknowledged).toEqual([7])
  })
  it('retries a failed ACK without receiving or displaying again', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const events: string[] = []
    let attempts = 0
    const gateway = baseGateway({
      receive: async () => {
        events.push('receive')
        return envelope(9)
      },
      acknowledge: async (id) => {
        events.push(`ack-${id}`)
        if (++attempts === 1) throw new ApiError('Временно недоступно', 503, true)
        controller.abort()
      },
    })
    const statuses: string[] = []
    const pending = pollNotifications(
      gateway,
      {
        onMessage: () => {
          events.push('display')
        },
        onStatus: (status) => {
          statuses.push(status.state)
        },
      },
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(999)
    expect(events).toEqual(['receive', 'display', 'ack-9'])
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(events).toEqual(['receive', 'display', 'ack-9', 'ack-9'])
    expect(statuses).toContain('retrying')
  })
  it('backs off after consecutive receive errors', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let attempts = 0
    const retryDelays: number[] = []
    const gateway = baseGateway({
      receive: async () => {
        if (++attempts < 3) throw new ApiError('Временно недоступно', 503, true)
        return envelope()
      },
      acknowledge: async () => {
        controller.abort()
      },
    })
    const pending = pollNotifications(
      gateway,
      {
        onMessage: () => {},
        onStatus: (status) => {
          if (status.retryInMs) retryDelays.push(status.retryInMs)
        },
      },
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(2000)
    await pending
    expect(attempts).toBe(3)
    expect(retryDelays).toEqual([1000, 2000])
  })
  it('resets backoff after successfully processing a notification', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let attempts = 0
    const retryDelays: number[] = []
    const gateway = baseGateway({
      receive: async () => {
        attempts++
        if (attempts === 1 || attempts === 2 || attempts === 4)
          throw new ApiError('Временно недоступно', 503, true)
        return envelope(attempts, { idMessage: String(attempts) })
      },
      acknowledge: async (receiptId) => {
        if (receiptId === 5) controller.abort()
      },
    })
    const pending = pollNotifications(
      gateway,
      {
        onMessage: () => {},
        onStatus: (status) => {
          if (status.retryInMs) retryDelays.push(status.retryInMs)
        },
      },
      controller.signal,
    )
    await vi.runAllTimersAsync()
    await pending
    expect(retryDelays).toEqual([1000, 2000, 1000])
  })
  it('caps backoff at 30 seconds during prolonged outages', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let attempts = 0
    const retryDelays: number[] = []
    const gateway = baseGateway({
      receive: async () => {
        if (++attempts === 8) controller.abort()
        throw new ApiError('Временно недоступно', 503, true)
      },
    })
    const pending = pollNotifications(
      gateway,
      {
        onMessage: () => {},
        onStatus: (status) => {
          if (status.retryInMs) retryDelays.push(status.retryInMs)
        },
      },
      controller.signal,
    )
    await vi.runAllTimersAsync()
    await pending
    expect(retryDelays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
  it('reprocesses the same pending message if its callback initially fails', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const events: string[] = []
    let displays = 0
    const gateway = baseGateway({
      receive: async () => {
        events.push('receive')
        return envelope()
      },
      acknowledge: async () => {
        events.push('ack')
        controller.abort()
      },
    })
    const pending = pollNotifications(
      gateway,
      {
        onMessage: () => {
          events.push('display')
          if (++displays === 1) throw new Error('Temporary handler error')
        },
        onStatus: () => {},
      },
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(999)
    expect(events).toEqual(['receive', 'display'])
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(events).toEqual(['receive', 'display', 'display', 'ack'])
  })
  it('stops instead of retrying unauthorized credentials forever', async () => {
    let attempts = 0
    const statuses: string[] = []
    const gateway = baseGateway({
      receive: async () => {
        attempts++
        throw new ApiError('Проверьте доступ', 401, false)
      },
    })
    await pollNotifications(
      gateway,
      {
        onMessage: () => {},
        onStatus: (status) => {
          statuses.push(status.state)
        },
      },
      new AbortController().signal,
    )
    expect(attempts).toBe(1)
    expect(statuses.at(-1)).toBe('stopped')
  })
  it('stops promptly when aborted during backoff', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let attempts = 0
    const gateway = baseGateway({
      receive: async () => {
        attempts++
        throw new ApiError('Временно недоступно', 503, true)
      },
    })
    const pending = pollNotifications(
      gateway,
      { onMessage: () => {}, onStatus: () => {} },
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await pending
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not display or ACK a late response after logout', async () => {
    const controller = new AbortController()
    const onMessage = vi.fn()
    const acknowledge = vi.fn()
    const gateway = baseGateway({
      receive: async () => {
        controller.abort()
        return envelope()
      },
      acknowledge,
    })
    await pollNotifications(gateway, { onMessage, onStatus: () => {} }, controller.signal)
    expect(onMessage).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()
  })
  it('does not ACK a message the application could not process', async () => {
    const controller = new AbortController()
    const acknowledge = vi.fn()
    const gateway = baseGateway({ receive: async () => envelope(), acknowledge })
    await pollNotifications(
      gateway,
      {
        onMessage: () => {
          controller.abort()
          throw new Error('Render failed')
        },
        onStatus: () => {},
      },
      controller.signal,
    )
    expect(acknowledge).not.toHaveBeenCalled()
  })
  it('does not spin on an immediately empty response and aborts its idle wait', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let attempts = 0
    const gateway = baseGateway({
      receive: async () => {
        attempts++
        return null
      },
    })
    const pending = pollNotifications(
      gateway,
      { onMessage: () => {}, onStatus: () => {} },
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(1)
    controller.abort()
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('lost ACK response recovery', () => {
  afterEach(() => vi.useRealTimers())

  it('re-reads the queue after bounded ACK failures and processes a later reply', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const received: number[] = []
    const displayed: string[] = []
    const acknowledgements: number[] = []
    const gateway = baseGateway({
      receive: async () => {
        const id = received.length + 1
        received.push(id)
        return envelope(id, { idMessage: `message-${id}` })
      },
      acknowledge: async (id) => {
        acknowledgements.push(id)
        if (id === 1) throw new ApiError('Уведомление не найдено', 500, true)
        controller.abort()
      },
    })
    const running = pollNotifications(
      gateway,
      {
        onMessage: (message) => {
          displayed.push(message.id)
        },
        onStatus: () => {},
      },
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(7000)
    controller.abort()
    await running
    expect(received).toEqual([1, 2])
    expect(acknowledgements).toEqual([1, 1, 1, 2])
    expect(displayed).toEqual(['message-1', 'message-2'])
  })

  it('does not redisplay a delivery failure when re-reading returns the same receipt', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let receives = 0
    let acknowledgements = 0
    const displayFailure = vi.fn()
    const gateway = baseGateway({
      receive: async () => {
        receives++
        return {
          receiptId: 12,
          body: { typeWebhook: 'outgoingMessageStatus', chatId: '42', status: 'failed' },
        }
      },
      acknowledge: async () => {
        if (++acknowledgements <= 3) throw new ApiError('Временно недоступно', 500, true)
        controller.abort()
      },
    })
    const running = pollNotifications(
      gateway,
      { onMessage: () => {}, onStatus: () => {}, onDeliveryFailure: displayFailure },
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(7000)
    controller.abort()
    await running
    expect(receives).toBe(2)
    expect(acknowledgements).toBe(4)
    expect(displayFailure).toHaveBeenCalledOnce()
  })
})
