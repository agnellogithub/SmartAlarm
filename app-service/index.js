import * as sensor from '@zos/sensor'
import * as notification from '@zos/notification'
import * as router from '@zos/router'
import { storage, logEvent, trace } from '../utils/index'
import { ALARM_PAGE_URL } from '../utils/alarm'
import { runWakeCheck } from '../utils/wakecheck'

// Every wake alarm starts this service. It runs one wake check silently and, when it is time to wake,
// buzzes once, posts a notification and opens the ring screen (which keeps vibrating).
// Tested on device: the service is stopped as soon as onInit returns, so nothing here may use timers.

const localStorage = storage
const APP_ID = 1131497

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

// One strong buzz; the ring screen takes over with a repeating pattern once it opens
function buzz() {
  const vibrator = new sensor.Vibrator()
  const scene = sensor.VIBRATOR_SCENE_STRONG_REMINDER
  if (scene !== undefined && typeof vibrator.setMode === 'function') vibrator.setMode(scene)
  vibrator.start()
}

// Opens the page. Must be the last log write: the page logs as soon as it opens,
// and two processes writing the log at once can lose entries.
function openPage(params) {
  if (typeof router.launchApp !== 'function') {
    logEvent(localStorage, 'service launchApp: FAILED launchApp not available')
    return
  }
  logEvent(localStorage, `service launchApp: opening page (params="${params}")`)
  try {
    router.launchApp({ appId: APP_ID, url: ALARM_PAGE_URL, params })
  } catch (e) {
    // Console only, to keep clear of the page's log writes
    trace(`launchApp threw: ${errText(e)}`)
  }
}

function ring(reason) {
  attempt('buzz', buzz)
  attempt('notify', () => notification.notify({
    title: 'Smart Wake',
    content: `Time to wake up (${reason}). Tap Open to snooze or dismiss.`,
    actions: [{ text: 'Open', file: ALARM_PAGE_URL }]
  }))
  openPage('ring')
}

// Trial path kept for the edit screen's "Service test" buttons
function runServiceTest() {
  const dueMs = Number(localStorage.getItem('smart_wake_test_due_ms'))
  const lateSec = dueMs ? Math.round((Date.now() - dueMs) / 1000) : 'n/a'
  logEvent(localStorage, `service test started: ${lateSec}s late`)
  attempt('buzz', buzz)
  attempt('notify', () => notification.notify({
    title: 'Smart Wake test',
    content: 'Background service ran. Tap to open.',
    actions: [{ text: 'Open', file: ALARM_PAGE_URL }]
  }))
  openPage('from-service-test')
}

AppService({
  onInit(params) {
    trace(`ENTER: AppService.onInit() | params: ${JSON.stringify(params)}`)
    if (String(params) === 'service-test') {
      runServiceTest()
    } else {
      const result = runWakeCheck(localStorage)
      if (result.ring) ring(result.reason)
    }
    trace('EXIT: AppService.onInit()')
  },

  onDestroy() {
    trace('AppService.onDestroy()')
  }
})
