import type { ChatGateway } from './api'
import type { Chat } from './chat'
export function demoChats(): Chat[] {
  return [
    {
      id: 'demo',
      label: 'Демо-чат',
      messages: [
        {
          key: 'demo-intro',
          id: 'demo-intro',
          text: 'Привет! Здесь можно проверить интерфейс без подключения.',
          timestamp: Date.now(),
          direction: 'incoming',
          status: 'received',
        },
      ],
    },
  ]
}
// This local gateway deliberately never performs fetch or produces a fake incoming reply.
export function createDemoGateway(): ChatGateway {
  return {
    getState: async () => 'authorized',
    getSettings: async () => ({ incomingWebhook: 'yes', webhookUrl: '' }),
    resolvePhone: async (phone) => `demo-${phone.replace(/\D/g, '')}`,
    sendText: async () => crypto.randomUUID(),
    receive: (signal) =>
      new Promise((resolve) => {
        if (signal.aborted) resolve(null)
        else signal.addEventListener('abort', () => resolve(null), { once: true })
      }),
    acknowledge: async () => {},
  }
}
