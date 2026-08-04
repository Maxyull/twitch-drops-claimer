// Orchestrateur : quelles campagnes farmer, quelle chaîne regarder, quels onglets ouvrir.

import {
  parseCampaign,
  rankCampaigns,
  pickChannel,
  isCategoryWide,
  campaignProgress,
  isActive,
  mergeProgress,
  applyLiveSession,
} from "../lib/campaigns.js";
import { buildPendingActions, linkedOverrides, pruneActions } from "../lib/actions.js";
import { mergeClaimed, trimRemembered } from "../lib/claimed-drops.js";
import { HISTORY_KIND, addEntries, makeEntry } from "../lib/history.js";
import { progressAdvanced } from "../lib/counted.js";
import { rankForStreak, streakReachable } from "../lib/streak.js";
import { mapLimited } from "../lib/concurrency.js";
import * as gql from "./gql.js";
import * as store from "../lib/storage.js";

const TWITCH_TABS = "https://www.twitch.tv/*";
/**
 * Marqueur des onglets ouverts par l'extension. Un fragment d'URL n'est jamais
 * envoyé au serveur, Twitch l'ignore, et surtout il survit au rechargement de
 * l'extension : c'est le seul indice qui reste quand `storage.session` est vidé.
 */
export const TAB_MARK = "#tdc";

const INVENTORY_URL = `https://www.twitch.tv/drops/inventory${TAB_MARK}`;
const DETAILS_TTL_MS = 6 * 60 * 60 * 1000;
/** Requêtes de détail en vol simultanément. Assez pour être rapide, pas assez pour agacer Twitch. */
const DETAILS_CONCURRENCY = 6;
/** Garde-fou : un compte ne voit jamais autant de campagnes, mais on ne boucle pas à l'infini. */
const MAX_DETAILS = 200;

// --- onglets --------------------------------------------------------------

async function normalWindows() {
  // On filtre en JS plutôt que par `windowTypes`, déprécié dans getAll().
  return (await chrome.windows.getAll()).filter((w) => w.type === "normal");
}

/**
 * Fenêtre qui porte déjà des onglets marqués par l'extension.
 * C'est le seul moyen de la retrouver après un rechargement, `state.windowId`
 * étant perdu avec `storage.session`.
 */
async function findOwnWindow() {
  try {
    const tabs = await chrome.tabs.query({ url: TWITCH_TABS });
    return tabs.find((tab) => (tab.url ?? "").includes(TAB_MARK))?.windowId ?? null;
  } catch {
    return null;
  }
}

/** Combien d'onglets portent encore notre marqueur, et où. */
async function countMarkedTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: TWITCH_TABS });
    const marques = tabs.filter((tab) => (tab.url ?? "").includes(TAB_MARK));
    return { total: tabs.length, marques: marques.length, fenetres: [...new Set(marques.map((t) => t.windowId))] };
  } catch {
    return { total: -1, marques: -1, fenetres: [] };
  }
}

/**
 * Garde-fou contre l'emballement : une condition mal évaluée ne doit pas
 * pouvoir produire une fenêtre par cycle. Passé ce délai sans succès, on
 * préfère réutiliser une fenêtre existante et le dire.
 */
const WINDOW_COOLDOWN_MS = 5 * 60_000;

/**
 * Toute création de fenêtre laisse une trace lisible après coup.
 *
 * Cinq signalements de « fenêtre en trop » ont donné cinq causes différentes,
 * chacune corrigée à l'aveugle. Sans savoir POURQUOI l'extension a jugé qu'elle
 * n'en avait pas, on ne fait que boucher des chemins.
 *
 * À lire dans la console du service worker :
 *   chrome.storage.local.get("windowLog").then(console.log)
 */
const WINDOW_LOG_MAX = 20;

async function traceWindow(entry) {
  const { windowLog = [] } = await chrome.storage.local.get("windowLog");
  const ligne = { at: Date.now(), ...entry };
  console.warn("[TDC] fenêtre :", ligne);
  await chrome.storage.local.set({
    windowLog: [ligne, ...(Array.isArray(windowLog) ? windowLog : [])].slice(0, WINDOW_LOG_MAX),
  });
  return ligne;
}

async function createDedicatedWindow(windows, contexte = {}) {
  const state = await store.getState();

  if (Date.now() - (state.windowCreatedAt ?? 0) < WINDOW_COOLDOWN_MS) {
    // On vient d'en créer une et on n'arrive pas à la retrouver : quelque chose
    // ne tourne pas rond, en ouvrir une de plus ne réglerait rien.
    await traceWindow({ action: "refusee-delai", ...contexte });
    await store.setLastError("Fenêtre dédiée introuvable, réutilisation d'une fenêtre existante.");
    return windows.at(-1)?.id ?? null;
  }

  // Créer puis réduire, en deux temps : `state` et `focused` se recouvrent dans
  // le même appel et Chrome ne garantit pas le résultat.
  const created = await chrome.windows.create({ focused: false });
  try {
    await chrome.windows.update(created.id, { state: "minimized" });
  } catch {
    /* pas réduite, tant pis, elle reste en arrière-plan */
  }

  await store.setState({ windowId: created.id, windowCreatedAt: Date.now() });
  await traceWindow({ action: "creee", windowId: created.id, ...contexte });
  return created.id;
}

