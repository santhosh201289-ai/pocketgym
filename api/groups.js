// Groups: a coach, the people they coach, and the routines they send them.
//
//   db.groups      = [{ id, name, coach: uid, at, members: [{ uid, status: 'invited'|'active', at }] }]
//   db.assignments = [{ id, group, coach: uid, to: uid, at, note, plan, weekly, dates,
//                       status: 'pending'|'accepted'|'declined', answered? }]
//
// Who can do what:
//   - Only a coach creates a group: an admin, or a profile an admin made one (user.coach).
//   - A coach adds people by name; each is `invited` until they accept, and sees nothing of the
//     group but its name and the coach's name until then. Either side can end it at any time.
//   - A coach sees an `active` member's training, activity and body weight (memberSummary), and
//     nothing of anyone who has not accepted.
//   - A coach sends a routine, with the weekdays (every week) or dates (once) to train it, as an
//     assignment. It changes nothing until the member accepts it in their own app, which applies
//     it the way a shared plan file is imported (frontend lib/group-assign.js).
//
// `plan` is a shared-plan bundle (frontend lib/plan-share.js buildPlanBundle) holding the one
// routine: the member's app validates every exercise in it and converts kg and lb on accept, as
// it does for a plan file. Here it is only bounded in size and shape.
import { libraryName } from './coach/core/library.js';
import { isWarmupSet } from './coach/core/payload.js';

export const MAX_GROUPS = 20;            // per coach
export const MAX_MEMBERS = 200;          // per group
export const MAX_PENDING = 50;           // assignments waiting, per member
export const MAX_PLAN_BYTES = 64 * 1024;
export const KEEP_ANSWERED_DAYS = 90;
export const NAME_MAX = 60;
export const NOTE_MAX = 500;

export class GroupError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new GroupError(status, message); };

const list = v => (Array.isArray(v) ? v : []);
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isCoach = (user, isAdmin) => !!user && (user.coach === true || isAdmin(user));

export function cleanName(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!s) fail(400, 'a group needs a name');
  return s;
}

/** The one-routine plan bundle a coach sends, bounded; throws GroupError when it is not one. */
export function cleanPlan(plan) {
  if (!isMap(plan) || !plan.pocketgym_plan || !Array.isArray(plan.routines)) fail(400, 'plan must be a shared-plan bundle');
  if (plan.routines.length !== 1) fail(400, 'send one routine per assignment');
  const r = plan.routines[0];
  if (!isMap(r) || !Array.isArray(r.ex) || !r.ex.length || r.ex.length > 40) fail(400, 'the routine needs 1 to 40 exercises');
  let text;
  try { text = JSON.stringify(plan); } catch { fail(400, 'plan is not JSON'); }
  if (text.length > MAX_PLAN_BYTES) fail(413, 'plan too large');
  const out = JSON.parse(text);
  out.week = {};                                  // the schedule travels in weekly/dates instead
  return out;
}

