export type Message = {
  key: string
  id?: string
  text: string
  timestamp: number
  direction: 'incoming' | 'outgoing'
  status: 'received' | 'sending' | 'queued' | 'uncertain' | 'failed'
}
export type Chat = {
  id: string
  label: string
  messages: Message[]
  deliveryError?: string
  failedIds?: string[]
}
export type Incoming = {
  id: string
  chatId: string
  text: string
  timestamp: number
  direction: 'incoming' | 'outgoing'
}
export type ChatAction =
  | { type: 'deliveryFailure'; chatId: string; id?: string; reason: 'failed' | 'noAccount' }
  | { type: 'open'; id: string; label: string }
  | { type: 'receive'; message: Incoming }
  | { type: 'send'; chatId: string; message: Message }
  | { type: 'sent'; chatId: string; key: string; id: string }
  | { type: 'uncertain'; chatId: string; key: string }
export function chatReducer(state: Chat[], action: ChatAction): Chat[] {
  if (action.type === 'open')
    return state.some((c) => c.id === action.id)
      ? state
      : [...state, { id: action.id, label: action.label, messages: [] }]
  const chatId = action.type === 'receive' ? action.message.chatId : action.chatId
  const chats = state.some((c) => c.id === chatId)
    ? state
    : [...state, { id: chatId, label: chatId, messages: [] }]
  return chats.map((chat) => {
    if (chat.id !== chatId) return chat
    let messages = chat.messages
    if (action.type === 'deliveryFailure')
      return {
        ...chat,
        deliveryError:
          action.reason === 'noAccount'
            ? 'Получатель не найден в Telegram. Проверьте номер и настройки приватности.'
            : 'GREEN-API сообщил об ошибке отправки. Проверьте чат в Telegram перед повтором.',
        failedIds: action.id
          ? [...new Set([...(chat.failedIds ?? []), action.id])]
          : chat.failedIds,
        messages: action.id
          ? messages.map((m) =>
              m.id === action.id && m.direction === 'outgoing' ? { ...m, status: 'failed' } : m,
            )
          : messages,
      }
    if (action.type === 'receive') {
      const m = action.message
      if (messages.some((x) => x.id === m.id && x.direction === m.direction)) return chat
      messages = [
        ...messages,
        {
          ...m,
          key: `${m.direction}-${m.id}`,
          status:
            m.direction === 'incoming'
              ? 'received'
              : chat.failedIds?.includes(m.id)
                ? 'failed'
                : 'queued',
        },
      ]
    } else if (action.type === 'send') messages = [...messages, action.message]
    else if (action.type === 'sent')
      messages = messages
        .filter((m) => m.key === action.key || m.direction !== 'outgoing' || m.id !== action.id)
        .map((m) =>
          m.key === action.key
            ? {
                ...m,
                id: action.id,
                status: chat.failedIds?.includes(action.id) ? 'failed' : 'queued',
              }
            : m,
        )
    else if (action.type === 'uncertain')
      messages = messages.map((m) => (m.key === action.key ? { ...m, status: 'uncertain' } : m))
    return { ...chat, messages }
  })
}
