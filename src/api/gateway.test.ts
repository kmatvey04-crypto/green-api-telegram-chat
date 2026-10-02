import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createGreenApiGateway, normalizePhone, validateCredentials } from './gateway'

const credentials = {
  apiUrl: 'https://4100.api.green-api.com',
  idInstance: '4100000000',
  apiTokenInstance: 'test-token-never-a-real-secret',
}
const signal = () => new AbortController().signal
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('credential and phone validation', () => {
  it('normalizes an international phone without guessing a country', () => {
    expect(normalizePhone(' +7 (999) 123-45-67 ')).toBe('79991234567')
    expect(normalizePhone('1 202 555 0123')).toBe('12025550123')
  })
  it.each(['', 'abc79991234567', '7+9991234567', '123', '079991234567', '1234567890123456'])(
    'rejects invalid phone %s',
    (phone) => {
      expect(() => normalizePhone(phone)).toThrow(ApiError)
    },
  )
  it('normalizes whitespace and a host trailing slash', () => {
    expect(
      validateCredentials({
        ...credentials,
        apiUrl: ` ${credentials.apiUrl}/ `,
        idInstance: ' 4100000000 ',
        apiTokenInstance: ' test-token-never-a-real-secret ',
      }),
    ).toEqual(credentials)
  })
  it.each([
    'http://4100.api.green-api.com',
    'https://green-api.com.evil.test',
    'https://evil.test/green-api.com',
    'https://green-api.com',
    'https://evil@4100.api.green-api.com',
    'https://4100.api.green-api.com:8443',
    'https://4100.api.green-api.com/collect',
    'https://4100.api.green-api.com?token=x',
    'https://4100.api.green-api.com/#x',
  ])('rejects unsafe credential destinations %s', (apiUrl) => {
    expect(() => validateCredentials({ ...credentials, apiUrl })).toThrow(ApiError)
  })
  it('rejects empty and path-shaped instance credentials without exposing them', () => {
    for (const patch of [
      { idInstance: '../token' },
      { idInstance: '' },
      { apiTokenInstance: '' },
      { apiTokenInstance: 'sensitive/token' },
    ]) {
      expect(() => validateCredentials({ ...credentials, ...patch })).toThrow(ApiError)
    }
  })
})

