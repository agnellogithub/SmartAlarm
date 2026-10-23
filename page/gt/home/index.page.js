import { createWidget, widget, prop, align } from '@zos/ui'
import { cancel } from '@zos/alarm'
import { showToast } from '@zos/interaction'
import * as sensor from '@zos/sensor'
import * as display from '@zos/display'
import { getDeviceInfo } from '@zos/device'
import { getNextWakeWindow, readWindowMin, DEFAULT_WINDOW_MIN, MIN_WINDOW_MIN, MAX_WINDOW_MIN, readSnoozeMin, DEFAULT_SNOOZE_MIN, MIN_SNOOZE_MIN, MAX_SNOOZE_MIN, readCheckMin, DEFAULT_CHECK_MIN, MIN_CHECK_MIN, MAX_CHECK_MIN, storage, logEvent, formatDateTime, dumpEventLog } from '../../../utils/index'
import { scheduleNextDayAlarm, snoozeAlarm, isRingPending, placeAlarm, checkPendingAlarm, placeServiceTestAlarm, endBuzzChain, scheduleBuzzLink } from '../../../utils/alarm'

const localStorage = storage
const { width: DEVICE_WIDTH, height: DEVICE_HEIGHT } = getDeviceInfo()
const CX = Math.round(DEVICE_WIDTH / 2)
const CY = Math.round(DEVICE_HEIGHT / 2)

const COLOR_ACCENT = 0x6c5ce7
const COLOR_ACCENT_PRESS = 0xa29bfe
const COLOR_TIME = 0xffffff
const COLOR_TIME_OFF = 0x636e72
const COLOR_LABEL = 0xb2bec3
const COLOR_RED = 0xd63031
const COLOR_RED_PRESS = 0xff7675
const COLOR_GREEN = 0x00b894
const COLOR_GREEN_PRESS = 0x55efc4
const COLOR_GREY = 0x2d3436
const COLOR_GREY_PRESS = 0x636e72

