import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useChat } from './useChat'
import type { ChatGateway } from '../api'
import { ApiError } from '../api'
it('restarting reception never aborts a send in flight', async () => {
  let sendSignal: AbortSignal | undefined
  let finishSend: (id: string) => void = () => {}
  const gateway: ChatGateway = {
    getState: async () => 'authorized',
    getSettings: async () => ({ incomingWebhook: 'yes', webhookUrl: '' }),
    resolvePhone: async () => '42',
    sendText: (_id, _text, signal) => {
      sendSignal = signal
      return new Promise((resolve) => {
        finishSend = resolve
      })
    },
    receive: async () => {
      throw new ApiError('Проверка', 401)
    },
    acknowledge: async () => {},
  }
  const { result } = renderHook(() => useChat(gateway, false))
  await act(async () => {
    await result.current.openChat('+79990000000', new AbortController().signal)
  })
  let send: Promise<boolean>
  act(() => {
    send = result.current.send('42', 'Привет')
  })
  await waitFor(() => expect(sendSignal).toBeDefined())
  act(() => result.current.retry())
  expect(sendSignal?.aborted).toBe(false)
  await act(async () => {
    finishSend('server-id')
    await send
  })
  expect(result.current.chats[0].messages[0].status).toBe('queued')
})
describe('chat cancellation', () => {
  it('ignores a late resolvePhone after the dialog was closed', async () => {
    let resolve: (id: string) => void = () => {}
    const gateway: ChatGateway = {
      getState: async () => 'authorized',
      getSettings: async () => ({}),
      resolvePhone: () =>
        new Promise((r) => {
          resolve = r
        }),
      sendText: async () => '',
      receive: async () => null,
      acknowledge: async () => {},
    }
    const { result } = renderHook(() => useChat(gateway, true))
    const controller = new AbortController()
    const promise = result.current.openChat('+79990000000', controller.signal)
    controller.abort()
    await act(async () => {
      resolve('42')
      await promise
    })
    expect(result.current.chats).toHaveLength(1)
  })
})
