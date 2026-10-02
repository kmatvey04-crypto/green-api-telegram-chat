import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Info,
  LogOut,
  MessageCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import type { ChatGateway } from '../api'
import type { Chat, Message } from '../chat'
import { useChat } from '../hooks/useChat'
import { NewChatDialog } from './NewChatDialog'
const timeFormat = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' })
function initials(label: string) {
  return label === 'Демо-чат' ? 'ДЧ' : label.slice(-2)
}
function MessageBubble({ message, demo }: { message: Message; demo: boolean }) {
  const status =
    message.status === 'sending'
      ? 'Отправляется…'
      : message.status === 'uncertain'
        ? 'Не подтверждено'
        : message.status === 'failed'
          ? 'Не отправлено'
          : message.direction === 'outgoing'
            ? demo
              ? 'Локально'
              : 'Принято API'
            : ''
  return (
    <div
      className={`message ${message.direction} ${message.status === 'uncertain' || message.status === 'failed' ? 'uncertain' : ''}`}
    >
      <p>{message.text}</p>
      <span className="message-meta">
        <time dateTime={new Date(message.timestamp).toISOString()}>
          {timeFormat.format(message.timestamp)}
        </time>
        {status && (
          <span
            className="message-status"
            title={
              message.status === 'queued'
                ? 'Принято API в очередь; это не подтверждение доставки'
                : undefined
            }
          >
            {status}
            {message.status === 'queued' && <Check size={13} aria-hidden="true" />}
          </span>
        )}
      </span>
    </div>
  )
}
function Conversation({
  chat,
  demo,
  draft,
  onDraft,
  onSend,
  onBack,
}: {
  chat: Chat
  demo: boolean
  draft: string
  onDraft: (text: string) => void
  onSend: () => void
  onBack: () => void
}) {
  const end = useRef<HTMLDivElement>(null)
  const sending = chat.messages.some((m) => m.status === 'sending')
  const uncertain = chat.messages.some((m) => m.status === 'uncertain')
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end', behavior: 'instant' })
  }, [chat.messages])
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!sending && draft.trim() && draft.length <= 4096) onSend()
  }
  return (
    <>
      <header className="chat-header">
        <button className="icon-button back-button" onClick={onBack} aria-label="Назад к чатам">
          <ArrowLeft />
        </button>
        <div className="avatar small">{initials(chat.label)}</div>
        <div>
          <h2>{chat.label}</h2>
          <p>{demo ? 'Демо · без отправки в Telegram' : 'Telegram · текстовые сообщения'}</p>
        </div>
      </header>
      <div
        className="messages"
        role="log"
        aria-label="Переписка"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {chat.messages.length === 0 ? (
          <div className="conversation-empty">
            <MessageCircle size={32} aria-hidden="true" />
            <h3>Начните разговор</h3>
            <p>Напишите первое сообщение получателю</p>
          </div>
        ) : (
          chat.messages.map((message, index) => {
            const previous = chat.messages[index - 1]
            const day = new Date(message.timestamp).toDateString()
            const today = day === new Date().toDateString()
            return (
              <div className="message-group" key={message.key}>
                {(!previous || new Date(previous.timestamp).toDateString() !== day) && (
                  <div className="date-divider">
                    <span>{today ? 'Сегодня' : dayFormat.format(message.timestamp)}</span>
                  </div>
                )}
                <MessageBubble message={message} demo={demo} />
              </div>
            )
          })
        )}
        <div ref={end} />
      </div>
      <div className="composer-area">
        {chat.deliveryError && (
          <p className="send-warning" role="alert">
            {chat.deliveryError}
          </p>
        )}
        {uncertain && (
          <p className="send-warning" role="status">
            Отправка не подтверждена. Проверьте Telegram перед повтором: сообщение могло быть
            отправлено.
          </p>
        )}
        <form className="composer" onSubmit={submit}>
          <textarea
            aria-label="Сообщение"
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            placeholder="Написать сообщение…"
            rows={1}
            disabled={sending}
            maxLength={4096}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (!sending && draft.trim()) onSend()
              }
            }}
          />
          <button
            className="send-button"
            type="submit"
            disabled={sending || !draft.trim() || draft.length > 4096}
            aria-label={sending ? 'Отправляется' : 'Отправить сообщение'}
          >
            <ArrowUp size={22} />
          </button>
        </form>
        <div className="composer-hint">
          <span>Enter — отправить · Shift + Enter — новая строка</span>
          <span aria-label="Количество символов">{draft.length}/4096</span>
        </div>
      </div>
    </>
  )
}
export function ChatSession({
  gateway,
  demo,
  onDisconnect,
}: {
  gateway: ChatGateway
  demo: boolean
  onDisconnect: () => void
}) {
  const { chats, status, openChat, send, retry } = useChat(gateway, demo)
  const [selected, setSelected] = useState<string | null>(demo ? 'demo' : null)
  const [newChat, setNewChat] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const chat = chats.find((c) => c.id === selected)
  async function sendDraft() {
    if (!chat) return
    const id = chat.id
    const text = drafts[id] ?? ''
    if (await send(id, text)) setDrafts((d) => ({ ...d, [id]: d[id] === text ? '' : d[id] }))
  }
  return (
    <main className={`chat-app ${chat ? 'chat-open' : ''}`}>
      <aside className="sidebar" aria-label="Список чатов">
        <header className="sidebar-header">
          <h1>Чаты</h1>
          <button
            className="new-chat-button"
            onClick={() => setNewChat(true)}
            aria-label="Новый чат"
          >
            <Plus size={22} />
          </button>
        </header>
        <nav className="chat-list" aria-label="Чаты">
          {chats.length === 0 ? (
            <div className="list-empty">
              <p>Пока нет чатов</p>
              <span>Нажмите +, чтобы начать</span>
            </div>
          ) : (
            chats.map((c) => (
              <button
                key={c.id}
                className={`chat-row ${selected === c.id ? 'selected' : ''}`}
                onClick={() => setSelected(c.id)}
                aria-pressed={selected === c.id}
              >
                <span className="avatar">{initials(c.label)}</span>
                <span className="chat-row-content">
                  <strong>{c.label}</strong>
                  <span>{c.messages.at(-1)?.text ?? 'Новый разговор'}</span>
                </span>
              </button>
            ))
          )}
        </nav>
        <footer className="sidebar-footer">
          <div>
            <span className={`connection-dot ${demo ? 'demo' : status.state}`} aria-hidden="true" />
            <span>
              {demo
                ? 'Демо-режим'
                : status.state === 'connected'
                  ? 'Подключено'
                  : status.state === 'retrying'
                    ? 'Восстанавливаем связь'
                    : status.state === 'stopped'
                      ? 'Приём остановлен'
                      : 'Подключение…'}
            </span>
          </div>
          <div className="account-row">
            <span>Telegram · GREEN-API</span>
            <button
              className="icon-button"
              onClick={onDisconnect}
              title="Отключиться"
              aria-label="Отключиться"
            >
              <LogOut size={18} />
            </button>
          </div>
        </footer>
      </aside>
      <section className="chat-pane" aria-label="Чат">
        {demo && (
          <div className="demo-banner">
            <Info size={17} aria-hidden="true" />
            <span>Демонстрация: сообщения остаются в браузере</span>
          </div>
        )}
        {!demo && (status.state === 'retrying' || status.state === 'stopped') && (
          <div className="connection-banner" role="status">
            <Info size={18} aria-hidden="true" />
            <span>{status.message ?? 'Связь прервана. Повторяем подключение…'}</span>
            {status.state === 'stopped' && (
              <button onClick={retry}>
                <RefreshCw size={14} />
                Повторить
              </button>
            )}
          </div>
        )}
        {chat ? (
          <Conversation
            chat={chat}
            demo={demo}
            draft={drafts[chat.id] ?? ''}
            onDraft={(text) => setDrafts((d) => ({ ...d, [chat.id]: text }))}
            onSend={sendDraft}
            onBack={() => setSelected(null)}
          />
        ) : (
          <div className="no-chat">
            <span className="empty-icon">
              <MessageCircle size={38} strokeWidth={1.5} />
            </span>
            <h2>Ваши разговоры здесь</h2>
            <p>
              Создайте чат по номеру телефона
              <br />
              или выберите существующий слева
            </p>
            <button className="primary" onClick={() => setNewChat(true)}>
              <Plus size={18} />
              Новый чат
            </button>
            <span className="session-note">
              <ShieldCheck size={14} />
              История хранится только в этой вкладке
            </span>
          </div>
        )}
      </section>
      {newChat && (
        <NewChatDialog
          openChat={openChat}
          demo={demo}
          onCreated={setSelected}
          onClose={() => setNewChat(false)}
        />
      )}
    </main>
  )
}
