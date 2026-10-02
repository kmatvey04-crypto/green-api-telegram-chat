import { ApiError, type ChatGateway, type NotificationEnvelope } from './gateway'

export interface ChatMessage {
  id: string
  chatId: string
  text: string
  /** Unix time in milliseconds, converted from GREEN-API's seconds. */
  timestamp: number
  direction: 'incoming' | 'outgoing'
}

export interface DeliveryFailure {
  chatId: string
  id?: string
  reason: 'failed' | 'noAccount'
}

/** Failure status examples may omit idMessage. Never expose the provider's description. */
export function parseDeliveryFailure(body: unknown): DeliveryFailure | null {
  if (
    !record(body) ||
    body.typeWebhook !== 'outgoingMessageStatus' ||
    typeof body.chatId !== 'string' ||
    !body.chatId.trim() ||
    (body.status !== 'failed' && body.status !== 'noAccount')
  )
    return null
  return {
    chatId: body.chatId,
    ...(typeof body.idMessage === 'string' && body.idMessage.trim() ? { id: body.idMessage } : {}),
    reason: body.status,
  }
}

export interface PollStatus {
  state: 'connecting' | 'connected' | 'retrying' | 'stopped'
  message?: string
  retryInMs?: number
}

export interface PollCallbacks {
  onMessage: (message: ChatMessage) => void | Promise<void>
  onStatus: (status: PollStatus) => void
  onDeliveryFailure?: (failure: DeliveryFailure) => void | Promise<void>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only documented incoming/outgoing text events become chat messages. */
export function parseIncoming(body: unknown): ChatMessage | null {
  if (!record(body)) return null
  const direction =
    body.typeWebhook === 'incomingMessageReceived'
      ? 'incoming'
      : body.typeWebhook === 'outgoingMessageReceived' ||
          body.typeWebhook === 'outgoingAPIMessageReceived'
        ? 'outgoing'
        : null
  if (
    !direction ||
    typeof body.idMessage !== 'string' ||
    !body.idMessage ||
    typeof body.timestamp !== 'number' ||
    !Number.isFinite(body.timestamp) ||
    !Number.isSafeInteger(body.timestamp * 1000) ||
    !Number.isFinite(new Date(body.timestamp * 1000).getTime()) ||
    body.timestamp < 0 ||
    !record(body.senderData) ||
    typeof body.senderData.chatId !== 'string' ||
    !body.senderData.chatId ||
    !record(body.messageData)
  )
    return null
  const data = body.messageData
  const text =
    data.typeMessage === 'textMessage' && record(data.textMessageData)
      ? data.textMessageData.textMessage
      : data.typeMessage === 'extendedTextMessage' && record(data.extendedTextMessageData)
        ? data.extendedTextMessageData.text
        : null
  if (typeof text !== 'string') return null
  return {
    id: body.idMessage,
    chatId: body.senderData.chatId,
    text,
    timestamp: body.timestamp * 1000,
    direction,
  }
}

/** Resolves on cancellation too, so disconnect never leaves a rejected timer promise. */
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** One queue consumer per session. A pending receipt is processed before fetching again. */
export async function pollNotifications(
  gateway: ChatGateway,
  callbacks: PollCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const seen = new Set<string>()
  const processedReceipts = new Set<number>()
  let pending: NotificationEnvelope | null = null
  let pendingProcessed = false
  let failures = 0
  let ackFailures = 0
  let stoppedMessage: string | undefined
  callbacks.onStatus({ state: 'connecting' })

  while (!signal.aborted) {
    try {
      if (pending === null) {
        pending = await gateway.receive(signal)
        if (signal.aborted) break
        pendingProcessed = pending !== null && processedReceipts.has(pending.receiptId)
        ackFailures = 0
      }
      if (pending === null) {
        failures = 0
        callbacks.onStatus({ state: 'connected' })
        // Usually the server has long-polled. Also protect against an immediate empty response.
        await pause(300, signal)
        continue
      }
      if (!pendingProcessed) {
        const message = parseIncoming(pending.body)
        if (message) {
          const key = JSON.stringify([message.chatId, message.direction, message.id])
          if (!seen.has(key)) {
            await callbacks.onMessage(message)
            if (signal.aborted) break
            seen.add(key)
            // Bounded session memory. The UI also deduplicates its retained message history.
            if (seen.size > 5000) {
              const oldest = seen.values().next().value
              if (oldest !== undefined) seen.delete(oldest)
            }
          }
        }
        const deliveryFailure = parseDeliveryFailure(pending.body)
        if (deliveryFailure && callbacks.onDeliveryFailure) {
          await callbacks.onDeliveryFailure(deliveryFailure)
          if (signal.aborted) break
        }
        pendingProcessed = true
        processedReceipts.add(pending.receiptId)
        if (processedReceipts.size > 5000) {
          const oldest = processedReceipts.values().next().value
          if (oldest !== undefined) processedReceipts.delete(oldest)
        }
      }
      if (signal.aborted) break
      // ACK unsupported events too so the text/failure notification queue keeps moving.
      await gateway.acknowledge(pending.receiptId, signal)
      if (signal.aborted) break
      pending = null
      pendingProcessed = false
      failures = 0
      ackFailures = 0
      callbacks.onStatus({ state: 'connected' })
    } catch (error) {
      if (signal.aborted) break
      if (error instanceof ApiError && !error.retryable) {
        stoppedMessage = error.message
        break
      }
      // A successful deletion can lose its response; subsequent deletes can return
      // HTTP 500 "message not found". After three ACK attempts, re-read the queue
      // instead of retrying a stale receipt forever. Keep processed/seen caches so
      // the same head, if still present, is acknowledged without redisplaying it.
      if (pending !== null && pendingProcessed && ++ackFailures >= 3) {
        pending = null
        pendingProcessed = false
        ackFailures = 0
      }
      const retryInMs = Math.min(1000 * 2 ** Math.min(failures++, 5), 30_000)
      callbacks.onStatus({
        state: 'retrying',
        message:
          error instanceof ApiError
            ? error.message
            : 'Получение сообщений прервано. Пробуем восстановить соединение.',
        retryInMs,
      })
      await pause(retryInMs, signal)
    }
  }
  callbacks.onStatus({ state: 'stopped', ...(stoppedMessage ? { message: stoppedMessage } : {}) })
}