async function targetWindowId(settings, appelant = "?") {
  const windows = await normalWindows();
  const existe = (id) => id != null && windows.some((w) => w.id === id);

  if (settings?.dedicatedWindow) {
    const state = await store.getState();
    if (existe(state.windowId)) return state.windowId;

    // Avant d'en créer une : l'extension en avait peut-être déjà une, dont elle
    // a perdu la trace au rechargement. Ses onglets marqués la trahissent.
    const retrouvee = await findOwnWindow();
    if (existe(retrouvee)) {
      await store.setState({ windowId: retrouvee });
      return retrouvee;
    }

    // Le contexte dit pourquoi on a conclu qu'il n'y avait pas de fenêtre :
    // c'est cette information qui manquait aux cinq corrections précédentes.
    return createDedicatedWindow(windows, {
      appelant,
      fenetresNormales: windows.length,
      windowIdMemorise: state.windowId ?? null,
      windowIdVivant: existe(state.windowId),
      fenetreRetrouveeParMarqueur: retrouvee ?? null,
      ongletsMarques: await countMarkedTabs(),
    });
  }

  // Hors mode dédié, `windows[0]` est la première de la liste de Chrome, pas
  // celle où l'utilisateur travaille. Avec une seule fenêtre ça ne se voyait
  // pas ; avec plusieurs, les onglets atterrissaient n'importe où.
  try {
    const derniere = await chrome.windows.getLastFocused();
    if (derniere?.type === "normal") return derniere.id;
  } catch {
    /* aucune fenêtre active, on retombe plus bas */
  }

  if (windows.length) return windows.at(-1).id;
  return createDedicatedWindow(windows);
}

/**
 * Sourdine au niveau de l'onglet, en plus de celle posée sur le lecteur par le
 * script de contenu. Ceinture et bretelles volontaires : si le script de contenu
 * ne se charge pas, Twitch démarre au volume enregistré par l'utilisateur et
 * l'onglet se met à parler tout seul.
 * Muter un onglet ne demande pas la permission "tabs", seule la lecture de son
 * URL la demanderait.
 */
async function applyTabMute(tabId, settings) {
  try {
    await chrome.tabs.update(tabId, { muted: Boolean(settings?.muteTabs) });
  } catch {
    /* pas de sourdine possible : le script de contenu coupe déjà le lecteur */
  }
}

async function openBackgroundTab(url, { pinned = true } = {}) {
  const settings = await store.getSettings();
  const windowId = await targetWindowId(settings, "ouverture-onglet");
  const tab = await chrome.tabs.create({ url, active: false, pinned, windowId });
  try {
    // Empêche Chrome de mettre l'onglet en veille : un onglet déchargé ne regarde plus rien.
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    /* option indisponible selon la version, sans conséquence */
  }
  await applyTabMute(tab.id, settings);
  return tab.id;
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function closeTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* déjà fermé */
  }
}

/** Tous les onglets dont l'extension a la trace. */
async function ownTabIds(state) {
  return new Set(
    [
      state.pointsTabId,
      state.inventoryTabId,
      ...(state.dropTabs ?? []).map((entry) => entry.tabId),
    ].filter(Boolean),
  );
}

/**
 * Ferme les onglets marqués par l'extension dont elle n'a plus la trace.
 *
 * `storage.session` est vidé à chaque rechargement de l'extension : sans ce
 * ménage, elle rouvre des onglets pendant que les précédents tournent encore, et
 * une fenêtre réduite de plus apparaît à chaque fois. Les scripts de contenu
 * déjà injectés étant invalidés par le rechargement, on ne peut pas attendre
 * qu'ils se signalent : il faut aller les chercher.
 *
 * Le filtre par URL de `tabs.query` ne demande pas la permission `tabs`, la
 * permission d'hôte sur `www.twitch.tv` suffit.
 */
export async function closeOrphanTabs() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: TWITCH_TABS });
  } catch {
    return 0;
  }

  const state = await store.getState();
  const miens = await ownTabIds(state);
  const orphelins = tabs.filter((tab) => (tab.url ?? "").includes(TAB_MARK) && !miens.has(tab.id));
  if (!orphelins.length) return 0;

  // On reprend la fenêtre avant de vider ses onglets : une fois qu'ils sont
  // fermés, plus rien ne permet de la reconnaître, et on en ouvrirait une
  // seconde juste à côté de celles de l'utilisateur.
  if (!state.windowId) await store.setState({ windowId: orphelins[0].windowId });

  for (const tab of orphelins) await closeTab(tab.id);
  // La fenêtre qui les portait se ferme d'elle-même avec son dernier onglet.
  return orphelins.length;
}

/** Reste-t-il au moins un onglet de farm vivant ? */
async function anyDropTabAlive(state) {
  for (const entry of state.dropTabs ?? []) {
    if (await tabExists(entry.tabId)) return true;
  }
  return false;
}

/**
 * Ouvre ou recycle un onglet d'arrière-plan pointant sur une chaîne.
 * On mémorise la chaîne demandée plutôt que de relire l'adresse de l'onglet :
 * ça évite la permission "tabs" (cf. docs/SECURITY-AUDIT.md).
 */
/**
 * Onglet marqué déjà ouvert sur cette chaîne. Après un rechargement de
 * l'extension, `storage.session` est vide et elle rouvrirait ce qui existe
 * déjà, chaque ouverture pouvant entraîner une fenêtre avec elle.
 */
/** N'importe quel onglet Twitch, marqué ou non : le script de contenu y tourne. */
async function anyTwitchTab() {
  try {
    return (await chrome.tabs.query({ url: TWITCH_TABS }))[0] ?? null;
  } catch {
    return null;
  }
}

async function findMarkedTab(channel) {
  const prefixe = `https://www.twitch.tv/${channel}`;
  try {
    const tabs = await chrome.tabs.query({ url: TWITCH_TABS });
    return (
      tabs.find((tab) => {
        const url = tab.url ?? "";
        return url.includes(TAB_MARK) && url.startsWith(prefixe);
      }) ?? null
    );
  } catch {
    return null;
  }
}

