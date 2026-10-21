# Importing and exporting data

Everything here lives in the app under **Settings → Data & backup**, except plan sharing, which is on the
**Plan** screen.

| You want to | Use |
|---|---|
| Bring your workout history from another app | **Import from another app** (CSV) |
| Pull workouts, routines and weigh-ins from Hevy Pro | **Import from Hevy** (API key) |
| Bring body weight over from an iPhone | **Import from another app** with the Apple Health export |
| Give someone your routines | **Plan → Share your plan → Export plan file** |
| Back up or move everything | **Export backup** / **Import backup** |
| Bring in steps, sleep, heart rate, runs, rides and swims | **Import activity** (Apple Health export, FIT, GPX, TCX) |

## Workout history from another app

Export a CSV from your old app, then pick it under **Settings → Data & backup → Import from another app**.
Pocket Gym matches exercise names against its library; anything it doesn't recognise becomes one of
your own exercises, so nothing in the file is dropped. Days that already have a workout in Pocket Gym
are left alone, so importing the same file twice never duplicates anything.

These exports work without any editing:

| App | Where to export |
|---|---|
| FitNotes (Android) | Settings → Backup/Export → **Spreadsheet Export** |
| FitNotes 2 (iOS) | Export workouts as CSV |
| Strong | Settings → Export Data |
| Hevy | Profile → Settings → Export & Import Data |
| Gravl | Profile → Export Data |

