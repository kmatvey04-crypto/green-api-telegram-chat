import { useEffect, useReducer, useRef, useState } from 'react'
import {
  ApiError,
  normalizePhone,
  pollNotifications,
  type ChatGateway,
  type PollStatus,
} from '../api'
import { chatReducer } from '../chat'
import { demoChats } from '../demo'
export function useChat(gateway: ChatGateway, demo: boolean) {
  const [chats, dispatch] = useReducer(chatReducer, demo ? demoChats() : [])
  const [status, setStatus] = useState<PollStatus>({ state: 'connecting' })
  const [retryKey, setRetryKey] = useState(0)
  const lifetime = useRef(new AbortController())
  const pendingSends = useRef(new Set<string>())
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [gateway])
  useEffect(() => {
    const controller = new AbortController()
    if (!demo)
      void pollNotifications(
        gateway,
        {
          onMessage: (message) => {
            if (!controller.signal.aborted) dispatch({ type: 'receive', message })
          },
          onDeliveryFailure: (failure) => {
            if (!controller.signal.aborted) dispatch({ type: 'deliveryFailure', ...failure })
          },
          onStatus: (value) => {
            if (!controller.signal.aborted) setStatus(value)
          },
        },
        controller.signal,
      )
    return () => controller.abort()
  }, [gateway, demo, retryKey])
  async function openChat(phone: string, signal: AbortSignal) {
    const normalized = normalizePhone(phone)
    const combined = AbortSignal.any([signal, lifetime.current.signal])
    const id = await gateway.resolvePhone(normalized, combined)
    if (combined.aborted) return null
    dispatch({ type: 'open', id, label: `+${normalized}` })
    return id
  }
  async function send(chatId: string, text: string) {
    if (!text.trim() || text.length > 4096 || pendingSends.current.has(chatId)) return false
    const signal = lifetime.current.signal
    if (signal.aborted) return false
    pendingSends.current.add(chatId)
    const key = crypto.randomUUID()
    dispatch({
      type: 'send',
      chatId,
      message: { key, text, timestamp: Date.now(), direction: 'outgoing', status: 'sending' },
    })
    try {
      const id = await gateway.sendText(chatId, text, signal)
      if (signal.aborted) return false
      dispatch({ type: 'sent', chatId, key, id })
      return true
    } catch {
      if (!signal.aborted) dispatch({ type: 'uncertain', chatId, key })
      return false
    } finally {
      pendingSends.current.delete(chatId)
    }
  }
  return { chats, status, openChat, send, retry: () => setRetryKey((key) => key + 1) }
}
export function safeError(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : 'Не удалось создать чат. Проверьте соединение и повторите попытку.'
}
