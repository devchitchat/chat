# Media Device Picker — Plan

Let users select which camera and microphone to use before and during a call,
and recover when a device is added or removed mid-call.

---

## Problem

The current call flow always calls `getUserMedia({ audio: true, video: true })`
with no `deviceId` constraint, so the browser picks arbitrarily. There is no
way to:

- Choose between a built-in camera and a USB webcam
- Switch from the laptop mic to a headset mic
- Recover after a device is unplugged and a replacement is plugged in
- See a preview of the selected camera before joining

---

## Browser APIs used

| API | Purpose |
|---|---|
| `navigator.mediaDevices.enumerateDevices()` | List available cameras, mics, speakers |
| `getUserMedia({ video: { deviceId: { exact } } })` | Acquire a specific device |
| `RTCRtpSender.replaceTrack(newTrack)` | Swap track on live peer connections without renegotiation |
| `navigator.mediaDevices.addEventListener('devicechange', …)` | Detect plug/unplug events |

**Device label caveat**: `enumerateDevices()` returns empty `label` strings until the
user has granted camera/mic permission at least once. Enumerate after `getUserMedia`
succeeds to guarantee labels are available. Does this call for a state machine? Discuss before implementing.
---

## User-facing behaviour

### Before joining a call

A gear icon next to "Start call" / "Join call" opens the device picker panel.
The panel shows:

- Camera dropdown (all `videoinput` devices) + live preview thumbnail
- Microphone dropdown (all `audioinput` devices) + level meter
- "Save" persists the selection to localStorage under `devchitchat_devices`

Selections are remembered across page loads. The picker reads them on mount;
`getUserMedia` uses `deviceId: { ideal: savedId }` so it gracefully degrades if
the saved device is no longer available.

### During a call

A gear icon appears in the call controls bar (`.call-controls-bar`). Opening it
shows the same dropdowns but with a "Switch" button instead of "Save". Switching:

1. Acquires a new stream from the chosen device
2. Calls `sender.replaceTrack(newTrack)` on every active peer connection — no
   renegotiation needed, no call interruption for remote peers
3. Replaces the local tile's `video.srcObject`

### When a device is plugged in

While in a call, `devicechange` fires. The island re-enumerates and compares the
new list against the active devices. If the currently-used device was removed:

- The call controls gear icon gains a visual warning indicator
- A toast appears: "Your camera was disconnected — click ⚙ to switch"

If a new device appears, the gear icon pulses briefly to draw attention. The user
is never forced to switch; they just have an obvious path to do so.

---

## What changes

### 1. `pages/public/client/islands/call.js`

#### 1a — Device state

```js
// Persisted device preferences
const STORAGE_KEY = 'devchitchat_devices'

function loadSavedDevices() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') } catch { return {} }
}
function saveDevices(patch) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadSavedDevices(), ...patch }))
}

// Runtime state
let availableDevices = { cameras: [], mics: [] }  // refreshed by enumerateDevices()
let activeCameraId   = null   // deviceId of the currently streaming camera
let activeMicId      = null   // deviceId of the currently streaming mic
```

#### 1b — Device enumeration helper

```js
async function refreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  availableDevices = {
    cameras: devices.filter(d => d.kind === 'videoinput'),
    mics:    devices.filter(d => d.kind === 'audioinput'),
  }
  return availableDevices
}
```

Called:
- After `getUserMedia` succeeds (labels are now populated)
- On every `devicechange` event while in a call

#### 1c — Updated `_getLocalMedia`

Replace the bare `getUserMedia` call with one that respects saved preferences:

```js
async function _getLocalMedia() {
  const saved = loadSavedDevices()
  const [camStream, micStream] = await Promise.all([
    navigator.mediaDevices.getUserMedia({
      video: { deviceId: saved.cameraId ? { ideal: saved.cameraId } : undefined },
    }),
    navigator.mediaDevices.getUserMedia({
      audio: { deviceId: saved.micId    ? { ideal: saved.micId    } : undefined },
    }),
  ])
  // Record which devices were actually acquired
  activeCameraId = camStream.getVideoTracks()[0]?.getSettings().deviceId ?? null
  activeMicId    = micStream.getAudioTracks()[0]?.getSettings().deviceId ?? null

  // Now that permission is granted, labels are available
  await refreshDevices()

  // Keep separate streams so we can replace them independently
  videoStream = camStream
  audioStream = micStream
  return { camStream, micStream }
}
```

**Note**: `audioStream` and `videoStream` are already separate variables in the
existing island. The current code uses a single combined stream — split them as
part of this change.

