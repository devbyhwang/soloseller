import { app, BrowserWindow, dialog } from 'electron'
import path from 'node:path'
import { startServer } from '../server.js'

app.setName('복숭아 주문대장')

let server

async function openWindow() {
  const databasePath = path.join(app.getPath('userData'), 'peach-orders.db')
  server = await startServer({ port: 0, databasePath })
  const address = server.address()
  const window = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 960,
    minHeight: 680,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await window.loadURL(`http://127.0.0.1:${address.port}`)
}

app.whenReady()
  .then(openWindow)
  .catch((error) => {
    dialog.showErrorBox('복숭아 주문대장을 열 수 없습니다', error.message)
    app.quit()
  })

app.on('before-quit', () => server?.close())
