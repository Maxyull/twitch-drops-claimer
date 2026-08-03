// Notifications système. Les boutons de notification servent de raccourci ;
// la vraie liste à cocher vit dans le popup.

import { ACTION_KIND } from "../lib/actions.js";

const ICON = "assets/icons/icon128.png";
const t = (key, subs) => chrome.i18n.getMessage(key, subs);

// notificationId -> { actionId, url }
const routes = new Map();

function create(id, options, route) {
  if (route) routes.set(id, route);
  return new Promise((resolve) => {
    chrome.notifications.create(id, { iconUrl: ICON, type: "basic", ...options }, resolve);
  });
}

export function notifyDropClaimed({ dropName, campaignName, game }) {
  return create(`drop:${Date.now()}`, {
    title: t("notif_drop_title"),
    message: `${dropName || t("notif_drop_fallback")}, ${campaignName || game || "Twitch"}`,
  });
}

export function notifyPointsClaimed(channel) {
  return create(`points:${Date.now()}`, {
    title: t("notif_points_title"),
    message: channel ? t("notif_points_body", [channel]) : "",
  });
}

/** Drop qui demande d'aller lier ou récupérer sur un site externe. */
export function notifyActionRequired(action) {
  const isLink = action.kind === ACTION_KIND.LINK;
  return create(
    `action:${action.id}`,
    {
      title: isLink ? t("notif_link_title") : t("notif_redeem_title"),
      message: `${action.campaignName || action.game || ""}\n${
        isLink ? t("notif_link_body") : t("notif_redeem_body")
      }`.trim(),
      buttons: [{ title: t("notif_btn_open") }, { title: t("notif_btn_done") }],
      requireInteraction: true,
    },
    { actionId: action.id, url: action.url },
  );
}

export function notifyProblem(message) {
  return create(`problem:${Date.now()}`, {
    title: t("notif_problem_title"),
    message: String(message).slice(0, 300),
  });
}

/**
 * Branche les clics de notification.
 * @param {(actionId:string)=>Promise<void>} onDone  appelé sur « C'est fait »
 */
export function registerNotificationHandlers(onDone) {
  chrome.notifications.onButtonClicked.addListener(async (id, index) => {
    const route = routes.get(id);
    if (!route) return;
    if (index === 0 && route.url) await chrome.tabs.create({ url: route.url, active: true });
    else if (index === 1) await onDone(route.actionId);
    chrome.notifications.clear(id);
    routes.delete(id);
  });

  chrome.notifications.onClicked.addListener(async (id) => {
    const route = routes.get(id);
    if (route?.url) await chrome.tabs.create({ url: route.url, active: true });
    chrome.notifications.clear(id);
    routes.delete(id);
  });

  chrome.notifications.onClosed.addListener((id) => routes.delete(id));
}