async function ensureChannelTab(tabId, channel) {
  const url = `https://www.twitch.tv/${channel}${TAB_MARK}`;
  const state = await store.getState();

  if (await tabExists(tabId)) {
    if (state.tabChannels[tabId] !== channel) {
      await chrome.tabs.update(tabId, { url });
      await applyTabMute(tabId, await store.getSettings());
      await store.setState({ tabChannels: { ...state.tabChannels, [tabId]: channel } });
    }
    return tabId;
  }

  // On reprend un onglet déjà en place plutôt que d'en ouvrir un doublon.
  const dejaLa = await findMarkedTab(channel);
  const id = dejaLa?.id ?? (await openBackgroundTab(url));
  if (dejaLa) await applyTabMute(id, await store.getSettings());

  await store.setState({ tabChannels: { ...state.tabChannels, [id]: channel } });
  return id;
}

// --- campagnes ------------------------------------------------------------

async function getLogin() {
  const { twitchLogin } = await chrome.storage.local.get("twitchLogin");
  if (twitchLogin) return twitchLogin;
  const user = await gql.currentUser();
  if (!user?.login) throw new gql.GqlError("Compte Twitch introuvable.", { kind: "auth" });
  await chrome.storage.local.set({ twitchLogin: user.login, twitchUserId: user.id ?? null });
  return user.login;
}

/**
 * Identifiant numérique du compte, exigé par les sujets du canal temps réel.
 * Renvoie `null` plutôt que de jeter : sans lui on n'ouvre simplement pas la
 * connexion, et rien d'autre ne change.
 */
export async function getUserId() {
  const { twitchUserId } = await chrome.storage.local.get("twitchUserId");
  if (twitchUserId) return twitchUserId;
  try {
    const user = await gql.currentUser();
    if (!user?.id) return null;
    await chrome.storage.local.set({ twitchUserId: user.id });
    return user.id;
  } catch {
    return null;
  }
}

/**
 * Recharge la liste des campagnes, en entier et en un seul passage.
 *
 * L'inventaire donne la progression exacte des campagnes entamées. La liste
 * générale donne toutes les autres, dont il faut aller chercher le détail
 * (paliers et chaînes autorisées) une par une : ce sont ces requêtes qu'on
 * parallélise, sinon la liste se remplirait sur plusieurs cycles.
 */
/**
 * La structure d'une campagne ne bouge pas : noms des paliers, minutes requises,
 * chaînes autorisées. Sa progression, si. Servir `isClaimed` depuis un cache de
 * six heures rendait invisible tout drop réclamé entre-temps, et le compteur
 * restait à zéro. Le cache garde donc la structure, jamais l'avancement.
 */
function forgetProgress(drops) {
  return (drops || []).map((d) => ({
    ...d,
    watchedMinutes: 0,
    isClaimed: false,
    dropInstanceID: null,
  }));
}

/** Campagnes entamées, avec leur progression réelle. Une seule requête. */
export async function inventoryCampaigns() {
  return (await gql.inventory()).map(parseCampaign).filter(Boolean);
}

export async function refreshCampaigns() {
  const now = Date.now();
  const byId = new Map();

  for (const campaign of await inventoryCampaigns()) byId.set(campaign.id, campaign);

  const cache = await store.getDetailsCache();
  const aChercher = [];

  for (const node of await gql.campaignList()) {
    const shallow = parseCampaign(node);
    if (!shallow || byId.has(shallow.id)) continue;
    if (!isActive(shallow, now)) continue;

    const cached = cache[shallow.id];
    if (cached && now - cached.at < DETAILS_TTL_MS) {
      byId.set(shallow.id, {
        ...shallow,
        drops: forgetProgress(cached.campaign.drops),
        channels: cached.campaign.channels,
      });
      continue;
    }
    aChercher.push(shallow);
  }

  if (aChercher.length) {
    const restants = aChercher.slice(0, MAX_DETAILS);
    const login = await getLogin();

    const details = await mapLimited(restants, DETAILS_CONCURRENCY, async (shallow) =>
      parseCampaign(await gql.campaignDetails(login, shallow.id)),
    );

    restants.forEach((shallow, i) => {
      const detail = details[i];
      if (detail) {
        byId.set(detail.id, detail);
        // On ne met en cache que la structure : stocker un avancement qu'on
        // s'interdit de relire ne ferait qu'occuper du quota.
        cache[detail.id] = { at: now, campaign: { ...detail, drops: forgetProgress(detail.drops) } };
      } else {
        // Détail indisponible : la campagne reste visible, sans ses paliers.
        byId.set(shallow.id, shallow);
      }
    });

    for (const shallow of aChercher.slice(MAX_DETAILS)) byId.set(shallow.id, shallow);
  }

  for (const [id, entry] of Object.entries(cache)) {
    if (now - entry.at > DETAILS_TTL_MS * 4) delete cache[id];
  }
  await store.setDetailsCache(cache);

  const campaigns = [...byId.values()];
  await store.setCampaigns(campaigns);
  return campaigns;
}

/**
 * Compte les drops réellement obtenus, d'après l'inventaire et non d'après nos
 * clics : Twitch peut créditer un palier sans nous, et un clic peut échouer.
 */
export async function syncClaimedDrops(campaigns) {
  const { ids, seeded } = await store.getClaimedDrops();
  const merged = mergeClaimed(ids, seeded, campaigns);
  await store.setClaimedDrops(trimRemembered(merged.ids));

  if (!merged.added.length) return 0;

  // On retrouve le nom du palier et de sa campagne : un journal qui ne dirait
  // que « un drop » ne vaudrait pas mieux qu'un compteur.
  const nouveaux = new Set(merged.added);
  const entrees = [];
  for (const campaign of campaigns ?? []) {
    for (const drop of campaign?.drops ?? []) {
      if (!nouveaux.has(drop.id)) continue;
      entrees.push(
        makeEntry({
          kind: HISTORY_KIND.DROP,
          id: drop.id,
          label: drop.name || drop.benefits?.[0]?.name || "",
          campaign: campaign.name || campaign.gameName || "",
        }),
      );
    }
  }

  await store.setHistory(addEntries(await store.getHistory(), entrees));
  await store.bumpStat("drops", entrees[0]?.label ?? "", merged.added.length);
  return merged.added.length;
}