Other files work too, as long as they have a date, an exercise name and something measured
(weight and reps, a time or a distance). See [your own CSV](#your-own-csv) below.

> [!NOTE]
> History is a log of what you did, so it's imported separately from your routines. Importing
> workouts doesn't create or change any plan.

## Hevy, directly

With **Hevy Pro** you can skip the CSV:

1. In Hevy, open [Settings → Developer](https://hevy.com/settings?developer) and create an API key.
2. In Pocket Gym, go to **Settings → Data & backup → Import from Hevy** and paste the key. It's used for this
   import only and isn't saved.
3. Choose workouts, routines, weigh-ins or any mix, then confirm.

Routines always arrive as new plans; nothing you already have is overwritten.

## Body weight from Apple Health

In the Health app on your iPhone, tap your profile picture, then **Export All Health Data**. Unzip
the result and pick `export.xml` under **Import from another app**. The file is often hundreds of
megabytes; Pocket Gym reads only the body-weight records from it, in whatever unit each one was saved
in, and keeps one weigh-in per day. Days that already have a weigh-in are left alone.

A CSV with a date column and a weight column works the same way.

## Activity: steps, sleep, runs, rides and swims

Pocket Gym keeps daily activity (steps, distance, active calories, resting heart rate, sleep) and
cardio sessions (runs, walks, rides, swims, hikes) next to your strength training. Sessions are kept
apart from workouts, so they never change progression, volume or records. They show on Home
(**Today's activity**, which you can hide under Settings → On Home) and in Stats (**Steps & cardio**).

Pick one or several files under **Settings → Data & backup → Import activity**:

| From | What to export | What comes in |
|---|---|---|
| iPhone (Apple Watch, and bands that sync to Apple Health: Noise, Garmin, Mi, Amazfit…) | Health → profile picture → **Export All Health Data**, unzip, pick `export.xml` | Daily steps, walking/running distance, active energy, resting heart rate, sleep, and every workout |
| Garmin Connect | An activity → ⚙ → **Export Original** (.fit) or Export to GPX/TCX | That session |
| Strava | An activity → ⋯ → **Export Original** or **Export GPX**; or Settings → My Account → **Download or delete your account** for everything | Those sessions |
| Coros, Polar, Suunto, Wahoo, Zepp and other watches | Their app's FIT, GPX or TCX export | Those sessions |

What each session keeps: kind, start, duration, distance, calories, average and maximum heart rate,
and for swims the pool length and laps. GPS tracks are not stored.

Importing is safe to repeat. A session you already have is skipped, also when it comes from a second
source: the same kind starting within two minutes is treated as the same session (your watch's file
and Strava's copy, say). For a day's steps, Apple Health lists the iPhone and the watch separately;
the day takes the source that counted the most, as Health itself does, rather than adding them up.

You can also add a session or a day's steps, sleep and resting heart rate by hand from the Home card.

## Activity from an iPhone, every day

Apple Health can only be read by a native iPhone app, so instead the iPhone sends its numbers
to your server. In **Settings → Data & backup → Send activity from iPhone**, tap **Create a
token**. You get an address and an `Authorization` header to copy. The token is shown only once,
and the server keeps only a hash of it. The token can add activity to your profile and nothing
else. **Make a new token** replaces it and **Turn off** retires it; signing out everywhere does
not.

**With the Shortcuts app (free):**

1. Create a new shortcut called "Pocket Gym".
2. Add **Find Health Samples** with Type *Steps* and Start Date *is Today*, then **Calculate
   Statistics** set to *Sum*. Do the same for *Walking + Running Distance* (km) and *Active
   Energy* (kcal). Resting Heart Rate is optional: sort by Start Date, latest first, limit 1.
3. Add **Format Date** with *Current Date* and the custom format `yyyy-MM-dd`.
4. Add **Get Contents of URL** with the address. Set Method to *POST* and add the header
   `Authorization: Bearer pgi_…`. Set Request Body to *JSON*, with the fields `date`, `steps`,
   `distanceKm`, `activeKcal` and `restingHr`, each set to its result.
5. Go to **Automation → Time of Day**, choose for example 22:00 daily, set it to *Run
   Immediately*, and pick that shortcut.

The shortcut can run as often as you like. Sending the same numbers again changes nothing, and a
later run replaces that day's totals. Workouts are easiest from an Apple Health export (above) or,
later, from Strava.

**With [Health Auto Export](https://www.healthyapps.dev/) (paid, fully automatic):**

- Add a *REST API* automation with the same address and header, in JSON format.
- Pick Step Count, Walking + Running Distance, Active Energy, Resting Heart Rate, Sleep Analysis
  and Workouts.
- Pocket Gym reads that app's format as it is: steps per day, sleep on the day it ended, and
  workouts as runs, rides, walks, swims and hikes.

**From a script:** the request is `POST /api/ingest/activity`, and `api/openapi.yaml` lists every
field. For example:

```sh
curl -X POST https://gym.example.com/api/ingest/activity \
  -H "Authorization: Bearer pgi_…" -H "Content-Type: application/json" \
  -d '{"date":"2026-10-21","steps":8123,"distanceKm":5.2,"activeKcal":410,"restingHr":55,"sleepHours":7.2}'
```

## Sharing a plan

On the **Plan** screen, tap the share icon:

- **Export plan file** writes your routines and weekly schedule to a small JSON file. It contains
  no workouts and no weigh-ins.
- **Import a plan file** adds someone else's plan to yours. It merges, so your own routines are
  never overwritten.
- **Print / Save as PDF** gives you a clean printout.

An export always contains every routine. To share only some of them, import the file into the
[demo](https://opengym.ch/demo/), delete what you don't want, and export again. The
demo keeps everything in your browser; nothing is uploaded. The same trick works for building a plan
on a computer and then importing it into the phone app.

Writing a plan file by hand is possible but fiddly, because the exercise ids have to match the
library.

## Backups

- **Export backup (JSON)** saves your whole profile as one file. **Export with photos & videos
  (.zip)** includes your media as well.
- **Import backup** restores such a file and *replaces* everything currently in the app.
- **Auto-backup on changes** (phone app only) saves a dated copy to `Documents/PocketGym` after each
  workout or routine edit and keeps the newest 14. Point a sync app at that folder to get them off
  the phone — or, on Android, choose the sync app's own folder under Settings → Data & backup → **Backup folder**.

If you host Pocket Gym yourself, backing up the `./data` folder covers every profile at once; see
[backups](SELF_HOSTING.md#6-backups).

## Your own CSV

The smallest file that works:

```csv
workout name,exercise,date,weight kg,reps
Leg Day,Squat,2026-08-21,120,5
Leg Day,Squat,2026-08-21,125,4
Leg Day,Leg Press,2026-08-21,200,1
```

One row per set. Column names are matched ignoring case and punctuation; the first match wins.

| Field | Accepted headers |
|---|---|
| exercise | `exercise`, `exercise name`, `exercise title` |
| date | `date`, `workout date` |
| start time | `start time`, `start date` |
| end time | `end time` |
| workout name | `workout name`, `title`, `workout` |
| category | `category`, `body part`, `muscle group` |
| weight in kg | `weight kg` |
| weight in lb | `weight lbs`, `weight lb` |
| weight, unit in another column | `weight` |
| weight unit | `weight unit`, `unit` |
| reps | `reps`, `repetitions` |
| RPE | `rpe`, `rpe rating` |
| RIR | `rir`, `reps in reserve` |
| distance in km | `distance km` |
| distance, unit in another column | `distance` |
| distance unit | `distance unit` |
| duration in seconds | `seconds`, `duration seconds`, `set duration sec` |
| duration | `time`, `duration` |
| set type | `set type` |
| note | `comment`, `comments`, `notes`, `note`, `workout notes` |

## For developers

The CSV parser is `frontend/src/lib/import-csv.js`. The Hevy API import and a detected Hevy CSV
resolve exercises through the same generated lookup, `frontend/src/lib/hevy-id-map.js` (template id
for the API, English title for the CSV). To regenerate it, set `HEVY_API_KEY` in the environment or
`.env` and run `node scripts/build-hevy-id-map.mjs`. Localised (non-English) Hevy titles fall back
to name matching.
