// Protocole PubSub de Twitch : construire les trames à envoyer, comprendre
// celles qui arrivent.
//
// C'est le canal temps réel que le site de Twitch utilise pour lui-même, et
// dont se servent TwitchDropsMiner et Twitch-Channel-Points-Miner-v2. Il dit
// qu'un coffre est disponible ou qu'un palier vient de tomber à la seconde,
// là où l'interrogation périodique met jusqu'à une minute.
//
// Module pur : aucune socket ici, seulement des objets. C'est ce qui rend le
// protocole testable sans réseau.

export const PUBSUB_URL = "wss://pubsub-edge.twitch.tv/v1";

/** Twitch ferme une connexion silencieuse au bout de cinq minutes. */
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

/** Les sujets écoutés pour un compte donné. */
export function userTopics(userId) {
  const id = String(userId ?? "").trim();
  if (!id) return [];
  return [`community-points-user-v1.${id}`, `user-drop-events.${id}`];
}

/**
 * Sujets liés aux chaînes regardées. Un raid n'est annoncé que là : il n'existe
 * aucune trace fiable dans la page, et l'identifiant du raid, sans lequel on ne
 * peut pas le rejoindre, ne vient que d'ici.
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
 * Trame d'abonnement.
 * `auth_token` est le jeton de session repris sur la page Twitch. Il part vers
 * Twitch et nulle part ailleurs, et n'est jamais écrit sur le disque.
 */
export function listenFrame(topics, authToken, nonce) {
  return {
    type: "LISTEN",
    nonce: String(nonce ?? ""),
    data: { topics: [...topics], auth_token: String(authToken ?? "") },
  };
}

/** Se désabonner d'une chaîne qu'on ne regarde plus. */
export function unlistenFrame(topics, nonce) {
  return { type: "UNLISTEN", nonce: String(nonce ?? ""), data: { topics: [...topics] } };
}

/**
 * Ce qu'il faut envoyer pour passer de l'abonnement courant au voulu.
 * Pas de désabonnement/réabonnement global : on ne touche qu'aux différences,
 * sinon chaque changement d'onglet couperait aussi les sujets du compte.
 */
export function topicDelta(courants, voulus) {
  const a = new Set(courants || []);
  const b = new Set(voulus || []);
  return {
    listen: [...b].filter((t) => !a.has(t)),
    unlisten: [...a].filter((t) => !b.has(t)),
  };
}

/** "OAuth abc" | "abc" -> "abc". Renvoie "" si rien d'exploitable. */
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
 * Trame reçue -> évènement exploitable.
 * Ne jette jamais : une trame inconnue ou malformée devient `UNKNOWN`, et la
 * boucle continue. Un canal d'accélération ne doit pas pouvoir casser le farm.
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
        // `WATCH_STREAK`, `CLAIM`, `WATCH`... c'est ce qui dit d'où vient le gain.
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
    // `raid_update_v2` est la seule forme qui porte l'identifiant du raid.
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
