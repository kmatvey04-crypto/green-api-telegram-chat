import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { NewChatDialog } from './NewChatDialog'

describe('native dialog dismissal lifecycle', () => {
  it.each(['Закрыть', 'Отмена'])(
    'closes the native dialog before unmount callback via %s',
    async (name) => {
      let wasOpen: boolean | undefined
      const onClose = vi.fn(() => {
        wasOpen = screen.getByRole('dialog', { hidden: true }).hasAttribute('open')
      })
      render(
        <NewChatDialog demo openChat={async () => '42'} onCreated={() => {}} onClose={onClose} />,
      )
      await userEvent.click(screen.getByRole('button', { name }))
      expect(onClose).toHaveBeenCalledOnce()
      expect(wasOpen).toBe(false)
    },
  )
  it('closes the native dialog when Escape triggers its cancel event', () => {
    let wasOpen: boolean | undefined
    const onClose = () => {
      wasOpen = screen.getByRole('dialog', { hidden: true }).hasAttribute('open')
    }
    render(
      <NewChatDialog demo openChat={async () => '42'} onCreated={() => {}} onClose={onClose} />,
    )
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(wasOpen).toBe(false)
  })
  it('closes before callbacks when a chat is successfully created', async () => {
    const user = userEvent.setup()
    const events: string[] = []
    const nativeIsOpen = () => screen.getByRole('dialog', { hidden: true }).hasAttribute('open')
    render(
      <NewChatDialog
        demo
        openChat={async () => '42'}
        onCreated={() => events.push(`created:${nativeIsOpen()}`)}
        onClose={() => events.push(`closed:${nativeIsOpen()}`)}
      />,
    )
    await user.type(screen.getByLabelText('Номер телефона'), '+79990000000')
    await user.click(screen.getByRole('button', { name: 'Создать чат' }))
    await waitFor(() => expect(events).toEqual(['created:false', 'closed:false']))
  })
})
