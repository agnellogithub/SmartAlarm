import * as sensor from '@zos/sensor'
import * as notification from '@zos/notification'
import * as router from '@zos/router'
import { storage, logEvent, trace } from '../utils/index'
import { ALARM_PAGE_URL, isRingPending } from '../utils/alarm'
import { runWakeCheck } from '../utils/wakecheck'

// Every wake alarm starts this service. It runs one wake check silently and, when it is time to wake,
// buzzes, posts a notification and opens the ring screen.
// On device (background setting Off) the service was stopped as soon as onInit returned and the ring
// screen's timer did not run with the display off (1 pulse in 15 s), so nobody felt the 10-23 ring.
// The service now also tries to keep buzzing with a timer; a pulse counter in its own storage key
// (not the event log, which the page writes too) shows whether it stayed alive.

const localStorage = storage
const APP_ID = 1131497
const PULSE_INTERVAL_MS = 3000
const PULSE_MAX = 100
const SERVICE_PULSES_KEY = 'smart_wake_service_pulses'

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

// Keeps buzzing every PULSE_INTERVAL_MS while keepGoing() holds, recording progress as "count@time"
function startPulses(keepGoing) {
  let count = 1
  localStorage.setItem(SERVICE_PULSES_KEY, `${count}@${Date.now()}`)
  const timer = setInterval(() => {
    if (count >= PULSE_MAX || !keepGoing()) {
      clearInterval(timer)
      localStorage.setItem(SERVICE_PULSES_KEY, `${count}@${Date.now()} stopped`)
      return
    }
    try {
      buzz()
    } catch (e) {
      trace(`pulse buzz threw: ${errText(e)}`)
    }
    count++
    localStorage.setItem(SERVICE_PULSES_KEY, `${count}@${Date.now()}`)
  }, PULSE_INTERVAL_MS)
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
  // Until Snooze/Dismiss clears the ring
  startPulses(() => isRingPending(localStorage))
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
  // No page launch here: the test only asks whether the service survives to keep buzzing (30 s)
  logEvent(localStorage, 'service test: buzzing every 3 s for 30 s')
  const endMs = Date.now() + 30 * 1000
  startPulses(() => Date.now() < endMs)
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
