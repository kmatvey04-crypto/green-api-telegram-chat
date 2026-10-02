import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import App from './App'
import { createGreenApiGateway } from './api'
import { deferred, incoming, mockServer } from './test/mockServer'
const credentials = {
  apiUrl: 'https://7105.api.green-api.com',
  idInstance: '7105000000',
  apiTokenInstance: 'FakeTestTokenNotACredential',
}
async function fillConnection() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('apiUrl'), credentials.apiUrl)
  await user.type(screen.getByLabelText('idInstance'), credentials.idInstance)
  await user.type(screen.getByLabelText('apiTokenInstance'), credentials.apiTokenInstance)
  await user.click(screen.getByRole('checkbox'))
  await user.click(screen.getByRole('button', { name: 'Подключиться' }))
  return user
}
async function start(server = mockServer()) {
  render(
    <StrictMode>
      <App gatewayFactory={(c) => createGreenApiGateway(c, server.fetcher)} />
    </StrictMode>,
  )
  const user = await fillConnection()
  await screen.findByRole('heading', { name: 'Чаты' })
  return { user, server }
}
async function openChat(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole('button', { name: 'Новый чат' })[0])
  await user.type(screen.getByLabelText('Номер телефона'), '+7 (999) 000-00-00')
  await user.click(screen.getByRole('button', { name: 'Создать чат' }))
  await screen.findByRole('heading', { name: '+79990000000' })
}
describe('mocked HTTP application integration', () => {
  it('completes send/receive/ACK with numeric resolved chatId, duplicates and literal text rendering', async () => {
    const { user, server } = await start()
    await openChat(user)
    expect(server.requests.find((r) => r.url.includes('/checkAccount/'))?.body).toEqual({
      phoneNumber: 79990000000,
    })
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Привет!')
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }))
    await screen.findByText('Принято API')
    expect(server.requests.find((r) => r.url.includes('/sendMessage/'))?.body).toEqual({
      chatId: '42',
      message: 'Привет!',
    })
    act(() => {
      server.emit(incoming(1, 'in-1', 'Ответ <script>не код</script>'))
      server.emit(incoming(2, 'in-1', 'Ответ <script>не код</script>'))
      server.emit({ receiptId: 3, body: { typeWebhook: 'stateInstanceChanged' } })
    })
    await screen.findByText('Ответ <script>не код</script>', { selector: '.message p' })
    await waitFor(() =>
      expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(3),
    )
    expect(
      within(screen.getByRole('log')).getAllByText('Ответ <script>не код</script>', {
        exact: true,
      }),
    ).toHaveLength(1)
    expect(screen.getByRole('log').querySelector('script')).toBeNull()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    await user.click(screen.getByRole('button', { name: 'Отключиться' }))
    expect(screen.getByLabelText('apiTokenInstance')).toHaveValue('')
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
  })
  it('guards repeated send submits synchronously and clears draft only after acceptance', async () => {
    const server = mockServer()
    const response = deferred<Response>()
    server.onSend(() => response.promise)
    const { user } = await start(server)
    await openChat(user)
    const input = screen.getByRole('textbox', { name: 'Сообщение' })
    await user.type(input, 'Один запрос')
    const form = input.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    await waitFor(() =>
      expect(server.requests.filter((r) => r.url.includes('/sendMessage/'))).toHaveLength(1),
    )
    expect(input).toBeDisabled()
    expect(input).toHaveValue('Один запрос')
    await act(async () =>
      response.resolve(new Response(JSON.stringify({ idMessage: 'send-once' }))),
    )
    await waitFor(() => expect(input).toHaveValue(''))
    expect(input).toBeEnabled()
  })
  it('does not auto-retry uncertain send or erase its draft', async () => {
    const server = mockServer()
    server.onSend(async () => new Response('{}', { status: 500 }))
    const { user } = await start(server)
    await openChat(user)
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Проверьте доставку')
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }))
    await screen.findByText('Не подтверждено')
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('Проверьте доставку')
    expect(server.requests.filter((r) => r.url.includes('/sendMessage/'))).toHaveLength(1)
  })
  it('keeps authoritative failure arriving before send response and acknowledges it', async () => {
    const server = mockServer()
    const response = deferred<Response>()
    server.onSend(() => response.promise)
    const { user } = await start(server)
    await openChat(user)
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Проверка')
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }))
    act(() =>
      server.emit({
        receiptId: 99,
        body: {
          typeWebhook: 'outgoingMessageStatus',
          chatId: '42',
          idMessage: 'sent-1',
          status: 'failed',
          description: 'private raw error must not render',
        },
      }),
    )
    await screen.findByRole('alert')
    await act(async () => response.resolve(new Response(JSON.stringify({ idMessage: 'sent-1' }))))
    await screen.findByText('Не отправлено')
    expect(screen.queryByText('private raw error must not render')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(server.requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/99'))).toBe(
        true,
      ),
    )
  })
  it('cancels login and ignores late authorization response', async () => {
    const server = mockServer()
    const state = deferred<unknown>()
    server.holdState(() => state.promise)
    render(<App gatewayFactory={(c) => createGreenApiGateway(c, server.fetcher)} />)
    const user = await fillConnection()
    await user.click(screen.getByRole('button', { name: 'Отменить подключение' }))
    await act(async () => state.resolve({ stateInstance: 'authorized' }))
    expect(screen.getByRole('heading', { name: 'Подключить Telegram' })).toBeVisible()
    expect(server.requests.some((r) => r.url.includes('/getSettings/'))).toBe(false)
  })
  it('closing new-chat dialog aborts lookup and late result creates no chat', async () => {
    const server = mockServer()
    const phone = deferred<unknown>()
    server.holdPhone(() => phone.promise)
    const { user } = await start(server)
    await user.click(screen.getAllByRole('button', { name: 'Новый чат' })[0])
    await user.type(screen.getByLabelText('Номер телефона'), '+79990000000')
    await user.click(screen.getByRole('button', { name: 'Создать чат' }))
    await user.click(screen.getByRole('button', { name: 'Закрыть' }))
    await act(async () => phone.resolve({ exist: true, chatId: '42' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '+79990000000' })).not.toBeInTheDocument()
    expect(screen.getByText('Пока нет чатов')).toBeVisible()
  })
  it('rejects a production webhook setup without changing any settings', async () => {
    const server = mockServer()
    server.setSettings({ incomingWebhook: 'yes', webhookUrl: 'https://existing.example/webhook' })
    render(<App gatewayFactory={(c) => createGreenApiGateway(c, server.fetcher)} />)
    await fillConnection()
    expect(await screen.findByRole('alert')).toHaveTextContent('webhookUrl пустым')
    expect(server.requests.map((r) => r.method)).toEqual(['GET', 'GET'])
  })
  it('does not send credentials to an arbitrary API host', async () => {
    const factory = vi.fn()
    render(<App gatewayFactory={factory} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('apiUrl'), 'https://evil.example')
    await user.type(screen.getByLabelText('idInstance'), '123')
    await user.type(screen.getByLabelText('apiTokenInstance'), 'FakeToken')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Подключиться' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTPS-адресом сервера GREEN-API')
    expect(factory).not.toHaveBeenCalled()
  })
  it('demo never fetches and resets on reconnect', async () => {
    const factory = vi.fn()
    render(<App gatewayFactory={factory} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Открыть демо' }))
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Локальный текст{Enter}')
    await screen.findByText('Локально')
    expect(factory).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Отключиться' }))
    await user.click(screen.getByRole('button', { name: 'Открыть демо' }))
    expect(within(screen.getByRole('log')).queryByText('Локальный текст')).not.toBeInTheDocument()
  })
})