/**
 * Preuve de comptage par la progression : les minutes accumulées sur la campagne
 * suivie et le solde de points de la chaîne favorite. C'est le signal le plus
 * lent à venir, et le seul qui ne puisse pas se tromper.
 */
const PROOF_TTL_MS = 5 * 60_000;

export async function refreshWatchProof() {
  const state = await store.getState();
  const now = Date.now();
  if (now - (state.proofCheckedAt ?? 0) < PROOF_TTL_MS) return state;

  const marks = { ...(state.marks ?? {}) };
  const proof = { ...(state.proof ?? {}) };

  // Une seule requête pour toutes les campagnes farmées : la preuve vaut par
  // onglet, mais l'inventaire les porte toutes.
  if ((state.dropTabs ?? []).length) {
    try {
      const inventaire = await inventoryCampaigns();
      const minutes = { ...(marks.dropsMinutes ?? {}) };

      for (const entry of state.dropTabs) {
        const current = inventaire.find((c) => c.id === entry.campaignId);
        if (!current) continue;
        const watched = campaignProgress(current).watched;
        if (progressAdvanced(minutes[entry.campaignId], watched)) {
          proof.dropsAt = { ...(proof.dropsAt ?? {}), [entry.campaignId]: now };
        }
        minutes[entry.campaignId] = watched;
      }
      marks.dropsMinutes = minutes;

      // La même réponse sert à faire avancer ce que le popup affiche. Sans ça,
      // la barre de progression restait sur les minutes de la dernière
      // découverte, vieilles d'une demi-heure. Voir #49.
      const { campaigns } = await store.getCampaigns();
      const fusion = mergeProgress(campaigns, inventaire);
      if (fusion.changed) await store.setCampaigns(fusion.campaigns, { touchDate: false });
    } catch {
      /* API muette : on retentera au prochain passage */
    }
  }

  const balance = state.pointsBalance;
  if (balance?.channel) {
    const memeChaine = marks.pointsChannel === balance.channel;
    if (memeChaine && progressAdvanced(marks.pointsBalance, balance.balance)) proof.pointsAt = now;
    marks.pointsChannel = balance.channel;
    marks.pointsBalance = balance.balance;
  }

  return store.setState({ proofCheckedAt: now, marks, proof });
}

/**
 * Progression annoncée par le canal temps réel, pour un palier précis.
 *
 * Même écriture que la progression interrogée, mais sans attendre le prochain
 * passage : c'est la seule différence. Les mêmes garde-fous s'appliquent, dont
 * celui qui interdit à un compteur de reculer.
 */
export async function applyRealtimeDrop({ dropID, watchedMinutes }) {
  const { campaigns } = await store.getCampaigns();
  const res = applyLiveSession(campaigns, { dropID, watchedMinutes });
  if (!res.changed) return null;

  await store.setCampaigns(res.campaigns, { touchDate: false });

  // Une minute qui monte est la preuve que Twitch comptabilise ce visionnage.
  const campagne = res.campaigns.find((c) => (c.drops || []).some((d) => d.id === dropID));
  if (!campagne) return res;

  const state = await store.getState();
  await store.setState({
    proof: { ...(state.proof ?? {}), dropsAt: { ...(state.proof?.dropsAt ?? {}), [campagne.id]: Date.now() } },
  });
  return res;
}

/**
 * Identifiants numériques des chaînes actuellement regardées, retenus une fois
 * pour toutes. Ils servent à deux choses : la progression en direct, et
 * l'abonnement aux raids, qui ne s'annoncent que par identifiant de chaîne.
 *
 * Ne jette jamais : sans identifiant, on perd une accélération, pas le farm.
 */
export async function refreshChannelIds() {
  const state = await store.getState();
  const voulus = [
    state.pointsChannel,
    ...(state.dropTabs ?? []).map((entry) => entry.channel),
  ].filter(Boolean);

  const ids = { ...(state.channelIds ?? {}) };
  const manquants = [...new Set(voulus.filter((login) => !ids[login]))];

  if (manquants.length) {
    try {
      for (const chaine of await gql.liveChannels(manquants)) ids[chaine.login] = chaine.id;
      await store.setState({ channelIds: ids });
    } catch {
      /* API muette : on retentera au prochain passage */
    }
  }

  // On ne rend que les chaînes encore regardées : garder les anciennes ferait
  // écouter des raids sur des chaînes qu'on a quittées.
  return Object.fromEntries(voulus.filter((login) => ids[login]).map((l) => [l, ids[l]]));
}

/**
 * Un raid part de l'une des chaînes regardées.
 *
 * Deux choses, et il ne faut pas les confondre :
 *
 * 1. Le bonus. Twitch le verse au spectateur qui suit le raid. Il n'a de sens
 *    que sur la chaîne favorite, celle que l'utilisateur a choisie ; le prendre
 *    sur un onglet de farm reviendrait à récolter chez un inconnu.
 * 2. La dérive. Twitch redirige l'onglet vers la cible du raid. Sur un onglet
 *    de farm, cette cible ne porte presque jamais la campagne : le visionnage
 *    ne compte plus, et sans ça l'extension ne s'en apercevait qu'au passage
 *    suivant, une minute plus tard, par un voyant « mauvaise chaîne ».
 *
 * @returns {{joined: boolean, redirected: boolean}}
 */