export function cleanSchedule(body, today) {
  const weekly = [...new Set(list(body.weekly).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const dates = [...new Set(list(body.dates).filter(d => typeof d === 'string' && DAY_RE.test(d) && d >= today))].sort().slice(0, 31);
  return { weekly, dates };
}

export function newId(crypto) { return crypto.randomBytes(9).toString('base64url'); }

export const groupOf = (db, id) => list(db.groups).find(g => g.id === id) || null;
export const memberOf = (g, uid) => list(g?.members).find(m => m.uid === uid) || null;

/** The group, if `user` coaches it; else a 404 (never a 403: a group id says nothing to others). */
export function coachedGroup(db, id, user) {
  const g = groupOf(db, id);
  if (!g || g.coach !== user.id) fail(404, 'no such group');
  return g;
}

const nameOf = (db, uid) => list(db.users).find(u => u.id === uid)?.name || '?';

/** What the caller sees: the groups they coach (with members) and the ones they are in. */
export function groupsView(db, user, coach) {
  const coaching = list(db.groups).filter(g => g.coach === user.id).map(g => ({
    id: g.id, name: g.name, at: g.at,
    members: list(g.members).map(m => ({ uid: m.uid, name: nameOf(db, m.uid), status: m.status, at: m.at })),
  }));
  const memberOfList = list(db.groups).filter(g => memberOf(g, user.id)).map(g => ({
    id: g.id, name: g.name, coach: nameOf(db, g.coach), status: memberOf(g, user.id).status, at: memberOf(g, user.id).at,
  }));
  const pending = list(db.assignments).filter(a => a.to === user.id && a.status === 'pending').length;
  return { coach, coaching, memberOf: memberOfList, pending };
}

/** People a coach can add: every other enabled profile whose name has `q` in it, up to 20. */
export function findPeople(db, user, q, group) {
  const s = String(q || '').trim().toLowerCase();
  if (s.length < 2) return [];
  return list(db.users)
    .filter(u => u.id !== user.id && !u.disabled && String(u.name || '').toLowerCase().includes(s))
    .slice(0, 20)
    .map(u => ({ uid: u.id, name: u.name, status: memberOf(group, u.id)?.status || null }));
}

/** Everything about a user removed from every group: on delete, and nothing else. */
export function dropUser(db, uid) {
  db.groups = list(db.groups).filter(g => g.coach !== uid);
  for (const g of db.groups) g.members = list(g.members).filter(m => m.uid !== uid);
  db.assignments = list(db.assignments).filter(a => a.to !== uid && a.coach !== uid);
}

/** Assignments answered long ago go; so does anything of a group that is gone. */
export function pruneAssignments(db, now = Date.now()) {
  const live = new Set(list(db.groups).map(g => g.id));
  const cut = now - KEEP_ANSWERED_DAYS * 86400000;
  db.assignments = list(db.assignments).filter(a => live.has(a.group) && (a.status === 'pending' || (a.answered || a.at) >= cut));
}

/* ---------- what a coach sees of an active member ---------- */
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const defined = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const isWarm = isWarmupSet;

/**
 * A member's training, activity and body weight for their coach: the last twelve weeks of
 * workouts (each set's weight, reps and whether it was done), sessions per week, the plan they
 * follow, thirty days of activity and six months of weigh-ins. Built field by field like the
 * Coach's payload: no notes, photos, settings, passkeys or anything else of the profile.
 */
export function memberSummary(S, now = Date.now()) {
  S = isMap(S) ? S : {};
  const custom = new Map(list(S.customEx).filter(isMap).map(c => [c.id, String(c.n || '').slice(0, 80)]));
  const exName = id => libraryName(id) || custom.get(id) || String(id);
  const from = iso(now - 84 * DAY);
  const workouts = list(S.workouts).filter(w => isMap(w) && typeof w.d === 'string' && w.d >= from).slice(-60).map(w => {
    let vol = 0, sets = 0;
    const entries = list(w.entries).filter(isMap).map(en => ({
      id: String(en.id), name: exName(en.id),
      sets: list(en.sets).filter(isMap).map(s => {
        if (s.done && !isWarm(s)) { sets++; vol += (num(s.w) || 0) * (num(s.r) || 0); }
        return defined({ w: num(s.w), r: num(s.r), sec: num(s.sec), done: !!s.done, warmup: isWarm(s) || undefined });
      }),
    }));
    return defined({
      d: w.d.slice(0, 10), name: typeof w.name === 'string' ? w.name.slice(0, 80) : undefined,
      minutes: num(w.end) !== undefined && num(w.start) !== undefined && w.end > w.start ? Math.round((w.end - w.start) / 60000) : undefined,
      sets, vol: Math.round(vol), prs: list(w.prs).length || undefined, entries,
    });
  });
  const perWeek = [];
  for (let i = 7; i >= 0; i--) {
    const end = now - i * 7 * DAY, start = end - 7 * DAY;
    perWeek.push({ from: iso(start + DAY), n: workouts.filter(w => w.d > iso(start) && w.d <= iso(end)).length });
  }
  const routines = list(S.routines).filter(isMap).map(r => ({ id: String(r.id), name: String(r.name || '').slice(0, 80), coach: !!r.fromCoach }));
  const week = {};
  for (const [d, v] of Object.entries(isMap(S.week) ? S.week : {})) {
    const ids = [].concat(v).filter(x => typeof x === 'string');
    if (/^[0-6]$/.test(d) && ids.length) week[d] = ids;
  }
  const actFrom = iso(now - 30 * DAY);
  const activity = list(S.activity).filter(e => isMap(e) && typeof e.d === 'string' && e.d >= actFrom)
    .map(e => defined({ d: e.d, steps: num(e.steps), sleepMin: num(e.sleepMin), restHr: num(e.restHr), activeKcal: num(e.activeKcal), distM: num(e.distM) }));
  const cardio = list(S.sessions).filter(x => isMap(x) && typeof x.d === 'string' && x.d >= actFrom)
    .map(x => defined({ d: x.d, type: typeof x.type === 'string' ? x.type : 'other', durS: num(x.durS), distM: num(x.distM), avgHr: num(x.avgHr) }));
  const bwFrom = iso(now - 182 * DAY);
  const bodyweight = list(S.bodyweight).filter(b => isMap(b) && typeof b.d === 'string' && b.d >= bwFrom && num(b.w) !== undefined).map(b => ({ d: b.d, w: b.w }));
  return {
    unit: S.unit === 'lb' ? 'lb' : 'kg',
    lastWorkout: list(S.workouts).filter(w => isMap(w) && w.d).slice(-1)[0]?.d || null,
    perWeek, workouts, routines, week, activity, cardio, bodyweight,
    goalWeight: num(S.targetW) ?? null,
  };
}
