import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import App from './App'
describe('connection screen', () => {
  it('offers runtime credentials and a clearly separate demo', () => {
    render(<App />)
    expect(screen.getByLabelText('idInstance')).toBeVisible()
    expect(screen.getByLabelText('apiTokenInstance')).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Открыть демо' })).toBeVisible()
  })
})
