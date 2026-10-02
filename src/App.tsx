import { useEffect, useRef, useState } from 'react'
import {
  ApiError,
  createGreenApiGateway,
  validateCredentials,
  type ChatGateway,
  type Credentials,
} from './api'
import { ConnectForm } from './components/ConnectForm'
import { ChatSession } from './components/ChatSession'
import { createDemoGateway } from './demo'

type Props = { gatewayFactory?: (credentials: Credentials) => ChatGateway }
export default function App({ gatewayFactory = createGreenApiGateway }: Props) {
  const [session, setSession] = useState<{ gateway: ChatGateway; demo: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  function cancel() {
    pending.current?.abort()
    pending.current = null
    setLoading(false)
    setError('')
  }
  async function connect(input: Credentials) {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setLoading(true)
    setError('')
    try {
      const gateway = gatewayFactory(validateCredentials(input))
      const state = await gateway.getState(controller.signal)
      if (controller.signal.aborted) return
      if (state !== 'authorized') throw new Error('unauthorized')
      const settings = await gateway.getSettings(controller.signal)
      if (controller.signal.aborted) return
      if (settings.webhookUrl || settings.incomingWebhook !== 'yes') {
        setError(
          'Включите incomingWebhook = yes и оставьте webhookUrl пустым в настройках отдельного тестового инстанса. Затем повторите подключение.',
        )
        return
      }
      setSession({ gateway, demo: false })
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof ApiError
            ? e.message
            : e instanceof Error && e.message === 'unauthorized'
              ? 'Инстанс не авторизован. Подключите Telegram в личном кабинете GREEN-API.'
              : 'Не удалось подключиться. Проверьте сеть и данные инстанса.',
        )
    } finally {
      if (pending.current === controller) {
        pending.current = null
        setLoading(false)
      }
    }
  }
  if (session)
    return (
      <ChatSession
        gateway={session.gateway}
        demo={session.demo}
        onDisconnect={() => {
          cancel()
          setSession(null)
        }}
      />
    )
  return (
    <ConnectForm
      loading={loading}
      error={error}
      onConnect={connect}
      onCancel={cancel}
      onDemo={() => {
        cancel()
        setSession({ gateway: createDemoGateway(), demo: true })
      }}
    />
  )
}