#### 1d — `switchCamera(deviceId)` and `switchMic(deviceId)`

```js
async function switchCamera(deviceId) {
  const newStream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId } },
  })
  const newTrack = newStream.getVideoTracks()[0]

  // Replace on all peer connections — no renegotiation
  for (const { pc } of peerActors.values()) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video' && !s.track?.label?.includes('screen'))
    if (sender) await sender.replaceTrack(newTrack)
  }

  // Update local tile
  videoStream?.getTracks().forEach(t => t.stop())
  videoStream = newStream
  activeCameraId = deviceId
  saveDevices({ cameraId: deviceId })

  const localTile = tileGridEl?.querySelector('[data-peer="local"]')
  const video = localTile?.querySelector('video')
  if (video) video.srcObject = newStream
}

async function switchMic(deviceId) {
  const newStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId } },
  })
  const newTrack = newStream.getAudioTracks()[0]
  newTrack.enabled = !micMuted()  // respect current mute state

  for (const { pc } of peerActors.values()) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
    if (sender) await sender.replaceTrack(newTrack)
  }

  audioStream?.getTracks().forEach(t => t.stop())
  audioStream = newStream
  activeMicId = deviceId
  saveDevices({ micId: deviceId })
}
```

#### 1e — `devicechange` listener (attached once when joining a call)

```js
function onDeviceChange() {
  refreshDevices().then(({ cameras, mics }) => {
    const cameraGone = activeCameraId && !cameras.find(d => d.deviceId === activeCameraId)
    const micGone    = activeMicId    && !mics.find(d => d.deviceId === activeMicId)

    if (cameraGone || micGone) {
      _showDeviceWarning(cameraGone ? 'camera' : 'mic')
    }

    // Refresh dropdowns if the picker is currently open
    if (pickerEl?.classList.contains('open')) {
      _populatePicker()
    }
  })
}

// Attach on join, detach on leave
function _attachDeviceChangeListener() {
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
}
function _detachDeviceChangeListener() {
  navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
}
```

#### 1f — Device picker panel (built into the call controls bar)

