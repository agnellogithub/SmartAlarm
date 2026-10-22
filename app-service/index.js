import { Vibrator } from '@zos/sensor'
import * as notification from '@zos/notification'
import * as router from '@zos/router'
import * as appService from '@zos/app-service'
import { storage, logEvent, trace } from '../utils/index'

// Trial service: learns what a background service may do when an alarm starts it on an idle watch.
// Each attempt is written to the persistent event log, since nobody is watching the phone when it runs.

const localStorage = storage
const APP_ID = 1131497
const PAGE_URL = 'page/gt/home/index.page'

function errText(e) {
  return e && e.message ? e.message : String(e)
}

function attempt(label, fn) {
  try {
    const result = fn()
    logEvent(localStorage, `service ${label}: ok${result !== undefined ? ` (${JSON.stringify(result)})` : ''}`)
    return true
  } catch (e) {
    logEvent(localStorage, `service ${label}: FAILED ${errText(e)}`)
    return false
  }
}

AppService({
  onInit(params) {
    trace(`ENTER: AppService.onInit() | params: ${JSON.stringify(params)}`)
    const dueMs = Number(localStorage.getItem('smart_wake_test_due_ms'))
    const lateSec = dueMs ? Math.round((Date.now() - dueMs) / 1000) : 'n/a'
    logEvent(localStorage, `service started: params=${JSON.stringify(params)}, ${lateSec}s late`)

    // 1. Vibrate for 3 s
    let vibrator = null
    attempt('vibrate start', () => {
      vibrator = new Vibrator()
      vibrator.start()
    })

    // 2. Notification with an action that opens the app
    attempt('notify', () => notification.notify({
      title: 'Smart Wake test',
      content: 'Background service ran. Tap to open.',
      actions: [{ text: 'Open', file: PAGE_URL }]
    }))

    setTimeout(() => {
      attempt('vibrate stop', () => vibrator && vibrator.stop())

      // 3. Open the app's page. This is the service's last log write: the page logs as soon as it opens,
      // and two processes writing the log at once lost every earlier entry in the +2 min test.
      if (typeof router.launchApp !== 'function') {
        logEvent(localStorage, 'service launchApp: FAILED launchApp not available')
      } else {
        logEvent(localStorage, 'service launchApp: calling now (page should log params="from-service-test")')
        try {
          router.launchApp({ appId: APP_ID, url: PAGE_URL, params: 'from-service-test' })
        } catch (e) {
          // Logged to the console only, to keep clear of the page's log writes
          trace(`launchApp threw: ${errText(e)}`)
        }
      }

      // 4. End the service (console only, same reason)
      setTimeout(() => {
        try {
          if (typeof appService.exit === 'function') appService.exit()
          else trace('exit not available')
        } catch (e) {
          trace(`exit threw: ${errText(e)}`)
        }
      }, 3000)
    }, 3000)
  },

  onDestroy() {
    trace('AppService.onDestroy()')
  }
})
