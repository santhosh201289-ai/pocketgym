import { describe, it, expect } from 'vitest'
import { parseAppleHealthActivity, parseFit, parseGpx, parseTcx, parseActivityFiles, healthTime } from './import-activity.js'

const rec = (type, value, start, end = start, extra = '') =>
  `<Record type="${type}" sourceName="${extra || 'iPhone'}" unit="count" startDate="${start}" endDate="${end}" value="${value}"/>`

describe('Apple Health export', () => {
  const xml = `<?xml version="1.0"?><HealthData>
    ${rec('HKQuantityTypeIdentifierStepCount', 3000, '2026-10-16 08:00:00 +0530')}
    ${rec('HKQuantityTypeIdentifierStepCount', 2500, '2026-10-16 18:00:00 +0530')}
    ${rec('HKQuantityTypeIdentifierStepCount', 4000, '2026-10-16 08:00:00 +0530', '2026-10-16 08:30:00 +0530', 'Apple Watch')}
    <Record type="HKQuantityTypeIdentifierDistanceWalkingRunning" sourceName="iPhone" unit="km" startDate="2026-10-16 08:00:00 +0530" endDate="2026-10-16 09:00:00 +0530" value="4.2"/>
    <Record type="HKQuantityTypeIdentifierActiveEnergyBurned" sourceName="Apple Watch" unit="kJ" startDate="2026-10-16 08:00:00 +0530" endDate="2026-10-16 09:00:00 +0530" value="418.4"/>
    <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Apple Watch" unit="count/min" startDate="2026-10-16 07:00:00 +0530" endDate="2026-10-16 07:00:00 +0530" value="58"/>
    <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" startDate="2026-10-15 23:30:00 +0530" endDate="2026-10-16 03:30:00 +0530" value="HKCategoryValueSleepAnalysisAsleepCore"/>
    <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" startDate="2026-10-16 03:30:00 +0530" endDate="2026-10-16 04:00:00 +0530" value="HKCategoryValueSleepAnalysisAwake"/>
    <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" startDate="2026-10-16 04:00:00 +0530" endDate="2026-10-16 06:30:00 +0530" value="HKCategoryValueSleepAnalysisAsleepREM"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" sourceName="Apple Watch" startDate="2026-10-16 06:45:00 +0530" endDate="2026-10-16 07:15:00 +0530">
      <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="x" endDate="y" sum="5.1" unit="km"/>
      <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="x" endDate="y" average="152" minimum="100" maximum="171" unit="count/min"/>
    </Workout>
    <Workout workoutActivityType="HKWorkoutActivityTypeSwimming" duration="40" durationUnit="min" totalDistance="1500" totalDistanceUnit="m" totalEnergyBurned="350" totalEnergyBurnedUnit="kcal" sourceName="Apple Watch" startDate="2026-10-17 07:00:00 +0530" endDate="2026-10-17 07:40:00 +0530">
      <MetadataEntry key="HKLapLength" value="25 m"/>
    </Workout>
  </HealthData>`
  const r = parseAppleHealthActivity(xml)

  it('takes a day\'s steps from the source that counted most, not the sum of overlapping sources', () => {
    const d = r.days.find(x => x.d === '2026-10-16')
    expect(d.steps).toBe(5500)
  })
  it('reads distance, energy (kJ converted), resting heart rate and sleep', () => {
    const d = r.days.find(x => x.d === '2026-10-16')
    expect(d.distM).toBeCloseTo(4200)
    expect(d.activeKcal).toBeCloseTo(100)
    expect(d.restHr).toBe(58)
    expect(d.sleepMin).toBe(4 * 60 + 150) // awake time left out
  })
  it('reads workouts, totals from statistics or attributes', () => {
    const run = r.sessions.find(s => s.type === 'run')
    expect(run).toMatchObject({ durS: 1800, distM: 5100, avgHr: 152, maxHr: 171 })
    expect(run.start).toBe(healthTime('2026-10-16 06:45:00 +0530'))
    const swim = r.sessions.find(s => s.type === 'swim')
    expect(swim).toMatchObject({ distM: 1500, kcal: 350, poolM: 25, durS: 2400 })
  })
  it('refuses a file that is not a Health export', () => {
    expect(parseAppleHealthActivity('date,weight\n2026-01-01,80').error).toBe('unrecognised')
  })
})

