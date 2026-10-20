import { createWidget, widget, prop, align } from '@zos/ui'
import { LocalStorage } from '@zos/storage'
import { set, cancel } from '@zos/alarm'
import { showToast } from '@zos/interaction'
import { getDeviceInfo } from '@zos/device'
import { getNextWakeWindow, readWindowMin, DEFAULT_WINDOW_MIN, MIN_WINDOW_MIN, MAX_WINDOW_MIN } from '../../../utils/index'

const localStorage = new LocalStorage()
const { width: DEVICE_WIDTH, height: DEVICE_HEIGHT } = getDeviceInfo()
const CX = Math.round(DEVICE_WIDTH / 2)
const CY = Math.round(DEVICE_HEIGHT / 2)

// Ring screen is shown for a ring this recent that hasn't been snoozed or dismissed (matches App's snooze window)
const RING_SCREEN_MAX_AGE_MS = 30 * 60 * 1000

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

// App methods may live on getApp() or getApp()._options depending on the runtime
function callApp(method) {
  try {
    const app = getApp()
    const target = app && typeof app[method] === 'function' ? app : app && app._options
    if (target && typeof target[method] === 'function') {
      return target[method]()
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] callApp: method "${method}" not found on app instance`)
  } catch (e) {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] callApp(${method}) exception:`, e)
  }
  return undefined
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`
}

function formatClock(ms) {
  const d = new Date(Number(ms))
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

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
    ringClockWidget: null,
    ringClockTimer: null
  },

  build() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.build() | Screen: ${DEVICE_WIDTH}x${DEVICE_HEIGHT}`)
    this.loadSavedConfig()

    // An alarm can reopen the page while the App is still running (App.onCreate not called), so check here too
    callApp('evaluateIfDue')

    this.buildMainScreen()
    this.buildEditScreen()
    this.buildRingScreen()

    this.showScreen(this.isRingActive() ? 'ring' : 'main')
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.build()`)
  },

  onDestroy() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.onDestroy()`)
    this.stopRingClock()
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

  // --- EDIT SCREEN: hour/minute/window steppers, done ---
  buildEditScreen() {
    const title = createWidget(widget.TEXT, {
      x: 0, y: CY - 172, w: DEVICE_WIDTH, h: 40,
      color: COLOR_LABEL, text_size: 22, align_h: align.CENTER_H, align_v: align.CENTER_V,
      text: 'Wake time'
    })

    const stepper = (y, onMinus, onPlus, minusText, plusText) => {
      const minus = createWidget(widget.BUTTON, {
        x: CX - 145, y, w: 72, h: 56, radius: 28,
        normal_color: COLOR_ACCENT, press_color: COLOR_ACCENT_PRESS,
        text: minusText, text_size: 20, click_func: onMinus
      })
      const value = createWidget(widget.TEXT, {
        x: CX - 70, y, w: 140, h: 56,
        color: COLOR_TIME, text_size: 40, align_h: align.CENTER_H, align_v: align.CENTER_V,
        text: ''
      })
      const plus = createWidget(widget.BUTTON, {
        x: CX + 73, y, w: 72, h: 56, radius: 28,
        normal_color: COLOR_ACCENT, press_color: COLOR_ACCENT_PRESS,
        text: plusText, text_size: 20, click_func: onPlus
      })
      return [minus, value, plus]
    }

    const hourRow = stepper(CY - 128,
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
    this.state.editHourWidget = hourRow[1]

    const minRow = stepper(CY - 62,
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: -5m button clicked.`)
        this.state.minute = (this.state.minute + 55) % 60
        this.updateEditDisplay()
      },
      () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: +5m button clicked.`)
        this.state.minute = (this.state.minute + 5) % 60
        this.updateEditDisplay()
      },
      '-5m', '+5m')
    this.state.editMinWidget = minRow[1]

    const windowLabel = createWidget(widget.TEXT, {
      x: 0, y: CY + 2, w: DEVICE_WIDTH, h: 26,
      color: COLOR_LABEL, text_size: 18, align_h: align.CENTER_H, align_v: align.CENTER_V,
      text: 'Smart window (checks before)'
    })

    const windowRow = stepper(CY + 30,
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
    this.state.editWindowWidget = windowRow[1]

    const doneBtn = createWidget(widget.BUTTON, {
      x: CX - 85, y: CY + 100, w: 170, h: 56, radius: 28,
      normal_color: COLOR_ACCENT, press_color: COLOR_ACCENT_PRESS,
      text: 'Done', text_size: 24,
      click_func: () => {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EVENT: "Done" button clicked on edit screen.`)
        this.saveTimeAndReturn()
      }
    })

    this.state.editGroup = [title, ...hourRow, ...minRow, windowLabel, ...windowRow, doneBtn]
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
    } else {
      this.stopRingClock()
    }

    if (screen === 'edit') this.updateEditDisplay()
    this.updateStatusDisplay()
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.showScreen()`)
  },

  isRingActive() {
    const rangAtMs = Number(localStorage.getItem('smart_wake_rang_at_ms'))
    const active = !!rangAtMs && Date.now() - rangAtMs <= RING_SCREEN_MAX_AGE_MS
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Ring Active Check -> Rang At: ${rangAtMs || 'N/A'}, Active: ${active}`)
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
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Edit Display Updated -> ${pad2(this.state.hour)}h ${pad2(this.state.minute)}m, Window: ${this.state.windowMin} min`)
    }
  },

  saveTimeAndReturn() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.saveTimeAndReturn()`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Persisting target time -> Hour: ${this.state.hour}, Minute: ${this.state.minute}`)
    localStorage.setItem('smart_wake_hour', String(this.state.hour))
    localStorage.setItem('smart_wake_minute', String(this.state.minute))
    localStorage.setItem('smart_wake_window_min', String(this.state.windowMin))

    if (this.state.enabled) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm is enabled. Re-scheduling service for new time...`)
      this.scheduleAlarmService()
    }

    this.showScreen('main')
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.saveTimeAndReturn()`)
  },

  dismissAlarm() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.dismissAlarm()`)
    try {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Invoking getApp().stopVibration()...`)
      callApp('stopVibration')
      // A dismissed ring can no longer be snoozed
      localStorage.removeItem('smart_wake_rang_at_ms')

      // EXPLICIT CHECK: If alarm is actively enabled, ensure tomorrow's alarm is locked in
      if (this.state.enabled) {
        console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm is active -> Invoking getApp().scheduleNextDayAlarm() from dismiss action...`)
        callApp('scheduleNextDayAlarm')
      }
    } catch (e) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] dismissAlarm exception:`, e)
    }
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.dismissAlarm()`)
  },

  snoozeAlarm() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.snoozeAlarm()`)
    if (!this.state.enabled) {
      console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Alarm disabled. Nothing to snooze.`)
      showToast({ text: 'Alarm is off' })
    } else {
      const snoozeUntilMs = callApp('snoozeAlarm')
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
    callApp('stopVibration')

    this.state.enabled = !this.state.enabled
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] New Alarm State: ${this.state.enabled}`)
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

    const startSeconds = Math.floor(windowStart.getTime() / 1000)

    const alarmId = set({
      url: 'page/gt/home/index.page',
      time: startSeconds
    })

    localStorage.setItem('smart_wake_alarm_id', String(alarmId))

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] === MANUAL SCHEDULE VERIFICATION ===`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Current Date/Time  : ${now.toLocaleString()}`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Checks Start Time : ${windowStart.toLocaleString()} (Alarm ID: ${alarmId})`)
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] Target Hard Limit : ${hardLimit.toLocaleString()}`)

    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] EXIT: Page.scheduleAlarmService()`)
  },

  cancelAlarmService() {
    console.log(`[SMART_WAKE_TRACE ${getLogTime()}] ENTER: Page.cancelAlarmService()`)
    try {
      // Only stop the motor here; dismissAlarm() would schedule a new alarm while we cancel
      callApp('stopVibration')

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
