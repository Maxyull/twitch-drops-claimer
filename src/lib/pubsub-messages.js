// Twitch's PubSub protocol: building the frames we send, understanding the ones
// that arrive.
//
// This is the real-time channel Twitch uses for itself, and the one
// TwitchDropsMiner and Twitch-Channel-Points-Miner-v2 rely on. It says a chest is
// available or a tier has landed within the second, where polling takes up to a
// minute.
//
// Pure module: no socket here, only objects. That is what makes the protocol
// testable without a network.

export const PUBSUB_URL = "wss://pubsub-edge.twitch.tv/v1";

/** Twitch closes a silent connection after five minutes. */
export const PING_FRAME = { type: "PING" };

export const EVENT = {
  PONG: "pong",
  RECONNECT: "reconnect",
  RESPONSE: "response",
  POINTS_AVAILABLE: "points-available",
  POINTS_EARNED: "points-earned",
  DROP_PROGRESS: "drop-progress",
  DROP_CLAIM: "drop-claim",
  RAID: "raid",
  UNKNOWN: "unknown",
};

/** The topics watched for a given account. */
export function userTopics(userId) {
  const id = String(userId ?? "").trim();
  if (!id) return [];
  return [`community-points-user-v1.${id}`, `user-drop-events.${id}`];
}

/**
 * Topics tied to the watched channels. A raid is announced nowhere else: there
 * is no reliable trace of it in the page, and its id, without which it cannot be
 * joined, comes only from here.
 */
export function channelTopics(channelIds) {
  const vus = new Set();
  for (const raw of channelIds || []) {
    const id = String(raw ?? "").trim();
    if (id) vus.add(`raid.${id}`);
  }
  return [...vus];
}

/**
 * Subscription frame.
 * `auth_token` is the session token reused from the Twitch page. It goes to
 * Twitch and nowhere else, and is never written to disk.
 */
export function listenFrame(topics, authToken, nonce) {
  return {
    type: "LISTEN",
    nonce: String(nonce ?? ""),
    data: { topics: [...topics], auth_token: String(authToken ?? "") },
  };
}

/** Unsubscribing from a channel we no longer watch. */
export function unlistenFrame(topics, nonce) {
  return { type: "UNLISTEN", nonce: String(nonce ?? ""), data: { topics: [...topics] } };
}

/**
 * What to send to go from the current subscription set to the wanted one.
 * No global unsubscribe/resubscribe: we only touch the differences, otherwise
 * every tab change would also cut the account-level topics.
 */
export function topicDelta(courants, voulus) {
  const a = new Set(courants || []);
  const b = new Set(voulus || []);
  return {
    listen: [...b].filter((t) => !a.has(t)),
    unlisten: [...a].filter((t) => !b.has(t)),
  };
}

/** "OAuth abc" | "abc" -> "abc". Returns "" when there is nothing usable. */
export function bareToken(authorization) {
  const raw = String(authorization ?? "").trim();
  if (!raw) return "";
  return raw.replace(/^(oauth|bearer)\s+/i, "");
}

function json(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Received frame -> usable event.
 * Never throws: an unknown or malformed frame becomes `UNKNOWN` and the loop
 * carries on. An acceleration channel must not be able to break the farm.
 */
export function parseFrame(raw) {
  const frame = json(raw);
  if (!frame || typeof frame !== "object") return { kind: EVENT.UNKNOWN };

  if (frame.type === "PONG") return { kind: EVENT.PONG };
  if (frame.type === "RECONNECT") return { kind: EVENT.RECONNECT };
  if (frame.type === "RESPONSE") {
    return { kind: EVENT.RESPONSE, nonce: frame.nonce ?? "", error: frame.error || null };
  }
  if (frame.type !== "MESSAGE") return { kind: EVENT.UNKNOWN };

  const topic = frame.data?.topic ?? "";
  const inner = json(frame.data?.message);
  if (!inner || typeof inner !== "object") return { kind: EVENT.UNKNOWN };
  const data = inner.data ?? {};

  if (topic.startsWith("community-points-user-v1")) {
    if (inner.type === "claim-available") {
      const claim = data.claim ?? {};
      if (!claim.id) return { kind: EVENT.UNKNOWN };
      return {
        kind: EVENT.POINTS_AVAILABLE,
        claimId: String(claim.id),
        channelId: claim.channel_id ? String(claim.channel_id) : null,
      };
    }
    if (inner.type === "points-earned") {
      return {
        kind: EVENT.POINTS_EARNED,
        channelId: data.channel_id ? String(data.channel_id) : null,
        balance: Number(data.balance?.balance) || 0,
        gained: Number(data.point_gain?.total_points) || 0,
        // `WATCH_STREAK`, `CLAIM`, `WATCH`... this is what says where the gain
        // came from.
        reason: data.point_gain?.reason_code ?? "",
      };
    }
    return { kind: EVENT.UNKNOWN };
  }

  if (topic.startsWith("user-drop-events")) {
    if (inner.type === "drop-progress") {
      if (!data.drop_id) return { kind: EVENT.UNKNOWN };
      return {
        kind: EVENT.DROP_PROGRESS,
        dropID: String(data.drop_id),
        watchedMinutes: Number(data.current_progress_min) || 0,
        requiredMinutes: Number(data.required_progress_min) || 0,
      };
    }
    if (inner.type === "drop-claim") {
      if (!data.drop_instance_id) return { kind: EVENT.UNKNOWN };
      return {
        kind: EVENT.DROP_CLAIM,
        dropID: data.drop_id ? String(data.drop_id) : null,
        dropInstanceID: String(data.drop_instance_id),
      };
    }
    return { kind: EVENT.UNKNOWN };
  }

  if (topic.startsWith("raid.")) {
    // `raid_update_v2` is the only shape that carries the raid id.
    if (inner.type !== "raid_update_v2") return { kind: EVENT.UNKNOWN };
    const raid = inner.raid ?? data.raid ?? {};
    if (!raid.id) return { kind: EVENT.UNKNOWN };
    return {
      kind: EVENT.RAID,
      raidID: String(raid.id),
      sourceChannelId: topic.slice("raid.".length),
      targetLogin: String(raid.target_login ?? "").toLowerCase() || null,
    };
  }

  return { kind: EVENT.UNKNOWN };
}
