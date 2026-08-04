// Canal temps réel de Twitch (PubSub).
//
// Ce que ça apporte : un coffre de points ou un palier de drop est signalé à la
// seconde, au lieu d'être découvert au prochain passage de la boucle, jusqu'à
// une minute plus tard.
//
// Ce que ça n'est pas : une source de vérité. Tout continue de fonctionner sans
// lui. Les alarmes ne changent pas, les interrogations périodiques restent en
// place, et rien ici ne peut faire échouer le farm. C'est une accélération.
//
// Pourquoi un `setInterval` alors que le projet les interdit : la connexion doit
// recevoir quelque chose au moins toutes les 30 secondes, sinon Chrome recycle
// le service worker et la coupe. Une alarme ne descend pas sous la minute. Ce
// battement est donc lié à la vie de la socket, et disparaît avec elle.

import {
  EVENT,
  PING_FRAME,
  PUBSUB_URL,
  bareToken,
  listenFrame,
  parseFrame,
  userTopics,
} from "../lib/pubsub-messages.js";
import { getUsableHeaders } from "./header-capture.js";

/** Chrome recycle un service worker inactif au bout de 30 secondes. */
const KEEPALIVE_MS = 20_000;
/** Une socket refusée ne se retente pas en boucle. */
const RETRY_MS = 60_000;

// Ces variables meurent avec le service worker, exactement comme la socket
// qu'elles décrivent : les deux repartent ensemble au prochain réveil.
let socket = null;
let keepalive = null;
let lastAttempt = 0;
let lastError = null;

export function isConnected() {
  return socket?.readyState === WebSocket.OPEN;
}

export function lastFailure() {
  return lastError;
}

export function disconnect() {
  if (keepalive) clearInterval(keepalive);
  keepalive = null;
  try {
    socket?.close();
  } catch {
    /* déjà fermée */
  }
  socket = null;
}

/**
 * Ouvre la connexion si elle ne l'est pas, sans jamais jeter.
 *
 * @param {object} opts { userId, onEvent }
 * @returns {Promise<boolean>} connectée ou non
 */
export async function ensureConnected({ userId, onEvent }) {
  if (isConnected()) return true;
  if (socket) return false; // en cours d'ouverture

  const now = Date.now();
  if (now - lastAttempt < RETRY_MS) return false;
  lastAttempt = now;

  const topics = userTopics(userId);
  if (!topics.length) {
    lastError = "compte inconnu";
    return false;
  }

  const captured = await getUsableHeaders();
  const token = bareToken(captured?.authorization);
  if (!token) {
    lastError = "jeton indisponible, un onglet Twitch doit être ouvert";
    return false;
  }

  try {
    socket = new WebSocket(PUBSUB_URL);
  } catch (err) {
    lastError = err?.message ?? String(err);
    socket = null;
    return false;
  }

  socket.addEventListener("open", () => {
    lastError = null;
    envoyer(listenFrame(topics, token, `tdc-${now}`));
    // Le battement sert deux choses à la fois : tenir la connexion ouverte côté
    // Twitch, et tenir le service worker éveillé côté Chrome.
    keepalive = setInterval(() => envoyer(PING_FRAME), KEEPALIVE_MS);
  });

  socket.addEventListener("message", (ev) => {
    const evt = parseFrame(ev.data);

    if (evt.kind === EVENT.RESPONSE && evt.error) {
      lastError = evt.error;
      disconnect();
      return;
    }
    if (evt.kind === EVENT.RECONNECT) {
      disconnect();
      return;
    }
    if (evt.kind === EVENT.PONG || evt.kind === EVENT.UNKNOWN) return;

    // Un gestionnaire qui échoue ne doit pas emporter la socket avec lui.
    try {
      const res = onEvent?.(evt);
      if (res && typeof res.catch === "function") res.catch(noter);
    } catch (err) {
      noter(err);
    }
  });

  socket.addEventListener("close", () => {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    socket = null;
  });

  socket.addEventListener("error", () => {
    lastError = "connexion temps réel interrompue";
  });

  return true;
}

function envoyer(frame) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    /* socket partie entre-temps, le prochain passage rouvrira */
  }
}

function noter(err) {
  console.warn("[TDC] évènement temps réel non traité :", err?.message ?? err);
}