export async function handleRaid({ raidID, sourceChannelId }, settings) {
  const state = await store.getState();
  const ids = state.channelIds ?? {};
  const source = Object.keys(ids).find((login) => String(ids[login]) === String(sourceChannelId));

  const surFavorite = Boolean(source) && source === state.pointsChannel;
  let joined = false;

  if (settings.joinRaids && surFavorite) {
    try {
      joined = (await gql.joinRaid(raidID)).ok;
    } catch {
      /* raid déjà fini ou refusé : rien à réparer */
    }
  }

  // La chaîne de farm part : on la remplace tout de suite plutôt que d'attendre
  // que le voyant le constate.
  const surFarm = (state.dropTabs ?? []).some((entry) => entry.channel === source);
  if (surFarm) await ensureDropsTabs(settings, { force: true });

  return { joined, redirected: surFarm };
}

/** Des points viennent d'être crédités : c'est une preuve de comptage. */
export async function noteRealtimePoints() {
  const state = await store.getState();
  return store.setState({ proof: { ...(state.proof ?? {}), pointsAt: Date.now() } });
}

/**
 * Progression en direct, chaque minute, sur les chaînes farmées.
 *
 * L'inventaire complet est trop lourd pour être demandé si souvent : on ne le
 * touche que toutes les cinq minutes. `DropCurrentSessionContext` ne renvoie
 * qu'un palier et ses minutes, c'est ce que font les deux miners de référence,
 * et c'est assez léger pour suivre le compteur en direct.
 *
 * Deuxième bénéfice, moins visible : une minute qui monte est la preuve la plus
 * sûre que Twitch compte bien ce visionnage. Le badge « compté en viewer »
 * l'obtient donc en une minute au lieu de cinq.
 */
const LIVE_TTL_MS = 60_000;

export async function refreshLiveProgress() {
  const state = await store.getState();
  const now = Date.now();
  if (now - (state.liveCheckedAt ?? 0) < LIVE_TTL_MS) return state;
  // Empreinte retirée par Twitch : inutile de la redemander chaque minute.
  // L'inventaire, lui, continue de tourner : on perd la fraîcheur, pas la mesure.
  if (state.livePersistedGone) return state;

  const tabs = (state.dropTabs ?? []).filter((entry) => entry.channel);
  if (!tabs.length) return store.setState({ liveCheckedAt: now });

  const ids = await refreshChannelIds();
  const proof = { ...(state.proof ?? {}) };
  const marks = { ...(state.marks ?? {}) };
  let campaigns = (await store.getCampaigns()).campaigns;
  let ecrire = false;

  try {
    const minutes = { ...(marks.liveMinutes ?? {}) };

    for (const entry of tabs) {
      const session = await gql.currentDropSession(ids[entry.channel]);
      if (!session) continue;

      if (progressAdvanced(minutes[session.dropID], session.watchedMinutes)) {
        proof.dropsAt = { ...(proof.dropsAt ?? {}), [entry.campaignId]: now };
      }
      minutes[session.dropID] = session.watchedMinutes;

      const applique = applyLiveSession(campaigns, session);
      if (applique.changed) {
        campaigns = applique.campaigns;
        ecrire = true;
      }
    }

    marks.liveMinutes = minutes;
  } catch (err) {
    if (err?.kind === "persisted") {
      console.warn("[TDC] progression en direct indisponible :", err.message);
      return store.setState({ liveCheckedAt: now, livePersistedGone: true });
    }
    // Réseau ou session : on retentera au prochain passage, sans rien casser.
    return store.setState({ liveCheckedAt: now });
  }

  if (ecrire) await store.setCampaigns(campaigns, { touchDate: false });
  return store.setState({ liveCheckedAt: now, proof, marks });
}

/**
 * Solde de la chaîne suivie, et surtout réclamation du coffre en attente.
 *
 * Le clic dans le DOM reste en place pour les onglets que l'utilisateur ouvre
 * lui-même, mais il dépend d'une classe CSS de Twitch : le jour où elle change,
 * plus rien ne se réclame et rien ne le signale. L'API, elle, dit explicitement
 * qu'un bonus attend et confirme qu'il a été pris.
 */
const POINTS_TTL_MS = 60_000;

/**
 * Deux chemins réclament le même coffre : l'API et le clic dans le DOM. Sans
 * garde, le compteur compterait deux fois, ce qui est exactement le défaut qu'on
 * cherche à corriger. Un coffre apparaît toutes les quinze minutes environ :
 * une minute de fenêtre ne peut pas fusionner deux bonus légitimes.
 */
const POINTS_DEDUPE_MS = 60_000;

export async function recordPointsClaim(channel) {
  const state = await store.getState();
  const now = Date.now();

  if (state.lastPointsChannel === channel && now - (state.lastPointsAt ?? 0) < POINTS_DEDUPE_MS) {
    return false;
  }

  await store.setState({ lastPointsChannel: channel, lastPointsAt: now });
  await store.setHistory(
    addEntries(await store.getHistory(), [
      makeEntry({ kind: HISTORY_KIND.POINTS, channel: channel ?? "" }, now),
    ]),
  );
  await store.bumpStat("points", channel ?? "");
  return true;
}

