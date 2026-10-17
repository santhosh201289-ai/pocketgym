package ch.duartesantos.pocketgym;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.contract.ActivityResultContract;
import androidx.health.connect.client.HealthConnectClient;
import androidx.health.connect.client.PermissionController;
import androidx.health.connect.client.aggregate.AggregateMetric;
import androidx.health.connect.client.aggregate.AggregationResult;
import androidx.health.connect.client.aggregate.AggregationResultGroupedByPeriod;
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord;
import androidx.health.connect.client.records.DistanceRecord;
import androidx.health.connect.client.records.ExerciseSessionRecord;
import androidx.health.connect.client.records.HeartRateRecord;
import androidx.health.connect.client.records.RestingHeartRateRecord;
import androidx.health.connect.client.records.SleepSessionRecord;
import androidx.health.connect.client.records.StepsRecord;
import androidx.health.connect.client.records.metadata.DataOrigin;
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest;
import androidx.health.connect.client.request.AggregateRequest;
import androidx.health.connect.client.request.ReadRecordsRequest;
import androidx.health.connect.client.response.ReadRecordsResponse;
import androidx.health.connect.client.time.TimeRangeFilter;
import androidx.health.connect.client.units.Energy;
import androidx.health.connect.client.units.Length;
import androidx.health.connect.client.records.Record;
import androidx.health.connect.client.records.WeightRecord;
import androidx.health.connect.client.records.metadata.Metadata;
import androidx.health.connect.client.units.Mass;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.Period;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlin.jvm.JvmClassMappingKt;
import kotlinx.coroutines.BuildersKt;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Writes finished workouts and weigh-ins to Health Connect (#200), the phone's own store for
 * health data, so other apps can read them, and reads activity back (read()). Each side is off until the user turns it on in
 * Settings: no permission is asked for before that. What to write is worked out in JS
 * (lib/health-connect.js); this side only turns those plain objects into records.
 *
 * Every record carries Pocket Gym's own id as its clientRecordId, so writing it again replaces it,
 * and "remove" finds exactly the records Pocket Gym wrote. The version is the time of the write:
 * Health Connect keeps a rewritten record only when its version is higher than the stored one.
 *
 * The client's API is Kotlin suspend functions. They are called from a worker thread through
 * runBlocking, which keeps the Android project Java-only.
 *
 * The client library needs Android 8 (API 26) and Health Connect itself Android 9 (API 28); the
 * app supports Android 6, so every entry point checks the version before a Health Connect class
 * is touched, and answers "unsupported" below 9.
 *
 * Usage from JS (lib/health-sync.js):
 *   const HC = registerPlugin('HealthConnect');
 *   await HC.status();              // { status: 'available' | 'update' | 'missing' | 'unsupported', granted }
 *   await HC.requestPermissions();  // { granted }
 *   await HC.write({ sessions: [...], weights: [...] });
 *   await HC.remove({ sessions: [ids], weights: [ids] });
 *   await HC.openSettings();        // Health Connect's data screen, or its store page
 *   await HC.requestReadPermissions(); // { granted } — the read side, asked for on its own
 *   await HC.read({ since });       // { days: [...], sleep: [...], sessions: [...] } since epoch ms
 */
@CapacitorPlugin(name = "HealthConnect")
public class HealthConnectPlugin extends Plugin {

    private static final String PROVIDER = "com.google.android.apps.healthdata";
    // The literal permission names, as declared in AndroidManifest.xml.
    private static final String WRITE_EXERCISE = "android.permission.health.WRITE_EXERCISE";
    private static final String WRITE_WEIGHT = "android.permission.health.WRITE_WEIGHT";
    // Reading what phones, bands and watches log (Settings → Import from Health Connect).
    private static final String[] READ = {
            "android.permission.health.READ_STEPS",
            "android.permission.health.READ_DISTANCE",
            "android.permission.health.READ_ACTIVE_CALORIES_BURNED",
            "android.permission.health.READ_RESTING_HEART_RATE",
            "android.permission.health.READ_HEART_RATE",
            "android.permission.health.READ_SLEEP",
            "android.permission.health.READ_EXERCISE",
    };
    // A read never reaches further back than this, and reads at most this many sessions.
    private static final int MAX_DAYS = 400;
    private static final int MAX_SESSIONS = 300;
    // What Pocket Gym itself wrote (lib/health-connect.js ids), so it is not read back as new.
    private static final String OWN_PREFIX = "pocketgym-";
    // Health Connect takes at most this many records in one insert.
    private static final int CHUNK = 500;

    // One at a time, in order: a remove queued behind a write must not overtake it.
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private static boolean supported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P;
    }

    private static Set<String> permissions() {
        Set<String> p = new HashSet<>();
        p.add(WRITE_EXERCISE);
        p.add(WRITE_WEIGHT);
        return p;
    }

    private String sdkStatus() {
        if (!supported()) return "unsupported";
        int s = HealthConnectClient.Companion.getSdkStatus(getContext(), PROVIDER);
        if (s == HealthConnectClient.SDK_AVAILABLE) return "available";
        if (s == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) return "update";
        // Android 13 and lower need the Health Connect app; 14 and up have it built in, so
        // "missing" there means the phone has no Health Connect at all (some Android Go builds).
        return Build.VERSION.SDK_INT >= 34 ? "unsupported" : "missing";
    }

    private HealthConnectClient client() {
        return HealthConnectClient.Companion.getOrCreate(getContext(), PROVIDER);
    }

    private static Set<String> readPermissions() {
        Set<String> p = new HashSet<>();
        Collections.addAll(p, READ);
        return p;
    }

    @SuppressWarnings("unchecked")
    private Set<String> granted() throws InterruptedException {
        PermissionController pc = client().getPermissionController();
        return (Set<String>) BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE, (scope, cont) -> pc.getGrantedPermissions(cont));
    }

    @PluginMethod
    public void status(PluginCall call) {
        String status = sdkStatus();
        if (!"available".equals(status)) {
            JSObject r = new JSObject();
            r.put("status", status);
            r.put("granted", false);
            call.resolve(r);
            return;
        }
        worker.execute(() -> {
            try {
                JSObject r = new JSObject();
                r.put("status", status);
                Set<String> g = granted();
                r.put("granted", g.containsAll(permissions()));
                r.put("readGranted", g.containsAll(readPermissions()));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage(), "failed");
            }
        });
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (!"available".equals(sdkStatus())) {
            call.reject("Health Connect is not available", "unavailable");
            return;
        }
        ActivityResultContract<Set<String>, Set<String>> contract = PermissionController.createRequestPermissionResultContract(PROVIDER);
        Intent intent = contract.createIntent(getContext(), permissions());
        startActivityForResult(call, intent, "permissionsResult");
    }

    @ActivityCallback
    private void permissionsResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        ActivityResultContract<Set<String>, Set<String>> contract = PermissionController.createRequestPermissionResultContract(PROVIDER);
        Set<String> got = contract.parseResult(result.getResultCode(), result.getData());
        // The dialog answers only for this time; ask Health Connect what stands now, since the
        // user may also have granted one of the two and not the other.
        worker.execute(() -> {
            try {
                JSObject r = new JSObject();
                r.put("granted", (got != null && got.containsAll(permissions())) || granted().containsAll(permissions()));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage(), "failed");
            }
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        if (!"available".equals(sdkStatus())) {
            call.reject("Health Connect is not available", "unavailable");
            return;
        }
        JSArray sessions = call.getArray("sessions", new JSArray());
        JSArray weights = call.getArray("weights", new JSArray());
        worker.execute(() -> {
            try {
                long version = System.currentTimeMillis();
                List<Record> records = new ArrayList<>();
                for (int i = 0; i < sessions.length(); i++) records.add(session(sessions.getJSONObject(i), version));
                for (int i = 0; i < weights.length(); i++) records.add(weight(weights.getJSONObject(i), version));
                for (int from = 0; from < records.size(); from += CHUNK) {
                    List<Record> part = records.subList(from, Math.min(records.size(), from + CHUNK));
                    BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE, (scope, cont) -> client().insertRecords(part, cont));
                }
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage(), "permission");
            } catch (Exception e) {
                call.reject(e.getMessage(), "failed");
            }
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        if (!"available".equals(sdkStatus())) {
            call.reject("Health Connect is not available", "unavailable");
            return;
        }
        JSArray sessions = call.getArray("sessions", new JSArray());
        JSArray weights = call.getArray("weights", new JSArray());
        worker.execute(() -> {
            try {
                delete(ExerciseSessionRecord.class, ids(sessions));
                delete(WeightRecord.class, ids(weights));
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage(), "permission");
            } catch (Exception e) {
                call.reject(e.getMessage(), "failed");
            }
        });
    }

    @PluginMethod
    public void requestReadPermissions(PluginCall call) {
        if (!"available".equals(sdkStatus())) {
            call.reject("Health Connect is not available", "unavailable");
            return;
        }
        ActivityResultContract<Set<String>, Set<String>> contract = PermissionController.createRequestPermissionResultContract(PROVIDER);
        Intent intent = contract.createIntent(getContext(), readPermissions());
        startActivityForResult(call, intent, "readPermissionsResult");
    }

    @ActivityCallback
    private void readPermissionsResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        // Partly granted is still useful (steps without sleep): report what stands, per kind.
        worker.execute(() -> {
            try {
                Set<String> g = granted();
                JSObject r = new JSObject();
                r.put("granted", g.containsAll(readPermissions()));
                JSArray kinds = new JSArray();
                for (String p : READ) if (g.contains(p)) kinds.put(p.substring(p.lastIndexOf('.') + 1));
                r.put("kinds", kinds);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage(), "failed");
            }
        });
    }

    /**
     * Everything logged since `since` (epoch ms, at most MAX_DAYS back), in three plain lists for
     * lib/health-sync.js to merge:
     *   days:     [{ d, steps, distM, activeKcal, restHr }] — Health Connect's own daily totals,
     *             which already count each step once however many apps recorded it
     *   sleep:    [{ start, end, awakeMs, origin }] — every sleep session, for JS to put on a night
     *   sessions: [{ id, type, start, end, title, origin, distM, kcal, avgHr, maxHr, laps }]
     * A kind the user did not grant is left out rather than failing the whole read.
     */
    @PluginMethod
    public void read(PluginCall call) {
        if (!"available".equals(sdkStatus())) {
            call.reject("Health Connect is not available", "unavailable");
            return;
        }
        long now = System.currentTimeMillis();
        long since = Math.max(call.getLong("since", now - 30L * 86400000L), now - MAX_DAYS * 86400000L);
        worker.execute(() -> {
            try {
                Set<String> g = granted();
                JSObject r = new JSObject();
                r.put("days", g.isEmpty() ? new JSArray() : days(g, since, now));
                r.put("sleep", g.contains("android.permission.health.READ_SLEEP") ? sleep(since, now) : new JSArray());
                r.put("sessions", g.contains("android.permission.health.READ_EXERCISE") ? sessions(g, since, now) : new JSArray());
                call.resolve(r);
            } catch (SecurityException e) {
                call.reject(e.getMessage(), "permission");
            } catch (Exception e) {
                call.reject(e.getMessage(), "failed");
            }
        });
    }

    private JSArray days(Set<String> g, long since, long now) throws Exception {
        Set<AggregateMetric<?>> metrics = new HashSet<>();
        if (g.contains("android.permission.health.READ_STEPS")) metrics.add(StepsRecord.COUNT_TOTAL);
        if (g.contains("android.permission.health.READ_DISTANCE")) metrics.add(DistanceRecord.DISTANCE_TOTAL);
        if (g.contains("android.permission.health.READ_ACTIVE_CALORIES_BURNED")) metrics.add(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL);
        if (g.contains("android.permission.health.READ_RESTING_HEART_RATE")) metrics.add(RestingHeartRateRecord.BPM_AVG);
        JSArray out = new JSArray();
        if (metrics.isEmpty()) return out;
        ZoneId zone = ZoneId.systemDefault();
        LocalDateTime from = Instant.ofEpochMilli(since).atZone(zone).toLocalDate().atStartOfDay();
        LocalDateTime to = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().plusDays(1).atStartOfDay();
        AggregateGroupByPeriodRequest req = new AggregateGroupByPeriodRequest(
                metrics, TimeRangeFilter.Companion.between(from, to), Period.ofDays(1), Collections.<DataOrigin>emptySet());
        @SuppressWarnings("unchecked")
        List<AggregationResultGroupedByPeriod> groups = (List<AggregationResultGroupedByPeriod>)
                BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE, (scope, cont) -> client().aggregateGroupByPeriod(req, cont));
        for (AggregationResultGroupedByPeriod grp : groups) {
            AggregationResult a = grp.getResult();
            JSObject d = new JSObject();
            d.put("d", grp.getStartTime().toLocalDate().toString());
            Long steps = metrics.contains(StepsRecord.COUNT_TOTAL) ? a.get(StepsRecord.COUNT_TOTAL) : null;
            Length dist = metrics.contains(DistanceRecord.DISTANCE_TOTAL) ? a.get(DistanceRecord.DISTANCE_TOTAL) : null;
            Energy kcal = metrics.contains(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL) ? a.get(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL) : null;
            Long rest = metrics.contains(RestingHeartRateRecord.BPM_AVG) ? a.get(RestingHeartRateRecord.BPM_AVG) : null;
            if (steps != null) d.put("steps", steps);
            if (dist != null) d.put("distM", dist.getInMeters());
            if (kcal != null) d.put("activeKcal", kcal.getInKilocalories());
            if (rest != null) d.put("restHr", rest);
            if (d.length() > 1) out.put(d);
        }
        return out;
    }

    private JSArray sleep(long since, long now) throws Exception {
        JSArray out = new JSArray();
        for (SleepSessionRecord s : readAll(SleepSessionRecord.class, since, now)) {
            long awake = 0;
            for (SleepSessionRecord.Stage st : s.getStages()) {
                int k = st.getStage();
                if (k == SleepSessionRecord.STAGE_TYPE_AWAKE || k == SleepSessionRecord.STAGE_TYPE_OUT_OF_BED) {
                    awake += Duration.between(st.getStartTime(), st.getEndTime()).toMillis();
                }
            }
            JSObject o = new JSObject();
            o.put("start", s.getStartTime().toEpochMilli());
            o.put("end", s.getEndTime().toEpochMilli());
            o.put("awakeMs", awake);
            o.put("origin", s.getMetadata().getDataOrigin().getPackageName());
            out.put(o);
        }
        return out;
    }

    private JSArray sessions(Set<String> g, long since, long now) throws Exception {
        JSArray out = new JSArray();
        List<ExerciseSessionRecord> all = readAll(ExerciseSessionRecord.class, since, now);
        String own = getContext().getPackageName();
        int n = 0;
        for (int i = all.size() - 1; i >= 0 && n < MAX_SESSIONS; i--) {
            ExerciseSessionRecord s = all.get(i);
            String cid = s.getMetadata().getClientRecordId();
            String origin = s.getMetadata().getDataOrigin().getPackageName();
            if ((cid != null && cid.startsWith(OWN_PREFIX)) || own.equals(origin)) continue;
            JSObject o = new JSObject();
            o.put("id", s.getMetadata().getId());
            o.put("type", sessionType(s.getExerciseType()));
            o.put("start", s.getStartTime().toEpochMilli());
            o.put("end", s.getEndTime().toEpochMilli());
            if (s.getTitle() != null) o.put("title", s.getTitle());
            o.put("origin", origin);
            if (!s.getLaps().isEmpty()) o.put("laps", s.getLaps().size());
            // The session's own totals, from the app that logged it.
            Set<AggregateMetric<?>> metrics = new HashSet<>();
            if (g.contains("android.permission.health.READ_DISTANCE")) metrics.add(DistanceRecord.DISTANCE_TOTAL);
            if (g.contains("android.permission.health.READ_ACTIVE_CALORIES_BURNED")) metrics.add(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL);
            if (g.contains("android.permission.health.READ_HEART_RATE")) { metrics.add(HeartRateRecord.BPM_AVG); metrics.add(HeartRateRecord.BPM_MAX); }
            if (!metrics.isEmpty()) {
                Set<DataOrigin> from = new HashSet<>();
                from.add(new DataOrigin(origin));
                AggregateRequest req = new AggregateRequest(metrics, TimeRangeFilter.Companion.between(s.getStartTime(), s.getEndTime()), from);
                try {
                    AggregationResult a = (AggregationResult) BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE, (scope, cont) -> client().aggregate(req, cont));
                    Length dist = metrics.contains(DistanceRecord.DISTANCE_TOTAL) ? a.get(DistanceRecord.DISTANCE_TOTAL) : null;
                    Energy kcal = metrics.contains(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL) ? a.get(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL) : null;
                    Long avg = metrics.contains(HeartRateRecord.BPM_AVG) ? a.get(HeartRateRecord.BPM_AVG) : null;
                    Long max = metrics.contains(HeartRateRecord.BPM_MAX) ? a.get(HeartRateRecord.BPM_MAX) : null;
                    if (dist != null) o.put("distM", dist.getInMeters());
                    if (kcal != null) o.put("kcal", kcal.getInKilocalories());
                    if (avg != null) o.put("avgHr", avg);
                    if (max != null) o.put("maxHr", max);
                } catch (Exception ignored) {
                    // A session without totals is still a session.
                }
            }
            out.put(o);
            n++;
        }
        return out;
    }

    // Every record of a kind in the window, page by page, oldest first.
    @SuppressWarnings("unchecked")
    private <T extends Record> List<T> readAll(Class<T> type, long since, long now) throws Exception {
        List<T> out = new ArrayList<>();
        String token = null;
        TimeRangeFilter range = TimeRangeFilter.Companion.between(Instant.ofEpochMilli(since), Instant.ofEpochMilli(now));
        do {
            ReadRecordsRequest<T> req = new ReadRecordsRequest<>(JvmClassMappingKt.getKotlinClass(type), range,
                    Collections.<DataOrigin>emptySet(), true, 1000, token);
            ReadRecordsResponse<T> res = (ReadRecordsResponse<T>)
                    BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE, (scope, cont) -> client().readRecords(req, cont));
            out.addAll(res.getRecords());
            token = res.getPageToken();
        } while (token != null && !token.isEmpty() && out.size() < 5000);
        return out;
    }

    // Health Connect's exercise kinds, as lib/activity.js names them.
    private static String sessionType(int t) {
        if (t == ExerciseSessionRecord.EXERCISE_TYPE_RUNNING || t == ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL) return "run";
        if (t == ExerciseSessionRecord.EXERCISE_TYPE_WALKING) return "walk";
        if (t == ExerciseSessionRecord.EXERCISE_TYPE_BIKING || t == ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY) return "ride";
        if (t == ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL || t == ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER) return "swim";
        if (t == ExerciseSessionRecord.EXERCISE_TYPE_HIKING) return "hike";
        return "other";
    }

    // Health Connect's own screen for the data apps wrote, where the user can look at and delete
    // what Pocket Gym wrote. Without Health Connect (Android 13 and lower), its store page instead.
    @PluginMethod
    public void openSettings(PluginCall call) {
        String status = sdkStatus();
        if ("unsupported".equals(status)) {
            call.reject("Health Connect is not available", "unavailable");
            return;
        }
        try {
            Intent intent = "available".equals(status)
                    ? HealthConnectClient.Companion.getHealthConnectManageDataIntent(getContext(), PROVIDER)
                    : new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + PROVIDER + "&url=healthconnect%3A%2F%2Fonboarding"));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), "failed");
        }
    }

    private void delete(Class<? extends Record> type, List<String> clientIds) throws InterruptedException {
        for (int from = 0; from < clientIds.size(); from += CHUNK) {
            List<String> part = clientIds.subList(from, Math.min(clientIds.size(), from + CHUNK));
            BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE, (scope, cont) ->
                    client().deleteRecords(JvmClassMappingKt.getKotlinClass(type), Collections.emptyList(), part, cont));
        }
    }

    private static List<String> ids(JSArray array) throws JSONException {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) out.add(array.getString(i));
        return out;
    }

    // The offset in force at that moment where the phone is now: what Health Connect shows the
    // session's local time with.
    private static ZoneOffset offsetAt(Instant at) {
        return ZoneId.systemDefault().getRules().getOffset(at);
    }

    private static ExerciseSessionRecord session(JSONObject s, long version) throws JSONException {
        Instant start = Instant.ofEpochMilli(s.getLong("start"));
        Instant end = Instant.ofEpochMilli(s.getLong("end"));
        String title = s.optString("title", "");
        String notes = s.optString("notes", "");
        return new ExerciseSessionRecord(
                start, offsetAt(start), end, offsetAt(end),
                Metadata.manualEntry(s.getString("id"), version),
                exerciseType(s.optString("type")),
                title.isEmpty() ? null : title,
                notes.isEmpty() ? null : notes);
    }

    private static WeightRecord weight(JSONObject w, long version) throws JSONException {
        Instant time = Instant.ofEpochMilli(w.getLong("time"));
        return new WeightRecord(time, offsetAt(time), Mass.kilograms(w.getDouble("kg")),
                Metadata.manualEntry(w.getString("id"), version));
    }

    // The names lib/health-connect.js uses (SESSION_TYPES); anything else is "other".
    private static int exerciseType(String name) {
        switch (name) {
            case "strength_training": return ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING;
            case "walking": return ExerciseSessionRecord.EXERCISE_TYPE_WALKING;
            case "running": return ExerciseSessionRecord.EXERCISE_TYPE_RUNNING;
            case "biking_stationary": return ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY;
            case "elliptical": return ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL;
            case "stair_climbing_machine": return ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING_MACHINE;
            default: return ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT;
        }
    }
}
