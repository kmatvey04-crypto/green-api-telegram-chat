import { useEffect, useRef, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { safeError } from '../hooks/useChat'
type Props = {
  onClose: () => void
  onCreated: (id: string) => void
  openChat: (phone: string, signal: AbortSignal) => Promise<string | null>
  demo: boolean
}
export function NewChatDialog({ onClose, onCreated, openChat, demo }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const request = useRef<AbortController | null>(null)
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => {
      request.current?.abort()
      dialog?.close()
    }
  }, [])
  function close() {
    request.current?.abort()
    ref.current?.close()
    onClose()
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError('')
    try {
      const id = await openChat(phone, controller.signal)
      if (!controller.signal.aborted && id) {
        ref.current?.close()
        onCreated(id)
        onClose()
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(safeError(e))
    } finally {
      if (!controller.signal.aborted) {
        request.current = null
        setLoading(false)
      }
    }
  }
  return (
    <dialog
      ref={ref}
      className="new-chat-dialog"
      aria-labelledby="new-chat-title"
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <div className="dialog-heading">
        <h2 id="new-chat-title">Новый чат</h2>
        <button className="icon-button" onClick={close} aria-label="Закрыть">
          <X size={20} />
        </button>
      </div>
      <p>Введите номер получателя с кодом страны</p>
      <form onSubmit={submit}>
        <label htmlFor="recipient">Номер телефона</label>
        <input
          autoFocus
          id="recipient"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+7 900 000-00-00"
          autoComplete="off"
          required
          disabled={loading}
        />
        <p className="field-help">
          {demo
            ? 'Демо: номер не будет отправлен в Telegram'
            : 'GREEN-API найдёт Telegram по номеру. Настройки приватности получателя могут ограничить поиск.'}
        </p>
        {error && (
          <p role="alert" className="error-box">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={close}>
            Отмена
          </button>
          <button type="submit" className="primary" disabled={loading}>
            {loading ? 'Ищем…' : 'Создать чат'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