// A minimal FIT file: header, one definition of the session message, one data record.
function fitSession({ start, sport, elapsedMs, distCm, kcal, avgHr, maxHr, laps, poolCm }) {
  const fields = [[2, 4], [5, 1], [7, 4], [9, 4], [11, 2], [16, 1], [17, 1], [26, 2], [44, 2]]
  const def = [0x40, 0, 0, 18, 0, fields.length, ...fields.flatMap(([num, size]) => [num, size, size === 1 ? 0 : 0x84])]
  const data = [0x00]
  const put = (v, size) => { for (let i = 0; i < size; i++) data.push((v >>> (8 * i)) & 0xff) }
  const vals = { 2: start - 631065600, 5: sport, 7: elapsedMs, 9: distCm, 11: kcal, 16: avgHr, 17: maxHr, 26: laps ?? 0xffff, 44: poolCm ?? 0xffff }
  for (const [num, size] of fields) put(vals[num], size)
  const body = [...def, ...data]
  const header = [14, 0x20, 0, 0, ...[0, 8, 16, 24].map(s => (body.length >>> s) & 0xff), 46, 70, 73, 84, 0, 0]
  return new Uint8Array([...header, ...body, 0, 0])
}

describe('FIT', () => {
  it('reads a run session', () => {
    const start = Date.UTC(2026, 9, 16, 1, 15) / 1000
    const r = parseFit(fitSession({ start, sport: 1, elapsedMs: 1800000, distCm: 510000, kcal: 420, avgHr: 150, maxHr: 175 }))
    expect(r.sessions).toHaveLength(1)
    expect(r.sessions[0]).toMatchObject({ type: 'run', start: start * 1000, durS: 1800, distM: 5100, kcal: 420, avgHr: 150, maxHr: 175 })
  })
  it('reads a pool swim with laps and pool length', () => {
    const r = parseFit(fitSession({ start: 1760000000, sport: 5, elapsedMs: 2400000, distCm: 150000, kcal: 300, avgHr: 130, maxHr: 160, laps: 60, poolCm: 2500 }))
    expect(r.sessions[0]).toMatchObject({ type: 'swim', distM: 1500, laps: 60, poolM: 25 })
  })
  it('refuses bytes that are not FIT', () => {
    expect(parseFit(new Uint8Array(20)).error).toBe('unrecognised')
  })
})

describe('GPX and TCX', () => {
  it('measures a GPX track and reads its heart rate', () => {
    const gpx = `<gpx version="1.1"><trk><name>Morning Run</name><type>running</type><trkseg>
      <trkpt lat="12.9716" lon="77.5946"><time>2026-10-16T01:00:00Z</time><extensions><gpxtpx:hr>140</gpxtpx:hr></extensions></trkpt>
      <trkpt lat="12.9806" lon="77.5946"><time>2026-10-16T01:06:00Z</time><extensions><gpxtpx:hr>160</gpxtpx:hr></extensions></trkpt>
    </trkseg></trk></gpx>`
    const s = parseGpx(gpx).sessions[0]
    expect(s.type).toBe('run')
    expect(s.durS).toBe(360)
    expect(s.distM).toBeGreaterThan(990)
    expect(s.distM).toBeLessThan(1010)
    expect(s).toMatchObject({ avgHr: 150, maxHr: 160 })
  })
  it('sums the laps of a TCX activity', () => {
    const tcx = `<TrainingCenterDatabase><Activities><Activity Sport="Biking"><Id>2026-10-16T01:00:00Z</Id>
      <Lap StartTime="2026-10-16T01:00:00Z"><TotalTimeSeconds>600</TotalTimeSeconds><DistanceMeters>5000</DistanceMeters><Calories>100</Calories><AverageHeartRateBpm><Value>130</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>150</Value></MaximumHeartRateBpm></Lap>
      <Lap StartTime="2026-10-16T01:10:00Z"><TotalTimeSeconds>600</TotalTimeSeconds><DistanceMeters>6000</DistanceMeters><Calories>120</Calories><AverageHeartRateBpm><Value>150</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>170</Value></MaximumHeartRateBpm></Lap>
    </Activity></Activities></TrainingCenterDatabase>`
    expect(parseTcx(tcx).sessions[0]).toMatchObject({ type: 'ride', durS: 1200, distM: 11000, kcal: 220, avgHr: 140, maxHr: 170 })
  })
})

describe('several files at once', () => {
  it('parses each by its kind and counts what it could not read', async () => {
    const files = [
      { name: 'a.fit', bytes: fitSession({ start: 1760000000, sport: 2, elapsedMs: 3600000, distCm: 3000000, kcal: 700, avgHr: 140, maxHr: 170 }) },
      { name: 'notes.xml', bytes: new TextEncoder().encode('<nothing/>') },
    ]
    const r = await parseActivityFiles(files, f => f.bytes.buffer)
    expect(r.sessions).toHaveLength(1)
    expect(r.sessions[0].type).toBe('ride')
    expect(r.skipped).toBe(1)
    expect(r.sources).toEqual(['FIT'])
  })
})