function getLogTime() {
  const d = new Date()
  const h = d.getHours() < 10 ? `0${d.getHours()}` : d.getHours()
  const m = d.getMinutes() < 10 ? `0${d.getMinutes()}` : d.getMinutes()
  const s = d.getSeconds() < 10 ? `0${d.getSeconds()}` : d.getSeconds()
  const ms = d.getMilliseconds()
  return `${h}:${m}:${s}.${ms}`
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`
}

function formatClock(ms) {
  const d = new Date(Number(ms))
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// The ring screen owns the alarm vibration: the background service can only buzz once before it is stopped
const RING_PULSE_INTERVAL_MS = 3000
// Stop buzzing after this long even if nobody responds (the screen stays on the ring view)
const RING_VIBRATION_MAX_MS = 5 * 60 * 1000

function setGroupVisible(group, visible) {
  group.forEach(w => w.setProperty(prop.VISIBLE, visible))
}

Page({
  state: {
    hour: 7,
    minute: 0,
    enabled: false,
    screen: 'main',
    mainGroup: [],
    editGroup: [],
    ringGroup: [],
    nextTimeWidget: null,
    nextLabelWidget: null,
    mainToggleWidget: null,
    editHourWidget: null,
    editMinWidget: null,
    windowMin: DEFAULT_WINDOW_MIN,
    editWindowWidget: null,
    checkMin: DEFAULT_CHECK_MIN,
    editCheckWidget: null,
    snoozeMin: DEFAULT_SNOOZE_MIN,
    editSnoozeWidget: null,
    ringClockWidget: null,
    ringClockTimer: null,
    ringVibrator: null,
    ringVibrationTimer: null,
    ringPulses: 0,
    ringStartedMs: 0,
    stopLogDump: null
  },

  onInit(params) {
    // Records how the page was opened (e.g. 'from-service-test' when the service launched it)
    logEvent(localStorage, `page onInit params=${JSON.stringify(params)}`)
  },

  build() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.build() | Screen: ${DEVICE_WIDTH}x${DEVICE_HEIGHT}`)
    this.loadSavedConfig()

    this.buildMainScreen()
    this.buildEditScreen()
    this.buildRingScreen()

    const firstScreen = this.isRingActive() ? 'ring' : 'main'
    logEvent(localStorage, `page opened on ${firstScreen} screen`)
    checkPendingAlarm(localStorage, 'page open')
    // Print the stored history (including this open's entries) for the phone's log viewer
    this.state.stopLogDump = dumpEventLog(localStorage)
    this.showScreen(firstScreen)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.build()`)
  },

  onDestroy() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.onDestroy()`)
    logEvent(localStorage, `page closed (was on ${this.state.screen} screen)`)
    // Chain alarms due while the page is open don't fire and stay stuck (10-23 13:00), so if the ring is
    // still unanswered, clear them and restart the chain as the page goes away
    if (isRingPending(localStorage)) {
      try {
        endBuzzChain(localStorage, 'page closed, restarting')
        const alarmId = scheduleBuzzLink('ring', 2)
        logEvent(localStorage, `ring still pending: buzz chain restarted (alarm ${alarmId})`)
      } catch (e) {
        logEvent(localStorage, `buzz chain restart failed: ${e && e.message ? e.message : e}`)
      }
    }
    this.stopRingClock()
    this.stopRingVibration('page closed')
    if (this.state.stopLogDump) this.state.stopLogDump()
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.onDestroy()`)
  },

  // --- MAIN SCREEN: edit arrow + next alarm time ---
  buildMainScreen() {
    const arrowSize = 64
    const timeW = 210
    const left = CX - Math.round((arrowSize + 12 + timeW) / 2)

    const arrowBtn = createWidget(widget.BUTTON, {
      x: left, y: CY - 52, w: arrowSize, h: arrowSize,
      normal_src: 'image/edit_arrow.png',
      press_src: 'image/edit_arrow_press.png',
      click_func: () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: Edit arrow clicked.`)
        this.showScreen('edit')
      }
    })

    this.state.nextTimeWidget = createWidget(widget.TEXT, {
      x: left + arrowSize + 12, y: CY - 64, w: timeW, h: 88,
      color: COLOR_TIME, text_size: 68,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text: this.getFormattedTime()
    })

    this.state.nextLabelWidget = createWidget(widget.TEXT, {
      x: 0, y: CY + 32, w: DEVICE_WIDTH, h: 36,
      color: COLOR_LABEL, text_size: 22,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text: ''
    })

    this.state.mainToggleWidget = createWidget(widget.BUTTON, {
      x: CX - 80, y: CY + 84, w: 160, h: 52, radius: 26,
      normal_color: COLOR_GREY, press_color: COLOR_GREY_PRESS,
      text: '', text_size: 22,
      click_func: () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: Main screen On/Off toggle clicked.`)
        this.toggleAlarm()
      }
    })

    this.state.mainGroup = [arrowBtn, this.state.nextTimeWidget, this.state.nextLabelWidget, this.state.mainToggleWidget]
  },

  // --- EDIT SCREEN: scrollable; hour/minute/window/check/snooze steppers, done ---
  buildEditScreen() {
    // Scrollable container so all settings fit at full size; children use container-relative coordinates
    const container = createWidget(widget.VIEW_CONTAINER, {
      x: 0, y: 0, w: DEVICE_WIDTH, h: DEVICE_HEIGHT,
      scroll_enable: true
    })

    const label = (y, text, size = 18) => container.createWidget(widget.TEXT, {
      x: 0, y, w: DEVICE_WIDTH, h: 30,
      color: COLOR_LABEL, text_size: size, align_h: align.CENTER_H, align_v: align.CENTER_V,
      text
    })

    const stepper = (y, onMinus, onPlus, minusText, plusText) => {
      container.createWidget(widget.BUTTON, {
        x: CX - 145, y, w: 72, h: 56, radius: 28,
        normal_color: COLOR_ACCENT, press_color: COLOR_ACCENT_PRESS,
        text: minusText, text_size: 20, click_func: onMinus
      })
      const value = container.createWidget(widget.TEXT, {
        x: CX - 70, y, w: 140, h: 56,
        color: COLOR_TIME, text_size: 40, align_h: align.CENTER_H, align_v: align.CENTER_V,
        text: ''
      })
      container.createWidget(widget.BUTTON, {
        x: CX + 73, y, w: 72, h: 56, radius: 28,
        normal_color: COLOR_ACCENT, press_color: COLOR_ACCENT_PRESS,
        text: plusText, text_size: 20, click_func: onPlus
      })
      return value
    }

    // Top padding keeps the first row clear of a round screen's edge
    let y = 50
    label(y, 'Wake time', 22)
    y += 40
    this.state.editHourWidget = stepper(y,
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: -1h button clicked.`)
        this.state.hour = (this.state.hour + 23) % 24
        this.updateEditDisplay()
      },
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: +1h button clicked.`)
        this.state.hour = (this.state.hour + 1) % 24
        this.updateEditDisplay()
      },
      '-1h', '+1h')
    y += 66
    this.state.editMinWidget = stepper(y,
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: -1m button clicked.`)
        this.state.minute = (this.state.minute + 59) % 60
        this.updateEditDisplay()
      },
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: +1m button clicked.`)
        this.state.minute = (this.state.minute + 1) % 60
        this.updateEditDisplay()
      },
      '-1m', '+1m')

    y += 80
    label(y, 'Smart window (checks before)')
    y += 34
    this.state.editWindowWidget = stepper(y,
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: Window -5m button clicked.`)
        this.state.windowMin = Math.max(MIN_WINDOW_MIN, this.state.windowMin - 5)
        this.updateEditDisplay()
      },
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: Window +5m button clicked.`)
        this.state.windowMin = Math.min(MAX_WINDOW_MIN, this.state.windowMin + 5)
        this.updateEditDisplay()
      },
      '-5', '+5')

    y += 80
    label(y, 'Check every')
    y += 34
    this.state.editCheckWidget = stepper(y,
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: Check interval -1m button clicked.`)
        this.state.checkMin = Math.max(MIN_CHECK_MIN, this.state.checkMin - 1)
        this.updateEditDisplay()
      },
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: Check interval +1m button clicked.`)
        this.state.checkMin = Math.min(MAX_CHECK_MIN, this.state.checkMin + 1)
        this.updateEditDisplay()
      },
      '-1', '+1')

    y += 80
    label(y, 'Snooze length')
    y += 34
    this.state.editSnoozeWidget = stepper(y,
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: Snooze -1m button clicked.`)
        this.state.snoozeMin = Math.max(MIN_SNOOZE_MIN, this.state.snoozeMin - 1)
        this.updateEditDisplay()
      },
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: Snooze +1m button clicked.`)
        this.state.snoozeMin = Math.min(MAX_SNOOZE_MIN, this.state.snoozeMin + 1)
        this.updateEditDisplay()
      },
      '-1', '+1')

    y += 84
    container.createWidget(widget.BUTTON, {
      x: CX - 85, y, w: 170, h: 56, radius: 28,
      normal_color: COLOR_ACCENT, press_color: COLOR_ACCENT_PRESS,
      text: 'Done', text_size: 24,
      click_func: () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: "Done" button clicked on edit screen.`)
        this.saveTimeAndReturn()
      }
    })
    // Trial: background-service test alarms
    y += 84
    label(y, 'Service test')
    y += 34
    const testButton = (x, minutes) => container.createWidget(widget.BUTTON, {
      x, y, w: 130, h: 52, radius: 26,
      normal_color: COLOR_GREY, press_color: COLOR_GREY_PRESS,
      text: `+${minutes} min`, text_size: 22,
      click_func: () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: Service test +${minutes} min clicked.`)
        const dueMs = placeServiceTestAlarm(localStorage, minutes)
        showToast({ text: `Service test at ${formatClock(dueMs)}` })
      }
    })
    testButton(CX - 140, 2)
    testButton(CX + 10, 60)

    // Bottom spacer so the last row can scroll clear of a round screen's edge
    container.createWidget(widget.FILL_RECT, { x: 0, y: y + 52, w: DEVICE_WIDTH, h: 70, color: 0x000000 })

    this.state.editGroup = [container]
  },

  // --- RING SCREEN: current time, snooze (red), dismiss (green) ---
  buildRingScreen() {
    this.state.ringClockWidget = createWidget(widget.TEXT, {
      x: 0, y: CY - 130, w: DEVICE_WIDTH, h: 110,
      color: COLOR_TIME, text_size: 92, align_h: align.CENTER_H, align_v: align.CENTER_V,
      text: formatClock(Date.now())
    })

    const snoozeBtn = createWidget(widget.BUTTON, {
      x: CX - 150, y: CY + 20, w: 140, h: 84, radius: 42,
      normal_color: COLOR_RED, press_color: COLOR_RED_PRESS,
      text: 'Snooze', text_size: 26,
      click_func: () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: SNOOZE button clicked.`)
        this.snoozeAlarm()
      }
    })

    const dismissBtn = createWidget(widget.BUTTON, {
      x: CX + 10, y: CY + 20, w: 140, h: 84, radius: 42,
      normal_color: COLOR_GREEN, press_color: COLOR_GREEN_PRESS,
      text: 'Dismiss', text_size: 26,
      click_func: () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: DISMISS button clicked.`)
        this.dismissAlarm()
        this.showScreen('main')
      }
    })

    this.state.ringGroup = [this.state.ringClockWidget, snoozeBtn, dismissBtn]
  },

  showScreen(screen) {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.showScreen() | ${this.state.screen} -> ${screen}`)
    this.state.screen = screen

    setGroupVisible(this.state.mainGroup, screen === 'main')
    setGroupVisible(this.state.editGroup, screen === 'edit')
    setGroupVisible(this.state.ringGroup, screen === 'ring')

    if (screen === 'ring') {
      this.startRingClock()
      this.startRingVibration()
    } else {
      this.stopRingClock()
      this.stopRingVibration('left ring screen')
    }

    if (screen === 'edit') this.updateEditDisplay()
    this.updateStatusDisplay()
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.showScreen()`)
  },

  isRingActive() {
    const active = isRingPending(localStorage)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Ring Active Check -> Active: ${active}`)
    return active
  },

  startRingClock() {
    this.stopRingClock()
    this.state.ringClockWidget.setProperty(prop.TEXT, formatClock(Date.now()))
    this.state.ringClockTimer = setInterval(() => {
      this.state.ringClockWidget.setProperty(prop.TEXT, formatClock(Date.now()))
    }, 1000)
  },

  stopRingClock() {
    if (this.state.ringClockTimer) {
      clearInterval(this.state.ringClockTimer)
      this.state.ringClockTimer = null
    }
  },

  // Repeating strong pulses until Snooze/Dismiss, capped at RING_VIBRATION_MAX_MS
  startRingVibration() {
    if (this.state.ringVibrationTimer) return
    this.keepScreenOn()
    try {
      const vibrator = new sensor.Vibrator()
      const scene = sensor.VIBRATOR_SCENE_STRONG_REMINDER
      if (scene !== undefined && typeof vibrator.setMode === 'function') vibrator.setMode(scene)
      vibrator.start()
      this.state.ringVibrator = vibrator
      const startedMs = Date.now()
      this.state.ringPulses = 1
      this.state.ringStartedMs = startedMs
      logEvent(localStorage, `ring vibration started (scene=${scene !== undefined ? scene : 'default'})`)
      this.state.ringVibrationTimer = setInterval(() => {
        if (Date.now() - startedMs >= RING_VIBRATION_MAX_MS) {
          this.stopRingVibration(`${RING_VIBRATION_MAX_MS / 60000} min limit`)
          return
        }
        vibrator.start()
        this.state.ringPulses++
      }, RING_PULSE_INTERVAL_MS)
    } catch (e) {
      logEvent(localStorage, `ring vibration error: ${e && e.message ? e.message : e}`)
    }
  },

  stopRingVibration(reason) {
    if (!this.state.ringVibrationTimer && !this.state.ringVibrator) return
    if (this.state.ringVibrationTimer) {
      clearInterval(this.state.ringVibrationTimer)
      this.state.ringVibrationTimer = null
    }
    try {
      if (this.state.ringVibrator) this.state.ringVibrator.stop()
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] vibrator stop exception:`, e)
    }
    this.state.ringVibrator = null
    // Pulse count and duration show whether the timer kept running while the display was off
    const secs = this.state.ringStartedMs ? Math.round((Date.now() - this.state.ringStartedMs) / 1000) : 0
    logEvent(localStorage, `ring vibration stopped: ${reason} after ${this.state.ringPulses} pulses in ${secs}s (expected ~${Math.floor(secs * 1000 / RING_PULSE_INTERVAL_MS) + 1})`)
  },

  // Keeps the display awake while ringing, where the watch supports it
  keepScreenOn() {
    try {
      if (typeof display.setPageBrightTime === 'function') display.setPageBrightTime({ brightTime: RING_VIBRATION_MAX_MS })
      if (typeof display.pauseDropWristScreenOff === 'function') display.pauseDropWristScreenOff({ duration: RING_VIBRATION_MAX_MS })
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] keepScreenOn exception:`, e)
    }
  },

  loadSavedConfig() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.loadSavedConfig()`)
    try {
      const savedHour = localStorage.getItem('smart_wake_hour')
      const savedMin = localStorage.getItem('smart_wake_minute')
      const savedEnabled = localStorage.getItem('smart_wake_enabled')

      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Loaded Values -> Hour: ${savedHour}, Minute: ${savedMin}, Enabled: ${savedEnabled}`)

      if (savedHour !== undefined && savedHour !== null) this.state.hour = Number(savedHour)
      if (savedMin !== undefined && savedMin !== null) this.state.minute = Number(savedMin)
      if (savedEnabled !== undefined && savedEnabled !== null) {
        this.state.enabled = String(savedEnabled) === 'true'
      }
      this.state.windowMin = readWindowMin(localStorage)
      this.state.checkMin = readCheckMin(localStorage)
      this.state.snoozeMin = readSnoozeMin(localStorage)
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] loadSavedConfig exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.loadSavedConfig()`)
  },

  getFormattedTime() {
    return `${pad2(this.state.hour)}:${pad2(this.state.minute)}`
  },

  updateEditDisplay() {
    if (this.state.editHourWidget && this.state.editMinWidget) {
      this.state.editHourWidget.setProperty(prop.TEXT, `${pad2(this.state.hour)}h`)
      this.state.editMinWidget.setProperty(prop.TEXT, `${pad2(this.state.minute)}m`)
      if (this.state.editWindowWidget) {
        this.state.editWindowWidget.setProperty(prop.TEXT, `${this.state.windowMin} min`)
      }
      if (this.state.editCheckWidget) {
        this.state.editCheckWidget.setProperty(prop.TEXT, `${this.state.checkMin} min`)
      }
      if (this.state.editSnoozeWidget) {
        this.state.editSnoozeWidget.setProperty(prop.TEXT, `${this.state.snoozeMin} min`)
      }
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Edit Display Updated -> ${pad2(this.state.hour)}h ${pad2(this.state.minute)}m, Window: ${this.state.windowMin} min`)
    }
  },

  saveTimeAndReturn() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.saveTimeAndReturn()`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Persisting target time -> Hour: ${this.state.hour}, Minute: ${this.state.minute}`)
    logEvent(localStorage, `settings saved: wake ${this.getFormattedTime()}, window ${this.state.windowMin} min, check every ${this.state.checkMin} min, snooze ${this.state.snoozeMin} min`)
    localStorage.setItem('smart_wake_hour', String(this.state.hour))
    localStorage.setItem('smart_wake_minute', String(this.state.minute))
    localStorage.setItem('smart_wake_window_min', String(this.state.windowMin))
    localStorage.setItem('smart_wake_check_min', String(this.state.checkMin))
    localStorage.setItem('smart_wake_snooze_min', String(this.state.snoozeMin))

    if (this.state.enabled) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm is enabled. Re-scheduling service for new time...`)
      this.scheduleAlarmService()
    }

    this.showScreen('main')
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.saveTimeAndReturn()`)
  },

  dismissAlarm() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.dismissAlarm()`)
    logEvent(localStorage, 'dismiss pressed')
    try {
      this.stopRingVibration('dismiss')
      // A dismissed ring can no longer be snoozed
      localStorage.removeItem('smart_wake_rang_at_ms')
      endBuzzChain(localStorage, 'dismiss')

      // EXPLICIT CHECK: If alarm is actively enabled, ensure tomorrow's alarm is locked in
      if (this.state.enabled) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm is active -> scheduling next day's alarm from dismiss action...`)
        scheduleNextDayAlarm(localStorage)
      }
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] dismissAlarm exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.dismissAlarm()`)
  },

  snoozeAlarm() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.snoozeAlarm()`)
    logEvent(localStorage, 'snooze pressed')
    this.stopRingVibration('snooze')
    if (!this.state.enabled) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm disabled. Nothing to snooze.`)
      showToast({ text: 'Alarm is off' })
    } else {
      const snoozeUntilMs = snoozeAlarm(localStorage)
      if (snoozeUntilMs) {
        showToast({ text: `Snoozed until ${formatClock(snoozeUntilMs)}` })
      } else {
        showToast({ text: 'Nothing to snooze' })
      }
    }
    this.showScreen('main')
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.snoozeAlarm()`)
  },

  toggleAlarm() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.toggleAlarm()`)
    this.stopRingVibration('alarm toggled')

    this.state.enabled = !this.state.enabled
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] New Alarm State: ${this.state.enabled}`)
    logEvent(localStorage, `alarm turned ${this.state.enabled ? 'ON' : 'OFF'}`)
    localStorage.setItem('smart_wake_enabled', this.state.enabled ? 'true' : 'false')

    if (this.state.enabled) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Enabling alarm service...`)
      this.scheduleAlarmService()
    } else {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Disabling alarm service...`)
      this.cancelAlarmService()
      localStorage.removeItem('smart_wake_target_ms')
      localStorage.removeItem('smart_wake_start_ms')
      localStorage.removeItem('smart_wake_hard_limit_ms')
      localStorage.removeItem('smart_wake_snooze_until_ms')
      localStorage.removeItem('smart_wake_rang_at_ms')
      localStorage.removeItem('smart_wake_rang_hard_limit_ms')
      endBuzzChain(localStorage, 'alarm turned off')
    }

    this.updateStatusDisplay()
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.toggleAlarm()`)
  },

  scheduleAlarmService() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.scheduleAlarmService()`)
    this.cancelAlarmService()

    const hour = Number(this.state.hour)
    const min = Number(this.state.minute)

    // Next target whose -25m window is still in the future (handles windows that cross midnight)
    const now = new Date()
    const { target: targetTime, windowStart, hardLimit } = getNextWakeWindow(hour, min, now, readWindowMin(localStorage))

    localStorage.setItem('smart_wake_target_ms', String(targetTime.getTime()))
    localStorage.setItem('smart_wake_start_ms', String(windowStart.getTime()))
    localStorage.setItem('smart_wake_hard_limit_ms', String(hardLimit.getTime()))
    localStorage.removeItem('smart_wake_snooze_until_ms')

    const alarmId = placeAlarm(localStorage, windowStart.getTime(), 'window start')

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] === MANUAL SCHEDULE VERIFICATION ===`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Current Date/Time  : ${formatDateTime(now)}`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Checks Start Time : ${formatDateTime(windowStart)} (Alarm ID: ${alarmId})`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Target Hard Limit : ${formatDateTime(hardLimit)}`)
    logEvent(localStorage, `scheduled: checks ${formatDateTime(windowStart)}, target ${formatClock(hardLimit.getTime())} (alarm id ${alarmId})`)

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.scheduleAlarmService()`)
  },

  cancelAlarmService() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.cancelAlarmService()`)
    try {
      // Only stop the motor here; dismissAlarm() would schedule a new alarm while we cancel
      this.stopRingVibration('alarm cancelled')

      const activeAlarmId = localStorage.getItem('smart_wake_alarm_id')
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Active Alarm ID read from storage: ${activeAlarmId}`)
      if (activeAlarmId) {
        cancel(Number(activeAlarmId))
        localStorage.removeItem('smart_wake_alarm_id')
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm ID ${activeAlarmId} successfully cancelled.`)
      } else {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] No active alarm ID found to cancel.`)
      }
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] cancelAlarmService exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.cancelAlarmService()`)
  },

  // Refreshes the main screen's time/label and the edit screen's on/off button
  updateStatusDisplay() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.updateStatusDisplay()`)
    const { nextTimeWidget, nextLabelWidget, mainToggleWidget } = this.state
    if (!nextTimeWidget || !nextLabelWidget || !mainToggleWidget) return

    let timeText = this.getFormattedTime()
    let label = 'Alarm off'

    if (this.state.enabled) {
      const snoozeUntilMs = Number(localStorage.getItem('smart_wake_snooze_until_ms'))
      const targetMs = Number(localStorage.getItem('smart_wake_target_ms'))

      if (snoozeUntilMs && snoozeUntilMs > Date.now()) {
        timeText = formatClock(snoozeUntilMs)
        label = 'Snoozed'
      } else if (targetMs) {
        const today = new Date()
        const day = new Date(targetMs).toDateString() === today.toDateString() ? 'Today' : 'Tomorrow'
        const startMs = Number(localStorage.getItem('smart_wake_start_ms'))
        label = startMs ? `${day}, checks from ${formatClock(startMs)}` : day
      } else {
        label = 'Next alarm'
      }
    }

    nextTimeWidget.setProperty(prop.TEXT, timeText)
    nextTimeWidget.setProperty(prop.COLOR, this.state.enabled ? COLOR_TIME : COLOR_TIME_OFF)
    nextLabelWidget.setProperty(prop.TEXT, label)

    mainToggleWidget.setProperty(prop.TEXT, this.state.enabled ? 'On' : 'Off')
    mainToggleWidget.setProperty(prop.NORMAL_COLOR, this.state.enabled ? COLOR_GREEN : COLOR_GREY)
    mainToggleWidget.setProperty(prop.PRESS_COLOR, this.state.enabled ? COLOR_GREEN_PRESS : COLOR_GREY_PRESS)

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Status display refreshed. Active: ${this.state.enabled}, Shown: ${timeText} (${label})`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.updateStatusDisplay()`)
  }
})
