// Twitch's real-time channel (PubSub).
//
// What it buys: a points chest or a drop tier is reported within the second,
// instead of being discovered on the loop's next pass, up to a minute later.
//
// What it is not: a source of truth. Everything keeps working without it. The
// alarms do not change, the periodic queries stay in place, and nothing here can
// make farming fail. It is an acceleration.
//
// Why a `setInterval` when the project forbids them: the connection has to
// receive something at least every 30 seconds, otherwise Chrome recycles the
// service worker and cuts it. An alarm cannot go below one minute. This heartbeat
// is therefore tied to the socket's lifetime, and disappears with it.
//
// The French identifiers below (`abonnes`, `jeton`, `envoyer`, `noter`) are kept
// on purpose: renaming them is churn with regression risk, and #72 settled that.

import {
  EVENT,
  PING_FRAME,
  PUBSUB_URL,
  bareToken,
  channelTopics,
  listenFrame,
  parseFrame,
  topicDelta,
  unlistenFrame,
  userTopics,
} from "../lib/pubsub-messages.js";
import { getUsableHeaders } from "./header-capture.js";

/** Chrome recycles an idle service worker after 30 seconds. */
const KEEPALIVE_MS = 20_000;
/** A refused socket is not retried in a loop. */
const RETRY_MS = 60_000;

// These variables die with the service worker, exactly like the socket they
// describe: the two start again together on the next wake-up.
let socket = null;
let keepalive = null;
let lastAttempt = 0;
let lastError = null;
let nonce = 0;
/** Topics actually requested from Twitch on the current connection. */
let abonnes = [];
/** The token is also needed for subscriptions added along the way. */
let jeton = "";

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
    /* already closed */
  }
  socket = null;
  abonnes = [];
  jeton = "";
}

/** Wanted topics: the account's, plus one raid topic per watched channel. */
function wantedTopics(userId, channelIds) {
  const compte = userTopics(userId);
  if (!compte.length) return [];
  return [...compte, ...channelTopics(channelIds)];
}

/**
 * Brings the subscriptions in line with the channels currently being watched.
 *
 * Only the differences are sent. Unsubscribing from everything to resubscribe
 * would lose chests and tiers on every tab rotation, when all that moved was the
 * list of channels.
 */
function syncTopics(voulus) {
  const { listen, unlisten } = topicDelta(abonnes, voulus);
  if (unlisten.length) envoyer(unlistenFrame(unlisten, `tdc-u${++nonce}`));
  if (listen.length) envoyer(listenFrame(listen, jeton, `tdc-l${++nonce}`));
  if (listen.length || unlisten.length) abonnes = [...voulus];
}

/**
 * Opens the connection if it is not already open, and never throws.
 *
 * @param {object} opts { userId, onEvent }
 * @returns {Promise<boolean>} connected or not
 */
export async function ensureConnected({ userId, channelIds = [], onEvent }) {
  const topics = wantedTopics(userId, channelIds);

  if (isConnected()) {
    // Connection already there: only the list of watched channels can have moved.
    if (topics.length) syncTopics(topics);
    return true;
  }
  if (socket) return false; // currently opening

  const now = Date.now();
  if (now - lastAttempt < RETRY_MS) return false;
  lastAttempt = now;

  if (!topics.length) {
    lastError = "unknown account";
    return false;
  }

  const captured = await getUsableHeaders();
  const token = bareToken(captured?.authorization);
  if (!token) {
    lastError = "no token available, a Twitch tab must be open";
    return false;
  }
  jeton = token;

  try {
    socket = new WebSocket(PUBSUB_URL);
  } catch (err) {
    lastError = err?.message ?? String(err);
    socket = null;
    return false;
  }

  socket.addEventListener("open", () => {
    lastError = null;
    envoyer(listenFrame(topics, token, `tdc-l${++nonce}`));
    abonnes = [...topics];
    // The heartbeat does two jobs at once: keeping the connection open on the
    // Twitch side, and keeping the service worker awake on the Chrome side.
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

    // A handler that fails must not take the socket down with it.
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
    abonnes = [];
  });

  socket.addEventListener("error", () => {
    lastError = "real-time connection interrupted";
  });

  return true;
}

function envoyer(frame) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    /* socket gone in the meantime, the next pass will reopen it */
  }
}

function noter(err) {
  console.warn("[TDC] unhandled real-time event:", err?.message ?? err);
}