export async function refreshPoints(settings, { force = false } = {}) {
  const state = await store.getState();
  const channel = state.pointsChannel;
  if (!channel) return null;

  // `force` sert au canal temps réel : Twitch vient d'annoncer un coffre, la
  // valeur en cache est périmée par définition et attendre sa péremption ferait
  // perdre l'intérêt de l'annonce.
  const cached = state.pointsBalance;
  if (!force && cached?.channel === channel && Date.now() - cached.at < POINTS_TTL_MS) return cached;

  let points;
  try {
    points = await gql.channelPoints(channel);
  } catch {
    return cached ?? null; // API muette : on garde la dernière valeur connue
  }
  if (!points) return cached ?? null;

  const fresh = {
    channel,
    balance: points.balance,
    hasBonus: Boolean(points.claimId),
    at: Date.now(),
  };
  await store.setState({ pointsBalance: fresh });

  if (!settings?.claimPoints || !points.claimId) return fresh;
  // Le même coffre ne se réclame qu'une fois, même si on repasse dessus.
  if (state.claimedBonusId === points.claimId) return fresh;

  try {
    const res = await gql.claimCommunityPoints(points.channelId, points.claimId);
    if (!res.ok) return fresh;
  } catch {
    return fresh;
  }

  await store.setState({ claimedBonusId: points.claimId });
  const compte = await recordPointsClaim(channel);
  return { ...fresh, claimed: compte, channel };
}

/** Met à jour la liste « actions requises » et renvoie les nouvelles. */
export async function syncActions(campaigns, now = Date.now()) {
  const existing = pruneActions(await store.getActions(), now);
  const { list, added } = buildPendingActions(campaigns, existing, now);
  await store.setActions(list);
  return { list, added };
}

/**
 * Choisit quoi farmer : la campagne la mieux classée dont une chaîne est en direct.
 * @returns {{campaign: object, channel: string}|null}
 */
export async function pickTarget(campaigns, settings, exclude = {}) {
  const skipCampaigns = exclude.campaigns ?? new Set();
  const skipChannels = exclude.channels ?? new Set();

  const actions = await store.getActions();
  const ranked = rankCampaigns(campaigns, {
    now: Date.now(),
    strategy: settings.priority,
    blacklist: settings.campaignBlacklist,
    focus: settings.focusCampaigns,
    randomAfterFocus: settings.randomAfterFocus,
    linkedOverrides: linkedOverrides(actions),
    onlyLinkedCampaigns: settings.onlyLinkedCampaigns,
  });

  for (const campaign of ranked) {
    if (skipCampaigns.has(campaign.id)) continue;

    if (isCategoryWide(campaign)) {
      const streams = await gql.gameDropStreams(campaign.gameSlug, 10);
      const channel = streams.find((c) => !skipChannels.has(c));
      if (channel) return { campaign, channel };
      continue;
    }

    const live = await gql.liveLogins(campaign.channels.map((c) => c.login));
    const channel = pickChannel(campaign, live.filter((c) => !skipChannels.has(c)));
    if (channel) return { campaign, channel };
  }

  return null;
}

// --- boucles d'entretien --------------------------------------------------

/**
 * Onglet dédié aux points de chaîne, sur la première chaîne favorite en direct.
 * Aucune favorite en direct : l'onglet ne sert plus à rien, on le ferme.
 */
export async function ensurePointsTab(settings) {
  const state = await store.getState();

  if (!settings.enabled || !settings.watchFavorite || !settings.favoriteChannels.length) {
    if (state.pointsTabId) await closeTab(state.pointsTabId);
    return store.setState({ pointsTabId: null, pointsChannel: null });
  }

  // `null` et `[]` ne veulent pas dire la même chose : l'un est une absence
  // d'information, l'autre une réponse. On ne ferme jamais un onglet sur une
  // information qu'on n'a pas.
  let live = null;
  try {
    live = await gql.liveChannels(settings.favoriteChannels);
  } catch {
    live = null;
  }

  if (live === null) {
    if (state.pointsChannel && (await tabExists(state.pointsTabId))) return state;
    const fallback = settings.favoriteChannels[0];
    const tabId = await ensureChannelTab(state.pointsTabId, fallback);
    return store.setState({ pointsTabId: tabId, pointsChannel: fallback, pointsSince: Date.now() });
  }

  if (!live.length) {
    if (state.pointsTabId) await closeTab(state.pointsTabId);
    return store.setState({ pointsTabId: null, pointsChannel: null, pointsSince: null });
  }

  const target = pickFavorite(settings, state, live);
  const change = target !== state.pointsChannel;

  const tabId = await ensureChannelTab(state.pointsTabId, target);
  return store.setState({
    pointsTabId: tabId,
    pointsChannel: target,
    pointsSince: change ? Date.now() : (state.pointsSince ?? Date.now()),
  });
}

/**
 * Laquelle des favorites en direct regarder.
 *
 * Par défaut on ne zappe pas une favorite qui marche : changer d'onglet coûte
 * un rechargement et repart de zéro. La seule raison d'en changer est un bonus
 * de série encore atteignable ailleurs et plus atteignable ici, parce que celui
 * là ne repassera pas : il se prend au début d'un flux ou pas du tout.
 */
function pickFavorite(settings, state, live) {
  const logins = live.map((c) => c.login);
  const courante = logins.includes(state.pointsChannel) ? state.pointsChannel : null;
  const now = Date.now();

  if (!settings.watchStreak) {
    return courante ?? settings.favoriteChannels.find((c) => logins.includes(c));
  }

  const candidats = settings.favoriteChannels
    .map((login) => live.find((c) => c.login === login))
    .filter(Boolean)
    .map((c) => ({
      ...c,
      watchedMs: c.login === state.pointsChannel ? now - (state.pointsSince ?? now) : 0,
    }));

  const ordre = rankForStreak(candidats, { now });
  const meilleur = ordre[0] ?? null;
  if (!courante) return meilleur ?? settings.favoriteChannels.find((c) => logins.includes(c));
  if (meilleur === courante) return courante;

  const parLogin = new Map(candidats.map((c) => [c.login, c]));
  const gagne =
    streakReachable(parLogin.get(meilleur), { now }) &&
    !streakReachable(parLogin.get(courante), { now });

  return gagne ? meilleur : courante;
}

