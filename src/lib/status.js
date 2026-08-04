// Green / red indicator: is the background tab REALLY watching?
// Pure module: the verdict rests only on the heartbeats the player sends.
// No labels here, codes only: the views translate them through the `status_*`
// keys in _locales.

export const BEAT_TIMEOUT_MS = 25_000;

export const STATUS = {
  OK: "ok",
  ADS: "ads",
  STALLED: "stalled",
  BLOCKED: "blocked", // autoplay refused by the browser
  PAUSED: "paused",
  OFFLINE: "offline",
  NO_BEAT: "no_beat",
  NO_TAB: "no_tab",
  WRONG_CHANNEL: "wrong_channel",
  DISABLED: "disabled",
};

/** A green status accrues watch time, a red one does not. */
export function isGreen(code) {
  return code === STATUS.OK || code === STATUS.ADS;
}

/**
 * @param {object|null} beat        the last heartbeat received
 * @param {object|null} prevBeat    the previous one (to spot a frozen stream)
 * @param {object} ctx  { now, expectedChannel, tabExists, enabled }
 * @returns {{code:string, green:boolean, channel:string|null, age:number|null}}
 */
export function evaluateBeat(beat, prevBeat, ctx = {}) {
  const { now = Date.now(), expectedChannel = null, tabExists = true, enabled = true } = ctx;

  const build = (code, channel = beat?.channel ?? null, age = null) => ({
    code,
    green: isGreen(code),
    channel,
    age,
  });

  if (!enabled) return build(STATUS.DISABLED, null);
  if (!tabExists) return build(STATUS.NO_TAB, null);
  if (!beat) return build(STATUS.NO_BEAT, null);

  const age = now - (beat.at ?? 0);
  if (age > BEAT_TIMEOUT_MS) return build(STATUS.NO_BEAT, beat.channel ?? null, age);

  if (expectedChannel && beat.channel && beat.channel !== expectedChannel) {
    return build(STATUS.WRONG_CHANNEL, beat.channel, age);
  }

  if (beat.offline) return build(STATUS.OFFLINE, beat.channel, age);
  // Blocked outranks paused: the user sees the same thing, but the cause and the
  // remedy are not the same.
  if (beat.blocked) return build(STATUS.BLOCKED, beat.channel, age);
  if (beat.ads) return build(STATUS.ADS, beat.channel, age);
  if (beat.paused) return build(STATUS.PAUSED, beat.channel, age);

  // The player claims to be playing: check the video clock really moves between
  // two heartbeats, otherwise the stream is frozen.
  if (prevBeat && prevBeat.at !== beat.at && typeof beat.currentTime === "number") {
    if (beat.currentTime <= (prevBeat.currentTime ?? -1)) return build(STATUS.STALLED, beat.channel, age);
  }

  return build(STATUS.OK, beat.channel, age);
}

/** Summary for the toolbar badge. */
export function summarize(states = []) {
  const active = states.filter((s) => s && s.code !== STATUS.DISABLED);
  if (!active.length) return { green: false, code: STATUS.DISABLED };
  const bad = active.find((s) => !s.green);
  return bad ? { ...bad } : { ...active[0], code: STATUS.OK, green: true };
}
