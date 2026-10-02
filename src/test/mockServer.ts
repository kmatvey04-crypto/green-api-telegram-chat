import { vi } from 'vitest'
import type { NotificationEnvelope } from '../api'
export function mockServer() {
  const queue: NotificationEnvelope[] = []
  let receiver: ((value: NotificationEnvelope) => void) | undefined
  const requests: { method: string; url: string; body: unknown }[] = []
  let state: unknown = { stateInstance: 'authorized' }
  let settings: unknown = { incomingWebhook: 'yes', webhookUrl: '' }
  let resolveState: (() => Promise<unknown>) | undefined
  let resolvePhone: (() => Promise<unknown>) | undefined
  let send: (() => Promise<Response>) | undefined
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    let payload: unknown
    if (url.includes('/getStateInstance/')) payload = resolveState ? await resolveState() : state
    else if (url.includes('/getSettings/')) payload = settings
    else if (url.includes('/checkAccount/'))
      payload = resolvePhone ? await resolvePhone() : { exist: true, chatId: '42' }
    else if (url.includes('/sendMessage/')) {
      if (send) return send()
      payload = { idMessage: 'sent-1' }
    } else if (url.includes('/deleteNotification/')) payload = { result: true }
    else if (url.includes('/receiveNotification/')) {
      payload =
        queue.shift() ??
        (await new Promise<NotificationEnvelope>((resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'))
            return
          }
          const abort = () => {
            receiver = undefined
            reject(new DOMException('Aborted', 'AbortError'))
          }
          signal?.addEventListener('abort', abort, { once: true })
          receiver = (value) => {
            signal?.removeEventListener('abort', abort)
            receiver = undefined
            resolve(value)
          }
        }))
    } else throw new Error('Unexpected test endpoint')
    return new Response(JSON.stringify(payload), { status: 200 })
  })
  return {
    fetcher,
    requests,
    emit: (event: NotificationEnvelope) => {
      if (receiver) receiver(event)
      else queue.push(event)
    },
    setState: (value: unknown) => {
      state = value
    },
    setSettings: (value: unknown) => {
      settings = value
    },
    holdState: (fn: () => Promise<unknown>) => {
      resolveState = fn
    },
    holdPhone: (fn: () => Promise<unknown>) => {
      resolvePhone = fn
    },
    onSend: (fn: () => Promise<Response>) => {
      send = fn
    },
  }
}
export function incoming(
  receiptId: number,
  idMessage = 'in-1',
  text = 'Ответ получателя',
): NotificationEnvelope {
  return {
    receiptId,
    body: {
      typeWebhook: 'incomingMessageReceived',
      idMessage,
      timestamp: 1755591519,
      senderData: { chatId: '42' },
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
    },
  }
}
export function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