/** Une entrée de farm est-elle encore valable ? */
async function stillWorth(entry, campaigns) {
  if (!(await tabExists(entry.tabId))) return false;

  const campaign = campaigns.find((c) => c.id === entry.campaignId);
  if (!campaign || !isActive(campaign) || campaignProgress(campaign).done) return false;

  try {
    return (await gql.liveLogins([entry.channel])).includes(entry.channel);
  } catch {
    return true; // API muette : on laisse tourner plutôt que de fermer à tort
  }
}

/**
 * Onglets de farm, un par campagne, chacun sur une chaîne différente.
 *
 * Twitch ne fait probablement progresser qu'un flux à la fois. On ne tranche pas
 * à sa place : le badge « compté en viewer » de chaque ligne dit lequel avance
 * réellement, ce qui vaut mieux qu'une affirmation.
 */
export async function ensureDropsTabs(settings, { force = false } = {}) {
  const state = await store.getState();
  const actifs = state.dropTabs ?? [];
  const voulus =
    settings.enabled && settings.farmDrops && settings.autoDiscover ? settings.farmTabs : 0;

  if (voulus === 0) {
    for (const entry of actifs) await closeTab(entry.tabId);
    return store.setState({ dropTabs: [] });
  }

  const { campaigns } = await store.getCampaigns();

  const gardes = [];
  if (!force) {
    for (const entry of actifs) {
      if (gardes.length >= voulus) break;
      if (await stillWorth(entry, campaigns)) gardes.push(entry);
    }
  }

  for (const entry of actifs) {
    if (!gardes.some((g) => g.tabId === entry.tabId)) await closeTab(entry.tabId);
  }

  // Deux onglets sur la même campagne ou la même chaîne ne serviraient à rien.
  const campagnesPrises = new Set(gardes.map((g) => g.campaignId));
  const chainesPrises = new Set(gardes.map((g) => g.channel));
  const suite = [...gardes];

  while (suite.length < voulus) {
    const target = await pickTarget(campaigns, settings, {
      campaigns: campagnesPrises,
      channels: chainesPrises,
    });
    if (!target) break;

    const tabId = await ensureChannelTab(null, target.channel);
    suite.push({
      tabId,
      channel: target.channel,
      campaignId: target.campaign.id,
      since: Date.now(),
    });
    campagnesPrises.add(target.campaign.id);
    chainesPrises.add(target.channel);
  }

  return store.setState({ dropTabs: suite });
}

/**
 * Passe de réclamation : ouvre (ou recharge) l'inventaire, le script de contenu
 * fait les clics et rapporte. En mode rapide, on réclame directement par l'API.
 */
export async function runClaimSweep(settings) {
  if (!settings.enabled) return { mode: "off", claimed: 0 };

  if (settings.fastClaim) {
    const { campaigns } = await store.getCampaigns();
    let claimed = 0;
    for (const campaign of campaigns) {
      for (const drop of campaign.drops) {
        if (drop.isClaimed || !drop.dropInstanceID) continue;
        try {
          await gql.claimDrop(drop.dropInstanceID);
          claimed += 1;
        } catch {
          /* on retentera au prochain passage */
        }
      }
    }
    return { mode: "api", claimed };
  }

  const state = await store.getState();
  if (await tabExists(state.inventoryTabId)) {
    await chrome.tabs.reload(state.inventoryTabId);
    await store.setState({ inventorySince: Date.now() });
    return { mode: "dom", claimed: 0, tabId: state.inventoryTabId };
  }

  // Un onglet d'inventaire marqué peut trainer d'une session précédente : on le
  // reprend plutôt que d'en ouvrir un second sur la même page.
  const dejaLa = await findMarkedTab("drops/inventory");
  const tabId = dejaLa?.id ?? (await openBackgroundTab(INVENTORY_URL));
  if (dejaLa) await chrome.tabs.reload(tabId);

  await store.setState({ inventoryTabId: tabId, inventorySince: Date.now() });
  return { mode: "dom", claimed: 0, tabId };
}

/** Durée laissée à la page d'inventaire pour charger et cliquer avant fermeture. */
const INVENTORY_GRACE_MS = 90_000;

/**
 * L'inventaire n'a pas à rester ouvert entre deux passages. On ne le garde que
 * s'il est le seul onglet Twitch : il sert alors aussi à reprendre le jeton
 * d'intégrité, sans lequel plus rien ne fonctionne.
 */
export async function closeInventoryIfRedundant() {
  const state = await store.getState();
  if (!state.inventoryTabId) return state;
  if (Date.now() - (state.inventorySince ?? 0) < INVENTORY_GRACE_MS) return state;

  const stillNeeded =
    !(await tabExists(state.pointsTabId)) && !(await anyDropTabAlive(state));
  if (stillNeeded) return state;

  await closeTab(state.inventoryTabId);
  return store.setState({ inventoryTabId: null, inventorySince: null });
}

