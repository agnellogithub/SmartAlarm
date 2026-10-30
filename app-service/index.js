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
// posts a notification (wakes the display), starts a buzz chain, buzzes and opens the ring screen.
// On device the service is stopped as soon as onInit returns, even with the watch's background setting
// on (10-23 test: 1 of 10 timer pulses), and the ring screen's timers don't run with the display off.
// So each buzz is its own alarm-started run: see the buzz chain in utils/alarm.js.

const localStorage = storage
const APP_ID = 1131497

// Each start gives a burst instead of one pulse: the service is stopped once onInit returns, so a timer
// can't repeat the buzz, but holding onInit and re-triggering the motor can. Bursts grow along the chain
// (gentle first, stronger if unanswered); one pulse per link was reported too weak to wake from deep sleep.
// Untested: whether the watch stops a service held this long.
const BURST_FIRST_MS = 3000
const BURST_STEP_MS = 500
const BURST_MAX_MS = 7000
const BURST_RETRIGGER_MS = 1200

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

function strongVibrator() {
  const vibrator = new sensor.Vibrator()
  const scene = sensor.VIBRATOR_SCENE_STRONG_REMINDER
  if (scene !== undefined && typeof vibrator.setMode === 'function') vibrator.setMode(scene)
  return vibrator
}

function burstMsForLink(count) {
  return Math.min(BURST_MAX_MS, BURST_FIRST_MS + (count - 1) * BURST_STEP_MS)
}

// Buzzes for ms by holding onInit and re-triggering the motor; returns the number of motor starts
function burst(ms) {
  const vibrator = strongVibrator()
  const endMs = Date.now() + ms
  let nextMs = 0
  let starts = 0
  while (Date.now() < endMs) {
    if (Date.now() >= nextMs) {
      vibrator.start()
      starts++
      nextMs = Date.now() + BURST_RETRIGGER_MS
    }
  }
  return starts
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
  // The notification wakes the display (launchApp alone didn't); its Open action is the fallback
  attempt('notify', () => notification.notify({
    title: 'Smart Wake',
    content: `Time to wake up (${reason}). Tap Open to snooze or dismiss.`,
    actions: [{ text: 'Open', file: ALARM_PAGE_URL }]
  }))
  attempt('buzz chain start', () => scheduleBuzzLink('ring', 2))
  const startedMs = Date.now()
  attempt('burst', () => `${burst(burstMsForLink(1))} motor starts in ${Date.now() - startedMs} ms`)
  // Straight to Snooze/Dismiss. While the page is open the chain's alarm doesn't fire (10-23 13:00), so the
  // page vibrates itself while the display is on, and restarts the chain when it closes unanswered.
  openPage('ring')
}

// A later link in the chain: buzz once more and set the next link.
// Writes nothing to storage (see the buzz chain notes in utils/alarm.js); console traces only.
function runChainLink({ kind, count }) {
  const max = kind === 'ring' ? RING_BUZZ_MAX : TEST_BUZZ_MAX
  if (kind === 'ring' && !isRingPending(localStorage)) {
    trace(`buzz chain (ring) link ${count}: ring cleared, stopping`)
    return
  }
  // Next link first, so the burst doesn't delay it
  if (count < max) {
    try {
      const alarmId = scheduleBuzzLink(kind, count + 1)
      trace(`buzz chain (${kind}) link ${count}/${max}: next link alarm ${alarmId}`)
    } catch (e) {
      trace(`buzz chain (${kind}) link ${count}: scheduling next failed: ${errText(e)}`)
    }
  } else {
    trace(`buzz chain (${kind}) link ${count}/${max}: last one`)
  }
  try {
    const ms = burstMsForLink(count)
    trace(`buzz chain (${kind}) link ${count}: burst ${ms} ms, ${burst(ms)} motor starts`)
  } catch (e) {
    trace(`chain burst threw: ${errText(e)}`)
  }
}

// Trial path for the edit screen's "Service test" buttons: the same steps as a real ring
// (no ring is recorded, so the page shows its main screen and Snooze/Dismiss don't apply)
function runServiceTest() {
  const dueMs = Number(localStorage.getItem('smart_wake_test_due_ms'))
  const lateSec = dueMs ? Math.round((Date.now() - dueMs) / 1000) : 'n/a'
  logEvent(localStorage, `service test started: ${lateSec}s late`)
  attempt('notify', () => notification.notify({
    title: 'Smart Wake test',
    content: `Expect ${TEST_BUZZ_MAX} bursts, ${BUZZ_INTERVAL_SEC} s apart, getting longer.`,
    actions: [{ text: 'Open', file: ALARM_PAGE_URL }]
  }))
  attempt('buzz chain start', () => scheduleBuzzLink('test', 2))
  const startedMs = Date.now()
  attempt('burst', () => `${burst(burstMsForLink(1))} motor starts in ${Date.now() - startedMs} ms`)
  openPage('from-service-test')
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