The picker is a `<div class="device-picker">` rendered inline below the controls
bar. It is toggled open/closed by the gear button. It is built imperatively (no
rdbljs template — it's call-specific UI that only exists while in a call).

```js
let pickerEl = null

function _buildPicker() {
  pickerEl = document.createElement('div')
  pickerEl.className = 'device-picker'
  pickerEl.innerHTML = `
    <div class="device-picker-row">
      <label>Camera</label>
      <select id="dp-camera"></select>
      <video id="dp-preview" autoplay playsinline muted></video>
    </div>
    <div class="device-picker-row">
      <label>Microphone</label>
      <select id="dp-mic"></select>
      <canvas id="dp-level" width="80" height="12"></canvas>
    </div>
    <div class="device-picker-footer">
      <button id="dp-cancel" class="btn-ghost" type="button">Cancel</button>
      <button id="dp-apply"  class="btn-primary" type="button">Switch</button>
    </div>
  `
  // Insert after call-controls-bar
  callControlsEl?.after(pickerEl)

  pickerEl.querySelector('#dp-cancel').addEventListener('click', _closePicker)
  pickerEl.querySelector('#dp-apply').addEventListener('click', _applyPicker)

  const cameraSelect = pickerEl.querySelector('#dp-camera')
  const previewVideo = pickerEl.querySelector('#dp-preview')

  cameraSelect.addEventListener('change', async () => {
    // Show live preview of selected camera without committing the switch yet
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: cameraSelect.value } }
    })
    previewVideo.srcObject = stream
    // Stop preview stream when picker closes
    pickerEl._previewStream = stream
  })
}

function _populatePicker() {
  const { cameras, mics } = availableDevices
  const cameraSelect = pickerEl?.querySelector('#dp-camera')
  const micSelect    = pickerEl?.querySelector('#dp-mic')

  if (cameraSelect) {
    cameraSelect.innerHTML = cameras
      .map(d => `<option value="${d.deviceId}" ${d.deviceId === activeCameraId ? 'selected' : ''}>${d.label || 'Camera'}</option>`)
      .join('')
  }
  if (micSelect) {
    micSelect.innerHTML = mics
      .map(d => `<option value="${d.deviceId}" ${d.deviceId === activeMicId ? 'selected' : ''}>${d.label || 'Microphone'}</option>`)
      .join('')
  }
}

async function _openPicker() {
  if (!pickerEl) _buildPicker()
  await refreshDevices()
  _populatePicker()
  pickerEl.classList.add('open')
}

function _closePicker() {
  pickerEl?._previewStream?.getTracks().forEach(t => t.stop())
  if (pickerEl) pickerEl._previewStream = null
  pickerEl?.classList.remove('open')
}

async function _applyPicker() {
  const cameraId = pickerEl.querySelector('#dp-camera')?.value
  const micId    = pickerEl.querySelector('#dp-mic')?.value
  if (cameraId && cameraId !== activeCameraId) await switchCamera(cameraId)
  if (micId    && micId    !== activeMicId)    await switchMic(micId)
  _closePicker()
}
```

Wire the gear button in `_setupCallControls()`:

```js
// Gear / device picker button (already exists in phtml as #ctrl-devices)
document.getElementById('ctrl-devices')?.addEventListener('click', () => {
  pickerEl?.classList.contains('open') ? _closePicker() : _openPicker()
})
```

#### 1g — Device warning toast

```js
function _showDeviceWarning(kind) {
  const label = kind === 'camera' ? 'Camera' : 'Microphone'
  const toast = document.createElement('div')
  toast.className = 'device-warning-toast'
  toast.textContent = `${label} disconnected — click ⚙ to switch`
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 6000)

  // Add visual indicator on gear button
  document.getElementById('ctrl-devices')?.classList.add('device-warning')
}
```

---

### 2. `pages/channels/[channelId].phtml`

Add the gear/device-picker button to the in-call controls bar:

```html
<div class="call-controls-bar" id="call-controls-bar">
  <button class="btn-icon" id="ctrl-mic"     aria-label="Toggle microphone" type="button">🎙</button>
  <button class="btn-icon" id="ctrl-cam"     aria-label="Toggle camera"     type="button">📷</button>
  <button class="btn-icon" id="ctrl-screen"  aria-label="Share screen"      type="button">🖥</button>
  <button class="btn-icon" id="ctrl-devices" aria-label="Switch camera or microphone" type="button">⚙</button>
  <span class="call-peer-count" id="call-peer-count"></span>
  <button class="btn-leave" id="btn-leave-call" type="button">Leave</button>
</div>
```

The gear button is only visible when `.call-controls-bar.active` — no change
to call visibility logic.

---

### 3. `pages/public/themes/base.css`

```css
/* ── Device picker panel ──────────────────────────────────────────────── */
.device-picker {
  display: none;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px;
  background: var(--bg-topbar);
  border-bottom: 1px solid var(--border);
}
.device-picker.open { display: flex; }

.device-picker-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--text-secondary);
}
.device-picker-row label { width: 80px; flex-shrink: 0; font-weight: 600; }
.device-picker-row select {
  flex: 1;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 13px;
}
.device-picker-row video {
  width: 80px; height: 45px;
  border-radius: var(--radius-sm);
  object-fit: cover;
  background: var(--bg-sidebar);
  flex-shrink: 0;
}
.device-picker-row canvas {
  width: 80px; height: 12px;
  border-radius: 3px;
  background: var(--bg-sidebar);
  flex-shrink: 0;
}

.device-picker-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* Warning indicator on gear button */
.btn-icon.device-warning { color: var(--color-danger); }
.btn-icon.device-warning::after {
  content: '!';
  font-size: 9px;
  font-weight: 700;
  color: var(--color-danger);
  vertical-align: super;
}

/* Device disconnected toast */
.device-warning-toast {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--color-danger);
  color: white;
  padding: 8px 16px;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 600;
  z-index: 200;
  pointer-events: none;
  animation: toast-in 0.2s ease;
}
@keyframes toast-in {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
```

---

## File checklist

| File | Change |
|---|---|
| `pages/public/client/islands/call.js` | Add device state, `_getLocalMedia` split, `switchCamera`, `switchMic`, `devicechange` listener, picker build/open/close/apply, warning toast |
| `pages/channels/[channelId].phtml` | Add `#ctrl-devices` button to `.call-controls-bar` |
| `pages/public/themes/base.css` | Add `.device-picker`, `.device-warning-toast` styles |

No server changes. No schema changes. No new files.

---

## Out of scope

- Speaker output selection (`audiooutput` devices) — needs `HTMLMediaElement.setSinkId()`,
  behind a flag in some browsers; add in a follow-on
- Audio level meter animation in the picker — canvas draw loop; nice to have, not blocking
- Pre-call device picker (before joining) — the gear button approach at join time is sufficient
  for now; a full pre-call preview screen can come later
