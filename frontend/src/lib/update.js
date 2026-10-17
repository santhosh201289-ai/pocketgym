// Update check — compares the installed version (__APP_VERSION__) against the latest APK the
// Pocket Gym server publishes, and optionally downloads + installs it.
//
// The server publishes `latest.json` ({ version, apk, sha256 }) next to the APK, under
// UPDATE_BASE (scripts/android/build-apk.sh writes both). On Android (Capacitor) the APK is
// downloaded to the cache directory, checked against its SHA-256 and handed to the system
// installer via a content:// URI.

import { MOBILE } from './mobile.js'

/** Where the Android app is published. Set VITE_UPDATE_BASE at build time to move it. */
export const UPDATE_BASE = (import.meta.env?.VITE_UPDATE_BASE || 'https://pocketgym.cloud/android/').replace(/\/?$/, '/')
const LATEST_URL = UPDATE_BASE + 'latest.json'
/** The APK itself, for the web app's "Get the Android app" row. */
export const APK_URL = UPDATE_BASE + 'pocketgym.apk'

/**
 * Compares two semver strings (e.g. "1.2.11" vs "1.3.0").
 * Returns  1 if a > b, -1 if a < b, 0 if equal.
 *
 * Build metadata is dropped first. A version that says which build it came from carries it as
 * semver build metadata ("1.3.8+2026-09-18.2"), and splitting that on "." makes the patch NaN —
 * which read as 0, so a release tagged that way compared as 1.3.0 and a real update went
 * unnoticed. Semver says the metadata plays no part in precedence, so "1.3.7+anything" and
 * "1.3.7" are the same version here. Dropped on both operands, so it holds whichever side
 * carries it.
 */
function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split('+')[0].split('.').map(Number)
  const pb = b.replace(/^v/, '').split('+')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff > 0) return 1
    if (diff < 0) return -1
  }
  return 0
}

/**
 * Checks the GitLab releases API for a newer version.
 * Returns { hasUpdate, latestVersion, apkUrl, hashUrl } or throws on network failure.
 *   - hasUpdate: true if the latest release tag is newer than the running build
 *   - latestVersion: the semver string of the latest release (without "v" prefix)
 *   - apkUrl: direct download URL of the first .apk asset, or null
 *   - hashUrl: direct download URL of the .apk.sha256 hash file, or null
 */
// One request per app session: Settings is opened often, gitlab.com does not need to hear
// about it every time. The promise is cached, a failure is not.
let cached = null
export function resetUpdateCheck() { cached = null }
export async function checkForUpdate() {
  if (!cached) cached = fetchLatest().catch(e => { cached = null; throw e })
  return cached
}
async function fetchLatest() {
  const res = await fetch(LATEST_URL, { cache: 'no-cache' })
  if (res.status === 404) return { hasUpdate: false, latestVersion: __APP_VERSION__, apkUrl: null, hashUrl: null, sha256: null }
  if (!res.ok) throw new Error(`Update check ${res.status}`)
  const latest = await res.json()
  const latestVersion = String(latest.version || '').replace(/^v/, '')
  if (!latestVersion) return { hasUpdate: false, latestVersion: __APP_VERSION__, apkUrl: null, hashUrl: null, sha256: null }
  const hasUpdate = compareSemver(latestVersion, __APP_VERSION__) > 0
  const apkUrl = latest.apk ? new URL(latest.apk, UPDATE_BASE).href : APK_URL
  // The checksum comes in the same answer; hashUrl stays for callers that fetch a .sha256 file.
  return { hasUpdate, latestVersion, apkUrl, hashUrl: null, sha256: latest.sha256 || null }
}

/**
 * Computes the SHA-256 hash of an ArrayBuffer using the Web Crypto API.
 * Returns the hex-encoded digest string.
 */
export async function sha256(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Downloads the APK from `url`, verifies its SHA-256 hash against `expectedHash`
 * (if provided), and triggers the Android installer.
 * Only works on the MOBILE (Capacitor) build with Android.
 *
 * @param {string} url - Direct download URL for the APK
 * @param {string|null} expectedHash - Expected SHA-256 hex string (from .sha256 asset), or null to skip verification
 * @param {function|null} onProgress - Called with (received, total) bytes during download, or null
 */
export async function downloadAndInstall(url, expectedHash = null, onProgress = null) {
  if (!MOBILE) {
    // On web, just open the release page
    window.open(APK_URL, '_blank', 'noopener')
    return
  }

  const { Filesystem, Directory } = await import('@capacitor/filesystem')

  // Download with progress tracking via ReadableStream
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)

  const total = parseInt(res.headers.get('content-length') || '0', 10)
  const reader = res.body.getReader()
  const chunks = []
  let received = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (onProgress) onProgress(received, total)
  }

  // Reassemble into a single blob
  const blob = new Blob(chunks)

  // Size check: an APK should be at least 100 KB
  if (blob.size < 100_000) {
    throw new Error('Downloaded file is too small to be a valid APK (' + blob.size + ' bytes)')
  }

  // SHA-256 integrity check
  if (expectedHash) {
    const buffer = await blob.arrayBuffer()
    const actualHash = await sha256(buffer)
    if (actualHash !== expectedHash.toLowerCase().trim()) {
      throw new Error('SHA-256 mismatch: the download may be corrupted or tampered with')
    }
  }

  // Convert blob to base64
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })

  const fileName = 'pocketgym-update.apk'
  await Filesystem.writeFile({
    path: fileName,
    directory: Directory.Cache,
    data: base64,
  })

  // Use the local InstallPlugin to trigger the Android package installer
  const { registerPlugin } = await import('@capacitor/core')
  const Install = registerPlugin('Install')
  await Install.installApk({ fileName })
}
