import * as sensor from '@zos/sensor'
import * as notification from '@zos/notification'
import * as router from '@zos/router'
import { storage, logEvent, trace } from '../utils/index'
import {
  ALARM_PAGE_URL, isRingPending, parseChainParam, scheduleBuzzLink,
  RING_BUZZ_MAX, TEST_BUZZ_MAX, BUZZ_INTERVAL_SEC
} from '../utils/alarm'
import { runWakeCheck } from '../utils/wakecheck'

// Every wake alarm starts this service. It runs one wake check silently and, when it is time to wake,
// buzzes, posts a notification and starts a buzz chain (the notification opens the ring screen).
// On device the service is stopped as soon as onInit returns, even with the watch's background setting
// on (10-23 test: 1 of 10 timer pulses), and the ring screen's timers don't run with the display off.
// So each buzz is its own alarm-started run: see the buzz chain in utils/alarm.js.

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

// One strong buzz
function buzz() {
  const vibrator = new sensor.Vibrator()
  const scene = sensor.VIBRATOR_SCENE_STRONG_REMINDER
  if (scene !== undefined && typeof vibrator.setMode === 'function') vibrator.setMode(scene)
  vibrator.start()
}

// Opens the page. Must be the last event-log write: the page logs as soon as it opens,
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
  attempt('buzz chain start', () => scheduleBuzzLink('ring', 2))
  // No launchApp here: on 10-23 13:00 the opened ring screen kept the next link's alarm from ever firing
  // (still pending at 13:18). The notification's Open action brings up Snooze/Dismiss instead.
}

// A later link in the chain: buzz once more and set the next link.
// Writes nothing to storage (see the buzz chain notes in utils/alarm.js); console traces only.
function runChainLink({ kind, count }) {
  const max = kind === 'ring' ? RING_BUZZ_MAX : TEST_BUZZ_MAX
  if (kind === 'ring' && !isRingPending(localStorage)) {
    trace(`buzz chain (ring) link ${count}: ring cleared, stopping`)
    return
  }
  try {
    buzz()
  } catch (e) {
    trace(`chain buzz threw: ${errText(e)}`)
  }
  if (count >= max) {
    trace(`buzz chain (${kind}) link ${count}/${max}: last one`)
    return
  }
  try {
    const alarmId = scheduleBuzzLink(kind, count + 1)
    trace(`buzz chain (${kind}) link ${count}/${max}: next link alarm ${alarmId}`)
  } catch (e) {
    trace(`buzz chain (${kind}) link ${count}: scheduling next failed: ${errText(e)}`)
  }
}

// Trial path for the edit screen's "Service test" buttons: a short chain, no page launch
function runServiceTest() {
  const dueMs = Number(localStorage.getItem('smart_wake_test_due_ms'))
  const lateSec = dueMs ? Math.round((Date.now() - dueMs) / 1000) : 'n/a'
  logEvent(localStorage, `service test started: ${lateSec}s late`)
  attempt('buzz', buzz)
  attempt('notify', () => notification.notify({
    title: 'Smart Wake test',
    content: `Background service ran. Expect ${TEST_BUZZ_MAX} buzzes, ${BUZZ_INTERVAL_SEC} s apart.`,
    actions: [{ text: 'Open', file: ALARM_PAGE_URL }]
  }))
  attempt('buzz chain start', () => scheduleBuzzLink('test', 2))
}

AppService({
  onInit(params) {
    trace(`ENTER: AppService.onInit() | params: ${JSON.stringify(params)}`)
    const param = String(params)
    const chainLink = parseChainParam(param)
    if (chainLink) {
      runChainLink(chainLink)
    } else if (param === 'service-test') {
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
