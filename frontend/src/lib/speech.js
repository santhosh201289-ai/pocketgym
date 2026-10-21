// Speech to text, for planning by voice (lib/voice-plan.js). The browser's own recogniser where
// there is one (Chrome, Edge, Safari), and on the Android app the phone's (SpeechPlugin.java):
// Android's WebView has no SpeechRecognition of its own. Nothing is recorded or kept here; the
// recogniser hands back text and that is all this sees.
import { MOBILE, isAndroid } from './mobile.js'

const WebRecognition = () => (typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null) || null

let native = null
const nativePlugin = async () => {
  if (!native) {
    const { registerPlugin } = await import('@capacitor/core')
    native = registerPlugin('Speech')
  }
  return native
}

/** The language asked for: English, in the person's own region where it is an English one. */
export function speechLang(nav = typeof navigator !== 'undefined' ? navigator : null) {
  const l = String(nav?.language || '')
  return /^en-[A-Z]{2}$/i.test(l) ? l : 'en-IN'
}

/** Whether this device can listen at all. */
export async function speechSupported() {
  if (MOBILE) {
    if (!(await isAndroid())) return !!WebRecognition()
    try { return !!(await (await nativePlugin()).available()).available } catch { return false }
  }
  return !!WebRecognition()
}

/**
 * Listens once and resolves with what was said (the best guess first, then alternatives), or
 * rejects with an Error whose `code` is 'permission', 'no-speech', 'unsupported' or 'failed'.
 * `onPartial` gets the words so far. Returns { result: Promise<string[]>, stop() }.
 */
export function listen({ lang = speechLang(), onPartial } = {}) {
  let stop = () => {}
  const result = (async () => {
    if (MOBILE && (await isAndroid())) {
      const p = await nativePlugin()
      const sub = onPartial ? await p.addListener('partial', e => onPartial(e.text || '')) : null
      stop = () => { p.stop().catch(() => {}) }
      try {
        const r = await p.listen({ lang })
        return [r.text, ...(r.alternatives || [])].filter(Boolean)
      } catch (e) {
        throw Object.assign(new Error(e.message || 'failed'), { code: e.code || e.message || 'failed' })
      } finally { sub?.remove() }
    }
    const R = WebRecognition()
    if (!R) throw Object.assign(new Error('unsupported'), { code: 'unsupported' })
    return await new Promise((resolve, reject) => {
      const rec = new R()
      rec.lang = lang
      rec.interimResults = !!onPartial
      rec.maxAlternatives = 3
      rec.continuous = false
      let done = false
      const finish = (fn, v) => { if (!done) { done = true; fn(v) } }
      rec.onresult = e => {
        const last = e.results[e.results.length - 1]
        const said = [...last].map(a => a.transcript.trim()).filter(Boolean)
        if (last.isFinal) finish(resolve, said)
        else onPartial?.(said[0] || '')
      }
      rec.onerror = e => {
        const code = e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'permission' : e.error === 'no-speech' ? 'no-speech' : 'failed'
        finish(reject, Object.assign(new Error(e.error || 'failed'), { code }))
      }
      rec.onend = () => finish(reject, Object.assign(new Error('no-speech'), { code: 'no-speech' }))
      stop = () => { try { rec.stop() } catch { /* already stopped */ } }
      rec.start()
    })
  })()
  return { result, stop: () => stop() }
}
