import { useState, type FormEvent } from 'react'
import { ArrowRight, ExternalLink, MessageCircle, ShieldCheck } from 'lucide-react'
import type { Credentials } from '../api'
type Props = {
  loading: boolean
  error: string
  onConnect: (values: Credentials) => void
  onCancel: () => void
  onDemo: () => void
}
export function ConnectForm({ loading, error, onConnect, onCancel, onDemo }: Props) {
  const [apiUrl, setApiUrl] = useState('')
  const [idInstance, setId] = useState('')
  const [apiTokenInstance, setToken] = useState('')
  const [isolated, setIsolated] = useState(false)
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!loading && isolated) onConnect({ apiUrl, idInstance, apiTokenInstance })
  }
  return (
    <main className="connect-page">
      <div className="connect-brand">
        <MessageCircle aria-hidden="true" />
        <span>
          Чаты <span className="muted">/ GREEN-API</span>
        </span>
      </div>
      <section className="connect-card" aria-labelledby="connect-title">
        <div className="connect-heading">
          <span className="brand-tile">
            <MessageCircle size={30} aria-hidden="true" />
          </span>
          <h1 id="connect-title">Подключить Telegram</h1>
          <p>
            Введите данные своего инстанса GREEN-API,
            <br className="desktop-break" /> чтобы отправлять и получать сообщения
          </p>
        </div>
        <form onSubmit={submit}>
          <fieldset disabled={loading}>
            <label htmlFor="apiUrl">apiUrl</label>
            <input
              id="apiUrl"
              type="url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://…api.green-api.com"
              autoComplete="off"
              required
              spellCheck={false}
            />
            <p className="field-help">Адрес API из личного кабинета GREEN-API</p>
            <label htmlFor="idInstance">idInstance</label>
            <input
              id="idInstance"
              value={idInstance}
              onChange={(e) => setId(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Идентификатор инстанса"
              required
              spellCheck={false}
            />
            <label htmlFor="apiTokenInstance">apiTokenInstance</label>
            <input
              id="apiTokenInstance"
              type="password"
              value={apiTokenInstance}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              placeholder="Токен доступа"
              required
              spellCheck={false}
            />
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={isolated}
                onChange={(e) => setIsolated(e.target.checked)}
              />
              <span>
                Использую отдельный тестовый инстанс. Этот чат будет забирать и удалять уведомления
                из его очереди
              </span>
            </label>
          </fieldset>
          {error && (
            <p className="error-box" role="alert">
              {error}
            </p>
          )}
          <button className="primary connect-submit" disabled={loading || !isolated} type="submit">
            {loading ? 'Проверяем подключение…' : 'Подключиться'}
            {!loading && <ArrowRight size={18} aria-hidden="true" />}
          </button>
          {loading && (
            <button className="text-button full-width" type="button" onClick={onCancel}>
              Отменить подключение
            </button>
          )}
        </form>
        <div className="privacy-note">
          <ShieldCheck size={18} aria-hidden="true" />
          <span>
            Данные доступа остаются в памяти этой вкладки и отправляются только в GREEN-API
          </span>
        </div>
        <div className="connect-divider" />
        <button className="secondary full-width" onClick={onDemo} disabled={loading}>
          Открыть демо
        </button>
        <p className="demo-description">Без учётных данных и отправки в Telegram</p>
      </section>
      <a
        className="setup-link"
        href="https://green-api.com/telegram/docs/before-start/"
        target="_blank"
        rel="noreferrer"
      >
        Как подготовить инстанс
        <ExternalLink size={14} aria-hidden="true" />
      </a>
    </main>
  )
}