describe('GREEN-API Telegram HTTP contract', () => {
  afterEach(() => vi.useRealTimers())
  it('checks authorization and exposes only notification settings', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ stateInstance: 'authorized' }))
      .mockResolvedValueOnce(
        json({ incomingWebhook: 'yes', webhookUrl: '', webhookUrlToken: 'do-not-expose' }),
      )
    const gateway = createGreenApiGateway(credentials, fetcher)
    const abortSignal = signal()
    await expect(gateway.getState(abortSignal)).resolves.toBe('authorized')
    await expect(gateway.getSettings(abortSignal)).resolves.toEqual({
      incomingWebhook: 'yes',
      webhookUrl: '',
    })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${credentials.apiUrl}/waInstance4100000000/getStateInstance/${credentials.apiTokenInstance}`,
      `${credentials.apiUrl}/waInstance4100000000/getSettings/${credentials.apiTokenInstance}`,
    ])
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
  })
  it('resolves phone to the server chat ID instead of constructing a phone chat ID', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ exist: true, chatId: '10000000', phoneNumber: 79991234567 }))
    const gateway = createGreenApiGateway(credentials, fetcher)
    await expect(gateway.resolvePhone('+7 (999) 123-45-67', signal())).resolves.toBe('10000000')
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `${credentials.apiUrl}/waInstance4100000000/checkAccount/${credentials.apiTokenInstance}`,
    )
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ phoneNumber: 79991234567 }),
      headers: { 'Content-Type': 'application/json' },
    })
  })
  it('explains a privacy-hidden or missing account without claiming which occurred', async () => {
    const gateway = createGreenApiGateway(credentials, async () =>
      json({ exist: false, chatId: '' }),
    )
    await expect(gateway.resolvePhone('79991234567', signal())).rejects.toThrow(/приватност/)
  })
  it('sends text once with the resolved chat ID and returns the queued message ID', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ idMessage: '1763115112345' }))
    const gateway = createGreenApiGateway(credentials, fetcher)
    await expect(gateway.sendText('10000000', 'Привет 👋\nВторая строка', signal())).resolves.toBe(
      '1763115112345',
    )
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `${credentials.apiUrl}/waInstance4100000000/sendMessage/${credentials.apiTokenInstance}`,
    )
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ chatId: '10000000', message: 'Привет 👋\nВторая строка' }),
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects blank, oversized text and missing chat IDs before a request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const gateway = createGreenApiGateway(credentials, fetcher)
    await expect(gateway.sendText('10000000', '  ', signal())).rejects.toThrow(ApiError)
    await expect(gateway.sendText('10000000', 'x'.repeat(4097), signal())).rejects.toThrow(ApiError)
    await expect(gateway.sendText('', 'hello', signal())).rejects.toThrow(ApiError)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('receives an envelope with a documented 20-second long poll then deletes its receipt', async () => {
    const envelope = { receiptId: 1234567, body: { typeWebhook: 'stateInstanceChanged' } }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(envelope))
      .mockResolvedValueOnce(json({ result: true, reason: '' }))
    const gateway = createGreenApiGateway(credentials, fetcher)
    await expect(gateway.receive(signal())).resolves.toEqual(envelope)
    await expect(gateway.acknowledge(1234567, signal())).resolves.toBeUndefined()
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `${credentials.apiUrl}/waInstance4100000000/receiveNotification/${credentials.apiTokenInstance}?receiveTimeout=20`,
    )
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `${credentials.apiUrl}/waInstance4100000000/deleteNotification/${credentials.apiTokenInstance}/1234567`,
    )
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' })
  })
  it('accepts null or an empty long-poll response as an empty queue', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(null))
      .mockResolvedValueOnce(new Response(''))
    const gateway = createGreenApiGateway(credentials, fetcher)
    await expect(gateway.receive(signal())).resolves.toBeNull()
    await expect(gateway.receive(signal())).resolves.toBeNull()
  })
  it('does not block the queue after an already removed receipt', async () => {
    const gateway = createGreenApiGateway(credentials, async () =>
      json({ result: false, reason: 'already removed' }),
    )
    await expect(gateway.acknowledge(1234567, signal())).resolves.toBeUndefined()
  })
  it('rejects malformed response shapes', async () => {
    const gateway = createGreenApiGateway(credentials, async () => json({ unexpected: true }))
    await expect(gateway.getState(signal())).rejects.toThrow(ApiError)
    await expect(gateway.resolvePhone('79991234567', signal())).rejects.toThrow(ApiError)
    await expect(gateway.sendText('10000000', 'hello', signal())).rejects.toThrow(ApiError)
    await expect(gateway.receive(signal())).rejects.toThrow(ApiError)
    await expect(gateway.acknowledge(1234567, signal())).rejects.toThrow(ApiError)
  })
  it('never leaks provider error text, URL, or token and never retries a send', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ error: `${credentials.apiUrl}/${credentials.apiTokenInstance}` }, 401),
      )
    const gateway = createGreenApiGateway(credentials, fetcher)
    const error = await gateway
      .sendText('10000000', 'hello', signal())
      .catch((value: unknown) => value)
    expect(error).toBeInstanceOf(ApiError)
    expect(String(error)).not.toContain(credentials.apiTokenInstance)
    expect(String(error)).not.toContain(credentials.apiUrl)
    expect(error).toMatchObject({ status: 401, retryable: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('sanitizes network failures and labels send outcome as uncertain', async () => {
    const gateway = createGreenApiGateway(credentials, async () => {
      throw new Error(`Request to ${credentials.apiUrl}/${credentials.apiTokenInstance} failed`)
    })
    const error = await gateway
      .sendText('10000000', 'hello', signal())
      .catch((value: unknown) => value)
    expect(String(error)).not.toContain(credentials.apiTokenInstance)
    expect(String(error)).toMatch(/подтвердить отправку/)
  })
  it.each([500, 503])(
    'labels HTTP %i send failures as uncertain and never retryable',
    async (status) => {
      const gateway = createGreenApiGateway(credentials, async () =>
        json({ error: credentials.apiTokenInstance }, status),
      )
      const error = await gateway
        .sendText('10000000', 'hello', signal())
        .catch((value: unknown) => value)
      expect(error).toMatchObject({ status, retryable: false })
      expect(String(error)).toMatch(/подтвердить отправку/)
      expect(String(error)).not.toContain(credentials.apiTokenInstance)
    },
  )
  it('does not imply a malformed send response proves non-delivery', async () => {
    const gateway = createGreenApiGateway(credentials, async () => json({ unexpected: true }))
    await expect(gateway.sendText('10000000', 'hello', signal())).rejects.toThrow(
      /подтвердить отправку/,
    )
  })
  it('bounds an unresponsive request and cleans up its timeout', async () => {
    vi.useFakeTimers()
    const fetcher: typeof fetch = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      })
    const gateway = createGreenApiGateway(credentials, fetcher)
    const pending = gateway.receive(signal()).catch((value: unknown) => value)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toMatchObject({ name: 'ApiError', retryable: true })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('aborts before fetching with a safe AbortError', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const controller = new AbortController()
    controller.abort(credentials.apiTokenInstance)
    const gateway = createGreenApiGateway(credentials, fetcher)
    await expect(gateway.getState(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('passes aborts to the in-flight request', async () => {
    const controller = new AbortController()
    const fetcher: typeof fetch = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      })
    const gateway = createGreenApiGateway(credentials, fetcher)
    const pending = gateway.receive(controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
