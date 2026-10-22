import { Vibrator } from '@zos/sensor'
import * as notification from '@zos/notification'
import * as router from '@zos/router'
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

    // Everything runs synchronously: in the +2 min test nothing scheduled with setTimeout ever ran,
    // so the service appears to be stopped as soon as onInit returns.

    // 1. Vibrate (no stop: a timer to stop it would never fire)
    attempt('vibrate start', () => new Vibrator().start())

    // 2. Notification; tapping its "Open" action opened the page in the +2 min test
    attempt('notify', () => notification.notify({
      title: 'Smart Wake test',
      content: 'Background service ran. Tap to open.',
      actions: [{ text: 'Open', file: PAGE_URL }]
    }))

    // 3. Open the page directly. Last log write here: the page logs as soon as it opens,
    // and two processes writing the log at once can lose entries.
    if (typeof router.launchApp !== 'function') {
      logEvent(localStorage, 'service launchApp: FAILED launchApp not available')
    } else {
      logEvent(localStorage, 'service launchApp: calling now (page should log params="from-service-test")')
      try {
        router.launchApp({ appId: APP_ID, url: PAGE_URL, params: 'from-service-test' })
      } catch (e) {
        // Console only, to keep clear of the page's log writes
        trace(`launchApp threw: ${errText(e)}`)
      }
    }
    trace('EXIT: AppService.onInit()')
  },

  onDestroy() {
    trace('AppService.onDestroy()')
  }
})