export async function reloadTab(tabId) {
  if (!(await tabExists(tabId))) return false;
  try {
    await chrome.tabs.reload(tabId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ouvre un onglet Twitch quand il n'y en a aucun, uniquement pour que l'extension
 * puisse reprendre le jeton d'intégrité au passage. L'inventaire est le meilleur
 * candidat : c'est de toute façon la page dont on a besoin pour réclamer.
 */
export async function ensureHarvestTab() {
  const state = await store.getState();
  if (await tabExists(state.inventoryTabId)) return state;
  if (await tabExists(state.pointsTabId)) return state;
  if (await anyDropTabAlive(state)) return state;

  // Cet onglet ne sert qu'à reprendre le jeton d'intégrité, et le script de
  // contenu tourne sur TOUS les onglets Twitch : celui que l'utilisateur a déjà
  // ouvert fait aussi bien l'affaire. En ouvrir un de plus, et donc une fenêtre,
  // pour une page qu'on a déjà sous la main n'a aucun sens.
  if (await anyTwitchTab()) return state;

  const tabId = await openBackgroundTab(INVENTORY_URL);
  return store.setState({ inventoryTabId: tabId, inventorySince: Date.now() });
}

/**
 * Reprend la fenêtre de la session précédente. Appelé au démarrage, avant que
 * quoi que ce soit ouvre un onglet : sinon la première ouverture en crée une
 * autre à côté de celle qui existait déjà.
 */
export async function adoptExistingWindow() {
  const state = await store.getState();
  if (state.windowId) return state.windowId;

  const retrouvee = await findOwnWindow();
  if (retrouvee != null) await store.setState({ windowId: retrouvee });
  return retrouvee;
}

/**
 * Réveille un onglet dont le lecteur reste bloqué : on l'active dans SA fenêtre.
 * Si la fenêtre dédiée est utilisée, l'utilisateur ne voit rien passer, seule la
 * fenêtre réduite de l'extension change d'onglet actif.
 */
/** Temps laissé au lecteur pour démarrer avant de rendre la place. */
const WAKE_VISIBLE_MS = 5_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function wakeTab(tabId) {
  if (!(await tabExists(tabId))) return false;

  let precedent = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) return true; // déjà devant, rien à voler ni à rendre

    // On note qui occupait la place avant de la prendre.
    const [actif] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (actif && actif.id !== tabId) precedent = actif.id;

    await chrome.tabs.update(tabId, { active: true });
  } catch {
    return false;
  }

  if (precedent === null) return true;

  // Quelques secondes au premier plan suffisent à débloquer un lecteur. Rester
  // devant plus longtemps reviendrait à confisquer l'onglet que l'utilisateur
  // regardait, ce qui ne vaut jamais le gain.
  await wait(WAKE_VISIBLE_MS);
  try {
    await chrome.tabs.update(precedent, { active: true });
  } catch {
    /* l'onglet précédent a été fermé entre-temps */
  }
  return true;
}

/**
 * Rassemble les onglets de l'extension dans la fenêtre cible.
 * @returns {{windowId: number, placed: number}}
 */
export async function regroupTabs(settings) {
  const state = await store.getState();

  const vivants = [];
  for (const tabId of [
    state.pointsTabId,
    ...(state.dropTabs ?? []).map((entry) => entry.tabId),
    state.inventoryTabId,
  ].filter(Boolean)) {
    if (await tabExists(tabId)) vivants.push(tabId);
  }

  // Rien à déplacer : surtout ne pas créer une fenêtre pour l'y mettre. C'est
  // ce qui en ouvrait une à chaque cycle quand l'extension n'avait aucun onglet.
  if (!vivants.length) return { windowId: state.windowId ?? null, placed: 0 };

  const windowId = await targetWindowId(settings, "regroupement");
  if (windowId == null) return { windowId: null, placed: 0 };

  let placed = 0;
  for (const tabId of vivants) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== windowId) await chrome.tabs.move(tabId, { windowId, index: -1 });
      placed += 1;
    } catch {
      /* onglet disparu entre-temps */
    }
  }
  return { windowId, placed };
}

/**
 * Repart d'une fenêtre neuve pour l'extension et y rapatrie ses onglets.
 * Utile quand la fenêtre dédiée a été fermée, ou que les onglets ont fini
 * éparpillés dans les fenêtres de l'utilisateur.
 */
export async function rebuildWindow(settings) {
  const created = await chrome.windows.create({ focused: false });
  try {
    await chrome.windows.update(created.id, { state: "minimized" });
  } catch {
    /* pas réduite, elle reste en arrière-plan */
  }
  await traceWindow({ action: "creee", appelant: "bouton-refaire", windowId: created.id });
  const blank = created.tabs?.[0]?.id ?? null;
  await store.setState({ windowId: created.id, windowCreatedAt: Date.now() });

  const { placed } = await regroupTabs({ ...settings, dedicatedWindow: true });

  // L'onglet vide créé avec la fenêtre n'est fermé que si un autre l'a remplacé :
  // fermer le dernier onglet fermerait la fenêtre qu'on vient de faire.
  if (blank && placed > 0) await closeTab(blank);

  return { windowId: created.id, placed };
}

export async function closeAllTabs() {
  const state = await store.getState();
  await Promise.all([
    closeTab(state.pointsTabId),
    ...(state.dropTabs ?? []).map((entry) => closeTab(entry.tabId)),
    closeTab(state.inventoryTabId),
  ]);
  return store.setState({
    pointsTabId: null,
    pointsChannel: null,
    dropTabs: [],
    inventoryTabId: null,
    tabChannels: {},
  });
}

/** Réapplique la sourdine à tous les onglets gérés, après un changement de réglage. */
export async function refreshTabMute(settings) {
  const state = await store.getState();
  const tousLesOnglets = [
    state.pointsTabId,
    ...(state.dropTabs ?? []).map((entry) => entry.tabId),
    state.inventoryTabId,
  ];
  for (const tabId of tousLesOnglets) {
    if (tabId && (await tabExists(tabId))) await applyTabMute(tabId, settings);
  }
}

// `openBackgroundTab` reste privée : chacun des trois chemins qui l'appellent
// vérifie d'abord qu'un onglet n'existe pas déjà. L'exporter ouvrirait une porte
// où cette vérification pourrait être oubliée.
export { tabExists, closeTab };
