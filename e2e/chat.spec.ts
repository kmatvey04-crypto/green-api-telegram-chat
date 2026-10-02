import { test, expect, type Page } from '@playwright/test'
const host = 'https://7105.api.green-api.com'
async function connect(page: Page) {
  await page.getByLabel('apiUrl', { exact: true }).fill(host)
  await page.getByLabel('idInstance', { exact: true }).fill('7105000000')
  await page.getByLabel('apiTokenInstance', { exact: true }).fill('FakeTestTokenNotACredential')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Чаты', exact: true })).toBeVisible()
}
async function newChat(page: Page) {
  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click()
  await page.getByLabel('Номер телефона').fill('+7 (999) 000-00-00')
  await page.getByRole('button', { name: 'Создать чат', exact: true }).click()
  await expect(page.getByRole('heading', { name: '+79990000000', exact: true })).toBeVisible()
}
test('desktop demo is explicit, sends locally, and disconnect clears state', async ({ page }) => {
  const outbound: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:5173')) outbound.push(request.url())
  })
  await page.goto('/')
  await page.screenshot({ path: 'docs/screenshots/connect-desktop.png', fullPage: true })
  await page.getByRole('button', { name: 'Открыть демо' }).click()
  await expect(page.getByText('Демонстрация: сообщения остаются в браузере')).toBeVisible()
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Отлично, всё работает.')
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).press('Enter')
  await expect(
    page.getByRole('log').getByText('Отлично, всё работает.', { exact: true }),
  ).toBeVisible()
  await page.screenshot({ path: 'docs/screenshots/demo-desktop.png', fullPage: true })
  await expect(page.getByRole('log').getByText('Локально')).toBeVisible()
  await page.getByRole('button', { name: 'Отключиться', exact: true }).click()
  await expect(page.getByLabel('apiTokenInstance')).toHaveValue('')
  await page.getByRole('button', { name: 'Открыть демо' }).click()
  await expect(
    page.getByRole('log').getByText('Отлично, всё работает.', { exact: true }),
  ).toHaveCount(0)
  expect(outbound).toEqual([])
})
test('mobile layout, accessible dialog cancellation and chat switching', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.screenshot({ path: 'docs/screenshots/connect-mobile.png', fullPage: true })
  await page.getByRole('button', { name: 'Открыть демо' }).click()
  await page
    .getByRole('textbox', { name: 'Сообщение', exact: true })
    .fill('Мобильная версия тоже работает 👍')
  await page.getByRole('button', { name: 'Отправить сообщение' }).click()
  await expect(
    page.getByRole('log').getByText('Мобильная версия тоже работает 👍', { exact: true }),
  ).toBeVisible()
  await page.screenshot({ path: 'docs/screenshots/demo-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.getByRole('button', { name: 'Назад к чатам' }).click()
  await page.getByRole('button', { name: 'Новый чат', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByLabel('Номер телефона').press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Новый чат', exact: true })).toBeFocused()
  await newChat(page)
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Черновик')
  await page.getByRole('button', { name: 'Назад к чатам' }).click()
  await page.getByRole('button', { name: /Демо-чат/ }).click()
  await expect(
    page.getByRole('log').getByText('Мобильная версия тоже работает 👍', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue('')
})
test('mock HTTP roundtrip resolves phone, sends, renders text, ACKs and deduplicates', async ({
  page,
}) => {
  const queue: unknown[] = []
  const acknowledgements: string[] = []
  const sent: unknown[] = []
  let phoneBody: unknown
  await page.route(`${host}/**`, async (route) => {
    const url = route.request().url()
    let body: unknown = {}
    if (url.includes('/getStateInstance/')) body = { stateInstance: 'authorized' }
    else if (url.includes('/getSettings/')) body = { incomingWebhook: 'yes', webhookUrl: '' }
    else if (url.includes('/checkAccount/')) {
      phoneBody = route.request().postDataJSON()
      body = { exist: true, chatId: '42' }
    } else if (url.includes('/sendMessage/')) {
      sent.push(route.request().postDataJSON())
      body = { idMessage: 'sent-1' }
    } else if (url.includes('/receiveNotification/')) body = queue.shift() ?? null
    else if (url.includes('/deleteNotification/')) {
      acknowledgements.push(url.split('/').at(-1)!)
      body = { result: true }
    }
    await route.fulfill({ json: body })
  })
  await page.goto('/')
  await connect(page)
  await newChat(page)
  expect(phoneBody).toEqual({ phoneNumber: 79990000000 })
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Привет из теста')
  await page.getByRole('button', { name: 'Отправить сообщение' }).click()
  await expect(page.getByRole('log').getByText('Принято API')).toBeVisible()
  expect(sent).toEqual([{ chatId: '42', message: 'Привет из теста' }])
  const event = {
    receiptId: 10,
    body: {
      typeWebhook: 'incomingMessageReceived',
      idMessage: 'in-1',
      timestamp: Math.floor(Date.now() / 1000),
      senderData: { chatId: '42' },
      messageData: {
        typeMessage: 'textMessage',
        textMessageData: { textMessage: 'Ответ <script>не код</script>' },
      },
    },
  }
  queue.push(
    event,
    { ...event, receiptId: 11 },
    { receiptId: 12, body: { typeWebhook: 'stateInstanceChanged' } },
  )
  await expect(
    page.getByRole('log').getByText('Ответ <script>не код</script>', { exact: true }),
  ).toHaveCount(1)
  await expect.poll(() => acknowledgements).toEqual(['10', '11', '12'])
  await expect(
    page.getByRole('log').getByText('Ответ <script>не код</script>', { exact: true }),
  ).toHaveCount(1)
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 })
  await page.getByRole('button', { name: 'Отключиться', exact: true }).click()
  await expect(page.getByLabel('apiTokenInstance')).toHaveValue('')
  await expect(page.getByRole('log')).toHaveCount(0)
})
test('uncertain send stays visible and is never automatically repeated', async ({ page }) => {
  let sends = 0
  await page.route(`${host}/**`, async (route) => {
    const url = route.request().url()
    if (url.includes('/sendMessage/')) {
      sends++
      await route.fulfill({ status: 500, json: { error: 'failure' } })
      return
    }
    await route.fulfill({
      json: url.includes('/getStateInstance/')
        ? { stateInstance: 'authorized' }
        : url.includes('/getSettings/')
          ? { incomingWebhook: 'yes', webhookUrl: '' }
          : url.includes('/checkAccount/')
            ? { exist: true, chatId: '42' }
            : null,
    })
  })
  await page.goto('/')
  await connect(page)
  await newChat(page)
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Возможно отправлено')
  await page.getByRole('button', { name: 'Отправить сообщение' }).click()
  await expect(page.getByRole('log').getByText('Не подтверждено')).toBeVisible()
  await expect(
    page.getByRole('status').filter({ hasText: 'Отправка не подтверждена' }),
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue(
    'Возможно отправлено',
  )
  expect(sends).toBe(1)
})
test('connection cancellation ignores a late response and keeps the login view', async ({
  page,
}) => {
  let release: () => void = () => {}
  let requested = false
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`${host}/**`, async (route) => {
    requested = true
    await hold
    await route.fulfill({ json: { stateInstance: 'authorized' } }).catch(() => {})
  })
  await page.goto('/')
  await page.getByLabel('apiUrl', { exact: true }).fill(host)
  await page.getByLabel('idInstance', { exact: true }).fill('7105000000')
  await page.getByLabel('apiTokenInstance', { exact: true }).fill('FakeTestTokenNotACredential')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click()
  await expect.poll(() => requested).toBe(true)
  await page.getByRole('button', { name: 'Отменить подключение' }).click()
  release()
  await expect(page.getByRole('heading', { name: 'Подключить Telegram' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Подключиться', exact: true })).toBeEnabled()
})
test('queue settings are checked without changing an existing integration', async ({ page }) => {
  const methods: string[] = []
  await page.route(`${host}/**`, async (route) => {
    methods.push(route.request().method())
    await route.fulfill({
      json: route.request().url().includes('/getStateInstance/')
        ? { stateInstance: 'authorized' }
        : { incomingWebhook: 'yes', webhookUrl: 'https://existing.example/webhook' },
    })
  })
  await page.goto('/')
  await page.getByLabel('apiUrl', { exact: true }).fill(host)
  await page.getByLabel('idInstance', { exact: true }).fill('7105000000')
  await page.getByLabel('apiTokenInstance', { exact: true }).fill('FakeTestTokenNotACredential')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('webhookUrl пустым')
  expect(methods).toEqual(['GET', 'GET'])
})
