/** GREEN-API Telegram HTTP adapter. Credentials stay in this in-memory closure. */
export interface Credentials {
  apiUrl: string
  idInstance: string
  apiTokenInstance: string
}

export interface NotificationEnvelope {
  receiptId: number
  body: unknown
}

export interface InstanceSettings {
  incomingWebhook?: string
  webhookUrl?: string
}

export interface ChatGateway {
  getState(signal: AbortSignal): Promise<string>
  getSettings(signal: AbortSignal): Promise<InstanceSettings>
  resolvePhone(phone: string, signal: AbortSignal): Promise<string>
  sendText(chatId: string, message: string, signal: AbortSignal): Promise<string>
  receive(signal: AbortSignal): Promise<NotificationEnvelope | null>
  acknowledge(receiptId: number, signal: AbortSignal): Promise<void>
}

export const MAX_TEXT_LENGTH = 4096

/** Only application-authored, non-sensitive messages may be passed to this error. */
export class ApiError extends Error {
  readonly status?: number
  readonly retryable: boolean

  constructor(message: string, status?: number, retryable = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryable = retryable
  }
}

export function normalizePhone(phone: string): string {
  const value = phone.trim()
  const digits = value.replace(/[\s()-]/g, '').replace(/^\+/, '')
  if (!/^\+?[\d\s()-]+$/.test(value) || !/^[1-9]\d{6,14}$/.test(digits)) {
    throw new ApiError(
      'Введите номер в международном формате с кодом страны, например +7 999 123-45-67.',
    )
  }
  return digits
}

export function validateCredentials(credentials: Credentials): Credentials {
  let url: URL
  try {
    url = new URL(credentials.apiUrl.trim())
  } catch {
    throw new ApiError('Введите apiUrl из личного кабинета GREEN-API: https://…green-api.com.')
  }
  // A user-entered destination must never receive a token unless it is a GREEN-API host.
  if (
    url.protocol !== 'https:' ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+green-api\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new ApiError(
      'apiUrl должен быть HTTPS-адресом сервера GREEN-API без пути, порта и параметров.',
    )
  }
  const idInstance = credentials.idInstance.trim()
  const apiTokenInstance = credentials.apiTokenInstance.trim()
  if (!/^\d+$/.test(idInstance)) {
    throw new ApiError('idInstance должен содержать только цифры.')
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(apiTokenInstance)) {
    throw new ApiError('Введите корректный apiTokenInstance из личного кабинета GREEN-API.')
  }
  return { apiUrl: url.origin, idInstance, apiTokenInstance }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(): ApiError {
  return new ApiError('GREEN-API вернул неожиданный ответ. Попробуйте позже.', undefined, true)
}

function uncertainSend(status?: number): ApiError {
  return new ApiError(
    'Не удалось подтвердить отправку. Сообщение могло уйти: проверьте чат в Telegram перед повторной попыткой.',
    status,
    false,
  )
}

function abortError(): DOMException {
  // Do not forward signal.reason: callers or browsers can put sensitive data there.
  return new DOMException('Запрос отменён.', 'AbortError')
}

function httpError(status: number): ApiError {
  if (status === 401 || status === 403) {
    return new ApiError('Нет доступа к инстансу. Проверьте idInstance и apiTokenInstance.', status)
  }
  if (status === 429) {
    return new ApiError('Достигнут лимит запросов GREEN-API. Подождите немного.', status, true)
  }
  if (status >= 500 || status === 408) {
    return new ApiError(
      'GREEN-API временно недоступен. Повторим получение автоматически.',
      status,
      true,
    )
  }
  if (status === 400) {
    return new ApiError(
      'GREEN-API отклонил запрос. Проверьте данные и настройки уведомлений в личном кабинете.',
      status,
    )
  }
  return new ApiError(`Не удалось выполнить запрос к GREEN-API (HTTP ${status}).`, status)
}

export function createGreenApiGateway(
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
): ChatGateway {
  const validated = validateCredentials(credentials)
  const baseUrl = `${validated.apiUrl}/waInstance${validated.idInstance}`
  const token = validated.apiTokenInstance

  async function request(
    methodName: string,
    method: 'GET' | 'POST' | 'DELETE',
    signal: AbortSignal,
    payload?: unknown,
    suffix = '',
  ): Promise<unknown> {
    if (signal.aborted) throw abortError()
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    // ReceiveNotification waits up to 20s; leave 10s for network/server overhead.
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetcher(`${baseUrl}/${methodName}/${token}${suffix}`, {
        method,
        signal: controller.signal,
        ...(payload === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      })
      if (signal.aborted) throw abortError()
      if (!response.ok) throw httpError(response.status)
      // Never forward provider error text, response URLs, or arbitrary exception messages.
      const text = await response.text()
      if (signal.aborted) throw abortError()
      if (!text.trim() && methodName === 'receiveNotification') return null
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw invalidResponse()
      }
    } catch (error) {
      if (signal.aborted) throw abortError()
      if (methodName === 'sendMessage') {
        if (error instanceof ApiError && !error.retryable) throw error
        throw uncertainSend(error instanceof ApiError ? error.status : undefined)
      }
      if (error instanceof ApiError) throw error
      throw new ApiError(
        'Не удалось связаться с GREEN-API. Проверьте интернет и apiUrl.',
        undefined,
        true,
      )
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }

  return {
    async getState(signal) {
      const result = await request('getStateInstance', 'GET', signal)
      if (!record(result) || typeof result.stateInstance !== 'string' || !result.stateInstance)
        throw invalidResponse()
      return result.stateInstance
    },
    async getSettings(signal) {
      const result = await request('getSettings', 'GET', signal)
      if (!record(result)) throw invalidResponse()
      // GetSettings can contain webhookUrlToken: never retain or return that field.
      return {
        ...(typeof result.incomingWebhook === 'string'
          ? { incomingWebhook: result.incomingWebhook }
          : {}),
        ...(typeof result.webhookUrl === 'string' ? { webhookUrl: result.webhookUrl } : {}),
      }
    },
    async resolvePhone(phone, signal) {
      const phoneNumber = Number(normalizePhone(phone))
      const result = await request('checkAccount', 'POST', signal, { phoneNumber })
      if (!record(result) || typeof result.exist !== 'boolean') throw invalidResponse()
      if (!result.exist) {
        throw new ApiError(
          'Аккаунт Telegram не найден или номер скрыт настройками приватности. Проверьте номер и настройки получателя.',
        )
      }
      if (typeof result.chatId !== 'string' || !result.chatId) throw invalidResponse()
      return result.chatId
    },
    async sendText(chatId, message, signal) {
      if (!chatId.trim()) throw new ApiError('Сначала выберите чат.')
      if (!message.trim()) throw new ApiError('Введите текст сообщения.')
      if (message.length > MAX_TEXT_LENGTH)
        throw new ApiError(`Сообщение должно быть не длиннее ${MAX_TEXT_LENGTH} символов.`)
      // Deliberately no automatic retry: a lost response does not mean a send failed.
      const result = await request('sendMessage', 'POST', signal, { chatId, message })
      if (!record(result) || typeof result.idMessage !== 'string' || !result.idMessage)
        throw uncertainSend()
      return result.idMessage
    },
    async receive(signal) {
      const result = await request(
        'receiveNotification',
        'GET',
        signal,
        undefined,
        '?receiveTimeout=20',
      )
      if (result === null) return null
      if (
        !record(result) ||
        !Number.isSafeInteger(result.receiptId) ||
        Number(result.receiptId) < 0 ||
        !('body' in result)
      )
        throw invalidResponse()
      return { receiptId: result.receiptId as number, body: result.body }
    },
    async acknowledge(receiptId, signal) {
      if (!Number.isSafeInteger(receiptId) || receiptId < 0)
        throw new ApiError('Некорректный идентификатор уведомления.')
      const result = await request(
        'deleteNotification',
        'DELETE',
        signal,
        undefined,
        `/${receiptId}`,
      )
      if (!record(result) || typeof result.result !== 'boolean') throw invalidResponse()
      // result:false also means already deleted (e.g. lost prior ACK response).
      // Re-reading the queue is safe and avoids retrying a stale receipt forever.
    },
  }
}
