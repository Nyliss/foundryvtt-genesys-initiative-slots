const MODULE_ID = "genesys-initiative-slots";
const SOCKET = `module.${MODULE_ID}`;
const STABLE_CLAIMS_FLAG = "stableClaims";
const REVEAL_SIDE_NAME_FLAG = "revealNpcName"; // Legacy storage key retained for existing encounters.

const CAROUSEL_ID = "gis-initiative-carousel";
let carouselRenderTimer = null;

// Per-client, in-memory presentation state only. In structured combat all
// inactive slots stay compact. The active slot expands automatically unless
// the user explicitly chooses “Collapse All” for the current round.
const carouselCollapseAllState = new Map();

// Before Begin Encounter, keep the combatants in a stable visual order even
// while initiative results are being rolled. Genesys/Foundry may reorder
// combat.turns as initiative values arrive; the carousel should not shuffle
// until combat actually starts.
const carouselPreCombatOrder = new Map();


/**
 * Genesys Initiative Slots v0.2.5
 * Foundry VTT 13.351 + Genesys 0.2.19
 *
 * This module does not replace Combat, Combatant, CONFIG.ui.combat, or the
 * Genesys dice engine. It augments the v13 Combat Tracker UI and maintains a
 * stable mapping between Genesys initiative slots and their claimants so that
 * inserting/rerolling combatants cannot move an existing claim onto a slot of
 * another disposition.
 */

const encounterSkillChoice = new Map();
const reconcileTimers = new Map();

const INITIATIVE_ROLES = {
  vigilance: {
    canonical: "Vigilance",
    fallbackChar: "willpower",
    setting: "vigilanceSkillName",
    aliases: ["Vigilance", "Пильність"]
  },
  cool: {
    canonical: "Cool",
    fallbackChar: "presence",
    setting: "coolSkillName",
    aliases: ["Cool", "Самовладання"]
  }
};

const SIDE_META = {
  pc: { label: "PC", className: "pc" },
  neutral: { label: "Neutral", className: "neutral" },
  npc: { label: "NPC", className: "npc" }
};

function sideNameRevealed(combatant) {
  if (!combatant) return false;
  try {
    return Boolean(combatant.getFlag?.(MODULE_ID, REVEAL_SIDE_NAME_FLAG));
  } catch {
    return false;
  }
}

function sideUsesHiddenIdentity(combatant) {
  const side = dispositionSide(combatant);
  return side === "npc" || side === "neutral";
}

function hiddenIdentityLabel(combatant) {
  return SIDE_META[dispositionSide(combatant)]?.label ?? "NPC";
}

function canSeeCombatantName(combatant) {
  if (!combatant) return false;
  if (!sideUsesHiddenIdentity(combatant)) return true;
  return Boolean(game.user?.isGM || sideNameRevealed(combatant));
}

function visibleCombatantName(combatant) {
  if (!combatant) return "";
  return canSeeCombatantName(combatant)
    ? (combatant.name ?? hiddenIdentityLabel(combatant))
    : hiddenIdentityLabel(combatant);
}

async function toggleSideNameReveal(combatant) {
  if (!game.user?.isGM || !combatant || !sideUsesHiddenIdentity(combatant)) return;
  const next = !sideNameRevealed(combatant);
  await combatant.setFlag(MODULE_ID, REVEAL_SIDE_NAME_FLAG, next);
  if ((ui.combat?.viewed ?? game.combat)?.id === combatant.parent?.id) ui.combat?.render?.();
  scheduleCarouselRender(0);
}

function combatantDefeated(combatant) {
  if (!combatant) return false;
  return Boolean(combatant.defeated ?? combatant.isDefeated ?? combatant._source?.defeated);
}

function statusSourceEntries(combatant) {
  const actor = combatant?.actor;
  if (!actor) return [];

  const ids = new Set();
  const actorStatuses = actor.statuses;
  if (actorStatuses && typeof actorStatuses[Symbol.iterator] === "function") {
    for (const id of actorStatuses) if (id) ids.add(String(id));
  }

  const tokenStatuses = combatant?.token?.statuses;
  if (tokenStatuses && typeof tokenStatuses[Symbol.iterator] === "function") {
    for (const id of tokenStatuses) if (id) ids.add(String(id));
  }

  const effectByStatus = new Map();
  for (const effect of actor.effects ?? []) {
    if (effect.disabled || effect.isSuppressed) continue;
    const statuses = effect.statuses;
    if (!statuses || typeof statuses[Symbol.iterator] !== "function") continue;
    for (const id of statuses) {
      if (!id) continue;
      ids.add(String(id));
      if (!effectByStatus.has(String(id))) effectByStatus.set(String(id), effect);
    }
  }

  const configs = Array.from(CONFIG.statusEffects ?? []);
  const configById = new Map(configs.map((entry) => [String(entry.id ?? entry._id ?? ""), entry]));
  const entries = [];
  for (const id of ids) {
    const effect = effectByStatus.get(id);
    const config = configById.get(id);
    const img = effect?.img ?? effect?.icon ?? config?.img ?? config?.icon;
    if (!img) continue;
    const rawName = effect?.name ?? config?.name ?? config?.label ?? id;
    let name = String(rawName ?? id);
    try {
      if (game.i18n?.has?.(name)) name = game.i18n.localize(name);
    } catch {}
    entries.push({ id, name, img });
  }
  return entries;
}

function makeStatusRow(combatant, className = "gis-carousel-statuses") {
  const statuses = statusSourceEntries(combatant);
  if (!statuses.length) return null;
  const row = document.createElement("div");
  row.className = className;
  row.setAttribute("aria-label", "Statuses");
  for (const status of statuses) {
    const img = document.createElement("img");
    img.className = "gis-status-icon";
    img.src = status.img;
    img.alt = status.name;
    img.title = status.name;
    row.append(img);
  }
  return row;
}

function normalizeName(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function skillData(skill) {
  return skill?.systemData ?? skill?.system ?? {};
}

function actorSkillItems(actor) {
  if (!actor?.items) return [];
  return actor.items.filter((item) => item.type === "skill");
}

function allKnownSkillItems() {
  const seen = new Set();
  const skills = [];

  const add = (item) => {
    if (!item || item.type !== "skill") return;
    const key = item.uuid ?? `${item.parent?.uuid ?? "world"}:${item.id ?? item.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    skills.push(item);
  };

  for (const item of game.items ?? []) add(item);
  for (const actor of game.actors ?? []) {
    for (const item of actorSkillItems(actor)) add(item);
  }

  return skills;
}

function findSkillByNames(skills, names) {
  const wanted = names.map(normalizeName).filter(Boolean);
  return skills.find((skill) => wanted.includes(normalizeName(skill.name)));
}

function configuredSkillName(role) {
  const config = INITIATIVE_ROLES[role];
  if (!config) return "";
  try {
    return String(game.settings.get(MODULE_ID, config.setting) ?? "").trim();
  } catch {
    return "";
  }
}

function resolveInitiativeSkill(actor, role) {
  const config = INITIATIVE_ROLES[role] ?? INITIATIVE_ROLES.vigilance;
  const actorSkills = actorSkillItems(actor);
  const knownSkills = allKnownSkillItems();
  const configured = configuredSkillName(role);

  let skill = null;
  if (configured) {
    skill = findSkillByNames(actorSkills, [configured]) ?? findSkillByNames(knownSkills, [configured]);
  }

  if (!skill) {
    skill = findSkillByNames(actorSkills, config.aliases) ?? findSkillByNames(knownSkills, config.aliases);
  }

  const name = skill?.name ?? configured ?? config.canonical;
  const characteristic = skillData(skill).characteristic ?? config.fallbackChar;

  return {
    role,
    skillName: name,
    skillChar: characteristic
  };
}

function rootElement(html) {
  if (typeof HTMLElement !== "undefined" && html instanceof HTMLElement) return html;
  if (typeof HTMLElement !== "undefined" && html?.[0] instanceof HTMLElement) return html[0];
  return html?.[0] ?? html ?? null;
}

function keyFor(combat, combatant) {
  return `${combat.id}:${combatant.id}`;
}

function getChoice(combat, combatant) {
  return encounterSkillChoice.get(keyFor(combat, combatant)) ?? "vigilance";
}

function setChoice(combat, combatant, role) {
  encounterSkillChoice.set(keyFor(combat, combatant), role === "cool" ? "cool" : "vigilance");
}

function clearCombatChoices(combatId) {
  for (const key of [...encounterSkillChoice.keys()]) {
    if (key.startsWith(`${combatId}:`)) encounterSkillChoice.delete(key);
  }
}

function combatantDisposition(combatant) {
  if (["friendly", "neutral", "hostile"].includes(combatant?.disposition)) {
    return combatant.disposition;
  }

  const d = combatant?.token?.disposition ?? combatant?.actor?.prototypeToken?.disposition;
  if (d === CONST.TOKEN_DISPOSITIONS.FRIENDLY) return "friendly";
  if (d === CONST.TOKEN_DISPOSITIONS.HOSTILE) return "hostile";
  return "neutral";
}

function dispositionSide(combatant) {
  const disposition = combatantDisposition(combatant);
  if (disposition === "friendly") return "pc";
  if (disposition === "hostile") return "npc";
  return "neutral";
}

function collectionContainsUser(collection, user) {
  if (!collection || !user) return false;
  try {
    if (typeof collection.includes === "function" && collection.includes(user)) return true;
    if (typeof collection.some === "function" && collection.some((entry) => entry?.id === user.id)) return true;
    for (const entry of collection) {
      if (entry?.id === user.id) return true;
    }
  } catch {
    // Ignore non-iterable ownership helpers and continue with document checks.
  }
  return false;
}

function userOwnsDocument(user, document) {
  if (!user || !document) return false;
  if (user.isGM) return true;

  try {
    if (typeof document.testUserPermission === "function" && document.testUserPermission(user, "OWNER")) return true;
  } catch {
    // Fall through to raw ownership data where available.
  }

  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const ownership = document.ownership ?? {};
  const level = ownership[user.id] ?? ownership.default ?? 0;
  return level >= ownerLevel;
}

function userOwnsCombatant(user, combatant) {
  if (!user || !combatant) return false;
  if (user.isGM) return true;

  // The legacy Genesys tracker used Combatant.players. In v13 this may be an
  // Array-like or Set-like collection, so do not assume Array.isArray().
  if (collectionContainsUser(combatant.players, user)) return true;

  // Prefer the actual Scene Token permission when available. This matters for
  // unlinked/synthetic actors and matches the user's ability to control the
  // token on the canvas more closely than checking a world Actor alone.
  if (userOwnsDocument(user, combatant.token)) return true;
  if (userOwnsDocument(user, combatant.actor)) return true;

  return false;
}

function userOwnsTokenForCombatant(user, tokenDocument, combatant) {
  if (!user || !combatant) return false;
  if (user.isGM) return true;
  if (tokenDocument && userOwnsDocument(user, tokenDocument)) return true;
  return userOwnsCombatant(user, combatant);
}

async function rollInitiative(combat, combatant, role, { activationId = -1 } = {}) {
  if (!combat || !combatant) return;

  const resolved = resolveInitiativeSkill(combatant.actor, role);

  combatant.initiativeSkill = {
    skillName: resolved.skillName,
    skillChar: resolved.skillChar
  };

  try {
    const extraSlotsRolls = activationId >= 0 ? [activationId] : [];
    await combat.rollInitiative([combatant.id], {}, { prompt: false, extraSlotsRolls });
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to roll ${resolved.skillName} initiative`, err);
    ui.notifications.error(`Genesys Initiative Slots: failed to roll ${resolved.skillName}. Check the console for details.`);
  } finally {
    // Initiative choice is encounter-local UI state only. Do not persist it to
    // the Actor/Combatant after the roll.
    delete combatant.initiativeSkill;
  }
}

function findRows(root) {
  const direct = [...root.querySelectorAll("li.combatant[data-combatant-id], .combatant[data-combatant-id]")];
  if (direct.length) return direct;

  const candidates = [...root.querySelectorAll("[data-combatant-id]")];
  return candidates.filter((el) => !el.parentElement?.closest?.("[data-combatant-id]"));
}

function findNameElement(row) {
  return row.querySelector(".token-name h4, .combatant-name, .name, h4");
}

function findImageElement(row) {
  return row.querySelector("img.token-image, img.combatant-image, img");
}

function findControlsContainer(row) {
  return row.querySelector(".combatant-controls, .controls, .token-name") ?? row;
}

function hideNativeInitiativeRoll(row) {
  const selectors = [
    '[data-control="rollInitiative"]',
    '[data-action="rollInitiative"]',
    '[data-action="roll-initiative"]'
  ];
  for (const selector of selectors) {
    for (const el of row.querySelectorAll(selector)) el.classList.add("gis-native-roll-hidden");
  }
}

function hideNativeInitiativeValue(row) {
  for (const el of row.querySelectorAll(".token-initiative, .combatant-initiative")) {
    el.classList.add("gis-native-initiative-hidden");
  }
}

function formatInitiative(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  return Number(value).toFixed(2);
}

function addPreparationControls(root, combat) {
  const rows = findRows(root);
  for (const row of rows) {
    const combatantId = row.dataset.combatantId;
    if (!combatantId) continue;
    const combatant = combat.combatants.get(combatantId);
    if (!combatant) continue;

    row.classList.add("gis-prep-row");
    hideNativeInitiativeRoll(row);
    hideNativeInitiativeValue(row);

    const side = dispositionSide(combatant);
    if (sideUsesHiddenIdentity(combatant)) {
      const name = findNameElement(row);
      if (name) {
        name.textContent = visibleCombatantName(combatant);
        name.title = visibleCombatantName(combatant);
      }
      addSideRevealControl(row, combatant, side);
    }

    const controls = findControlsContainer(row);
    if (controls.querySelector(`.gis-prep[data-combatant-id="${combatantId}"]`)) continue;

    const wrap = document.createElement("span");
    wrap.className = "gis-prep";
    wrap.dataset.combatantId = combatantId;

    const select = document.createElement("select");
    select.className = "gis-skill-select";
    select.setAttribute("aria-label", "Initiative skill");

    const vigilance = resolveInitiativeSkill(combatant.actor, "vigilance");
    const cool = resolveInitiativeSkill(combatant.actor, "cool");
    for (const resolved of [vigilance, cool]) {
      const option = document.createElement("option");
      option.value = resolved.role;
      option.textContent = resolved.skillName;
      select.append(option);
    }

    select.value = getChoice(combat, combatant);
    select.disabled = combatant.initiative !== null;
    select.addEventListener("change", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setChoice(combat, combatant, event.currentTarget.value);
    });
    select.addEventListener("click", (event) => event.stopPropagation());

    const button = document.createElement("button");
    button.type = "button";
    button.className = "gis-roll-button";
    const rolled = combatant.initiative !== null;
    button.textContent = rolled ? "✓" : "Roll";
    button.title = rolled ? "Initiative rolled" : "Roll initiative";
    button.disabled = rolled || !userOwnsCombatant(game.user, combatant);
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const role = getChoice(combat, combatant);
      await rollInitiative(combat, combatant, role);
    });

    const result = document.createElement("span");
    result.className = "gis-prep-result";
    result.textContent = formatInitiative(combatant.initiative);
    result.title = rolled ? "Initiative result" : "";

    wrap.append(select, button, result);
    controls.append(wrap);
  }
}

function fallbackSlotComparator(first, second) {
  const firstInitiative = first.initiative ?? -Infinity;
  const secondInitiative = second.initiative ?? -Infinity;
  if (firstInitiative !== secondInitiative) return secondInitiative - firstInitiative;

  if (first.disposition === second.disposition) {
    if (first.id === second.id) return 0;
    return first.id > second.id ? 1 : -1;
  }

  const dispositions = ["hostile", "neutral", "friendly"];
  return dispositions.indexOf(second.disposition) - dispositions.indexOf(first.disposition);
}

function buildSlotDescriptors(combat) {
  if (!combat) return [];

  const descriptors = Array.from(combat.combatants ?? []).map((combatant) => ({
    origin: combatant,
    initiative: combatant.initiative,
    activationId: -1,
    key: `${combatant.id}:0`,
    disposition: combatantDisposition(combatant),
    id: combatant.id
  }));

  if (typeof combat.extraSlotsForRound === "function") {
    for (const slot of combat.extraSlotsForRound(combat.round) ?? []) {
      const origin = combat.combatants.get(slot.activationSource);
      if (!origin) continue;
      descriptors.push({
        origin,
        initiative: slot.initiative,
        activationId: slot.index,
        key: `${origin.id}:extra:${slot.index}`,
        disposition: combatantDisposition(origin),
        id: origin.id
      });
    }
  }

  const sorter = typeof combat._sortSlots === "function"
    ? combat._sortSlots.bind(combat)
    : fallbackSlotComparator;
  return descriptors.sort(sorter);
}

function slotDescriptors(combat) {
  const cached = combat?.__gisSlotDescriptors;
  if (Array.isArray(cached) && cached.length === (combat?.turns?.length ?? cached.length)) return cached;
  return buildSlotDescriptors(combat);
}

function originTurns(combat) {
  return slotDescriptors(combat).map((slot) => slot.origin);
}

function slotKeys(combat) {
  return slotDescriptors(combat).map((slot) => slot.key);
}

function slotKeyAt(combat, slotIndex) {
  return slotDescriptors(combat)[slotIndex]?.key;
}

function slotDescriptorAt(combat, slotIndex) {
  return slotDescriptors(combat)[slotIndex];
}

function slotOriginAt(combat, slotIndex) {
  return slotDescriptorAt(combat, slotIndex)?.origin;
}

function slotIsExtra(combat, slotIndex) {
  return (slotDescriptorAt(combat, slotIndex)?.activationId ?? -1) >= 0;
}

function readStableClaims(combat) {
  const claims = combat.getFlag?.(MODULE_ID, STABLE_CLAIMS_FLAG);
  return claims && typeof claims === "object" ? claims : {};
}

function cloneStableClaims(combat) {
  return foundry.utils.deepClone(readStableClaims(combat));
}

function stableRoundClaims(combat) {
  const all = readStableClaims(combat);
  return all?.[String(combat.round)] ?? all?.[combat.round] ?? {};
}

function stableClaimantId(combat, slotIndex) {
  const key = slotKeyAt(combat, slotIndex);
  if (!key) return undefined;
  return stableRoundClaims(combat)[key];
}

function claimantForSlot(combat, slotIndex) {
  const roundStable = stableRoundClaims(combat);
  // Once a stable map exists for this round, it is authoritative. Do not
  // fall back to Genesys' index-based claim for a newly inserted slot, because
  // that old index may now belong to another faction.
  if (Object.keys(roundStable).length) {
    const stableId = stableClaimantId(combat, slotIndex);
    return stableId ? combat.combatants.get(stableId) : undefined;
  }

  if (typeof combat.claimantForSlot !== "function") return undefined;
  const id = combat.claimantForSlot(combat.round, slotIndex);
  return id ? combat.combatants.get(id) : undefined;
}

function hasClaimedNormalSlotThisRound(combat, combatantId) {
  const claims = stableRoundClaims(combat);
  if (Object.keys(claims).length) {
    return Object.entries(claims).some(([key, claimantId]) => {
      return claimantId === combatantId && !String(key).includes(":extra:");
    });
  }

  // Migration/fallback for claims created before stable slot keys existed.
  const slots = slotDescriptors(combat);
  for (let i = 0; i < slots.length; i++) {
    if ((slots[i]?.activationId ?? -1) >= 0) continue;
    const id = typeof combat.claimantForSlot === "function" ? combat.claimantForSlot(combat.round, i) : undefined;
    if (id === combatantId) return true;
  }
  return false;
}

function selectedClaimTarget(combat) {
  const selected = canvas?.tokens?.controlled ?? [];
  if (selected.length !== 1) {
    ui.notifications.warn("Select exactly one combatant token to claim an initiative slot.");
    return null;
  }

  const token = selected[0];
  const combatant = token.combatant;
  if (!combatant || combatant.parent?.id !== combat.id) {
    ui.notifications.warn("The selected token is not a combatant in this encounter.");
    return null;
  }

  if (!game.user.isGM && !userOwnsTokenForCombatant(game.user, token.document, combatant)) {
    ui.notifications.warn("You do not control the selected token.");
    return null;
  }

  return { token, combatant };
}

function eligibleCombatants(combat, side, user = game.user, { allowRepeat = false } = {}) {
  if (!combat || !user) return [];
  return combat.combatants.filter((combatant) => {
    return dispositionSide(combatant) === side &&
      !combatantDefeated(combatant) &&
      userOwnsCombatant(user, combatant) &&
      (allowRepeat || !hasClaimedNormalSlotThisRound(combat, combatant.id));
  });
}

function userHasEligibleCombatant(combat, side, slotIndex, user = game.user) {
  const allowRepeat = slotIsExtra(combat, slotIndex);
  if (user?.isGM) return combat.combatants.some((combatant) => {
    return dispositionSide(combatant) === side &&
      !combatantDefeated(combatant) &&
      (allowRepeat || !hasClaimedNormalSlotThisRound(combat, combatant.id));
  });
  return eligibleCombatants(combat, side, user, { allowRepeat }).length > 0;
}

function resolveClaimTarget(combat, side, slotIndex) {
  const target = selectedClaimTarget(combat);
  if (!target) return null;

  const { token, combatant } = target;
  if (dispositionSide(combatant) !== side) {
    ui.notifications.warn(`The selected token cannot claim a ${SIDE_META[side].label} slot.`);
    return null;
  }

  if (combatantDefeated(combatant)) {
    ui.notifications.warn(`${combatant.name} is marked defeated and cannot claim an initiative slot.`);
    return null;
  }

  if (!slotIsExtra(combat, slotIndex) && hasClaimedNormalSlotThisRound(combat, combatant.id)) {
    ui.notifications.warn(`${combatant.name} has already acted or claimed a normal slot this round.`);
    return null;
  }

  return {
    combatant,
    tokenId: token.document.id,
    sceneId: token.document.parent?.id ?? canvas.scene?.id ?? combatant.sceneId
  };
}

function activeGM() {
  return game.users
    .filter((u) => u.active && u.isGM)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
}

function requestGM(payload) {
  const gm = activeGM();
  if (!gm) {
    ui.notifications.warn("Genesys Initiative Slots requires an active GM for this action.");
    return false;
  }
  game.socket.emit(SOCKET, { ...payload, userId: game.user.id });
  return true;
}

function buildSystemClaims(combat, stableClaims) {
  const genesysClaims = foundry.utils.deepClone(combat.getFlag("genesys", "claimants") ?? {});
  const round = String(combat.round);
  const keys = slotKeys(combat);
  const roundStable = stableClaims?.[round] ?? stableClaims?.[combat.round] ?? {};
  const roundClaims = {};

  keys.forEach((key, index) => {
    const claimantId = roundStable[key];
    if (claimantId && combat.combatants.has(claimantId)) roundClaims[index] = claimantId;
  });

  genesysClaims[round] = roundClaims;
  return genesysClaims;
}

async function persistClaims(combat, stableClaims) {
  const genesysClaims = buildSystemClaims(combat, stableClaims);
  await combat.update({
    [`flags.${MODULE_ID}.${STABLE_CLAIMS_FLAG}`]: stableClaims,
    "flags.genesys.claimants": genesysClaims
  });

  // Rebuild the local turn array immediately so Foundry's active combatant,
  // turn marker, and other turn consumers see the claimant rather than the
  // character who originally rolled the slot.
  combat.setupTurns?.();
  combat._updateTurnMarkers?.();
}

function migrateCurrentRoundClaims(combat, stableClaims) {
  const round = String(combat.round);
  stableClaims[round] ??= {};

  // Import the old Genesys index-based claims only once. If a stable map
  // already exists, missing keys represent genuinely new/unclaimed slots.
  if (Object.keys(stableClaims[round]).length) return stableClaims;

  const keys = slotKeys(combat);
  for (let i = 0; i < keys.length; i++) {
    const legacyId = typeof combat.claimantForSlot === "function" ? combat.claimantForSlot(combat.round, i) : undefined;
    if (legacyId && combat.combatants.has(legacyId)) stableClaims[round][keys[i]] = legacyId;
  }

  return stableClaims;
}

async function reconcileClaims(combat) {
  if (!game.user.isGM || !combat?.started) return;

  let stableClaims = cloneStableClaims(combat);
  stableClaims = migrateCurrentRoundClaims(combat, stableClaims);

  const round = String(combat.round);
  const validKeys = new Set(slotKeys(combat));
  const currentRound = stableClaims[round] ?? {};

  // Prune slots/combatants that no longer exist.
  for (const [key, claimantId] of Object.entries({ ...currentRound })) {
    if (!validKeys.has(key) || !combat.combatants.has(claimantId)) delete currentRound[key];
  }
  stableClaims[round] = currentRound;

  const desiredGenesys = buildSystemClaims(combat, stableClaims);
  const currentGenesys = combat.getFlag("genesys", "claimants") ?? {};
  const stableStored = combat.getFlag(MODULE_ID, STABLE_CLAIMS_FLAG) ?? {};

  const stableChanged = JSON.stringify(stableStored) !== JSON.stringify(stableClaims);
  const genesysChanged = JSON.stringify(currentGenesys) !== JSON.stringify(desiredGenesys);
  if (stableChanged || genesysChanged) await persistClaims(combat, stableClaims);
}

function scheduleReconcile(combat) {
  if (!combat?.id || !game.user.isGM || !combat.started) return;
  const previous = reconcileTimers.get(combat.id);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(async () => {
    reconcileTimers.delete(combat.id);
    try {
      await reconcileClaims(combat);
    } catch (err) {
      console.error(`${MODULE_ID} | Claim reconciliation failed`, err);
    }
  }, 100);
  reconcileTimers.set(combat.id, timer);
}

function sceneTokenDocument(sceneId, tokenId) {
  if (!sceneId || !tokenId) return null;
  return game.scenes?.get(sceneId)?.tokens?.get(tokenId) ?? null;
}

async function performClaim(combat, slotIndex, chosen, requester, tokenRef = {}) {
  const origin = slotOriginAt(combat, slotIndex);
  if (!origin || !chosen) return false;

  const slotSide = dispositionSide(origin);
  const chosenSide = dispositionSide(chosen);
  if (slotSide !== chosenSide) {
    if (requester?.id === game.user.id) ui.notifications.warn(`That token cannot claim a ${SIDE_META[slotSide].label} slot.`);
    return false;
  }

  // Claims are explicitly token-driven. Verify that the token sent by the
  // player is the token represented by this Combatant, then test permission on
  // that Scene Token. This handles synthetic/unlinked Actors correctly.
  const tokenDocument = sceneTokenDocument(tokenRef.sceneId ?? chosen.sceneId, tokenRef.tokenId ?? chosen.tokenId);
  if (!requester?.isGM) {
    if (!tokenDocument) return false;
    if (chosen.tokenId !== tokenDocument.id || (chosen.sceneId && tokenRef.sceneId && chosen.sceneId !== tokenRef.sceneId)) return false;
    if (!userOwnsTokenForCombatant(requester, tokenDocument, chosen)) return false;
  }

  if (combatantDefeated(chosen)) return false;

  if (!slotIsExtra(combat, slotIndex) && hasClaimedNormalSlotThisRound(combat, chosen.id)) {
    if (requester?.id === game.user.id) ui.notifications.warn(`${chosen.name} has already acted or claimed a normal slot this round.`);
    return false;
  }

  const slotKey = slotKeyAt(combat, slotIndex);
  if (!slotKey) return false;

  let stableClaims = cloneStableClaims(combat);
  stableClaims = migrateCurrentRoundClaims(combat, stableClaims);
  const round = String(combat.round);
  stableClaims[round] ??= {};
  if (stableClaims[round][slotKey]) return false;
  stableClaims[round][slotKey] = chosen.id;

  await persistClaims(combat, stableClaims);
  return true;
}

async function claimSlot(combat, slotIndex) {
  const origin = slotOriginAt(combat, slotIndex);
  if (!origin) return;

  const side = dispositionSide(origin);
  const target = resolveClaimTarget(combat, side, slotIndex);
  if (!target) return;

  const { combatant: chosen, tokenId, sceneId } = target;
  if (game.user.isGM) {
    const claimed = await performClaim(combat, slotIndex, chosen, game.user, { tokenId, sceneId });
    if (!claimed) ui.notifications.warn("The slot could not be claimed. It may already have been claimed or the encounter changed.");
  } else {
    requestGM({
      type: "claim",
      combatId: combat.id,
      round: combat.round,
      slotIndex,
      slotKey: slotKeyAt(combat, slotIndex),
      combatantId: chosen.id,
      tokenId,
      sceneId
    });
  }
}

async function performRevoke(combat, slotIndex, requester) {
  const claimant = claimantForSlot(combat, slotIndex);
  if (!claimant) return false;
  if (!requester?.isGM && !userOwnsCombatant(requester, claimant)) return false;

  // Players may correct their current/future claim, but cannot erase a slot
  // that has already passed and thereby become eligible to act twice.
  if (!requester?.isGM && combat.turn != null && slotIndex < combat.turn) return false;

  const slotKey = slotKeyAt(combat, slotIndex);
  if (!slotKey) return false;

  let stableClaims = cloneStableClaims(combat);
  stableClaims = migrateCurrentRoundClaims(combat, stableClaims);
  const round = String(combat.round);
  stableClaims[round] ??= {};
  delete stableClaims[round][slotKey];

  await persistClaims(combat, stableClaims);
  return true;
}

async function revokeSlot(combat, slotIndex) {
  const claimant = claimantForSlot(combat, slotIndex);
  if (!claimant) return;

  if (!game.user.isGM && !userOwnsCombatant(game.user, claimant)) return;
  if (!game.user.isGM && combat.turn != null && slotIndex < combat.turn) {
    ui.notifications.warn("You cannot unclaim a slot that has already passed this round.");
    return;
  }

  if (game.user.isGM) {
    await performRevoke(combat, slotIndex, game.user);
  } else {
    requestGM({
      type: "revoke",
      combatId: combat.id,
      round: combat.round,
      slotIndex,
      slotKey: slotKeyAt(combat, slotIndex)
    });
  }
}

function applyClaimedIdentity(row, claimant, slotSide) {
  // Let tracker row interactions (hover, ping, token selection, ownership checks)
  // target the claimant. Slot origin/order is maintained separately in the
  // Combat patch and is not derived from this presentation-only DOM change.
  if (claimant?.id) row.dataset.combatantId = claimant.id;

  const name = findNameElement(row);
  if (name) {
    name.textContent = claimant ? visibleCombatantName(claimant) : `${SIDE_META[slotSide].label} Slot`;
    if (claimant) name.title = visibleCombatantName(claimant);
  }

  const img = findImageElement(row);
  if (img) {
    if (claimant?.img) {
      img.src = claimant.img;
      img.classList.remove("gis-slot-image");
    } else {
      img.classList.add("gis-slot-image");
    }
  }
}

function setSlotInitiativeDisplay(row, slot) {
  const value = formatInitiative(slot?.initiative);
  for (const el of row.querySelectorAll(".token-initiative, .combatant-initiative")) {
    el.textContent = value;
    el.title = "Initiative slot result";
  }
}

function addSlotBadge(row, side, claimant) {
  let badge = row.querySelector(":scope > .gis-slot-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "gis-slot-badge";
    row.prepend(badge);
  }

  badge.classList.remove("gis-pc", "gis-neutral", "gis-npc");
  badge.classList.add(`gis-${SIDE_META[side].className}`);
  badge.textContent = claimant
    ? `${SIDE_META[side].label} · ${visibleCombatantName(claimant)}`
    : `${SIDE_META[side].label} SLOT`;
}

function addSideRevealControl(row, claimant, side) {
  row.querySelectorAll(".gis-reveal-side-name").forEach((e) => e.remove());
  if (!game.user.isGM || !["npc", "neutral"].includes(side) || !claimant) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "gis-reveal-side-name";
  const revealed = sideNameRevealed(claimant);
  const label = SIDE_META[side]?.label ?? "NPC";
  button.innerHTML = `<i class="fa-solid ${revealed ? "fa-eye" : "fa-eye-slash"}"></i>`;
  button.title = revealed ? `Hide this ${label} name from players` : `Reveal this ${label} name to all players`;
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await toggleSideNameReveal(claimant);
  });
  findControlsContainer(row).append(button);
}

function addTrackerStatuses(row, claimant) {
  row.querySelectorAll(".gis-tracker-statuses").forEach((e) => e.remove());
  if (!claimant) return;
  const statuses = makeStatusRow(claimant, "gis-tracker-statuses");
  if (!statuses) return;
  const target = row.querySelector(".token-name, .combatant-name") ?? findControlsContainer(row);
  target.append(statuses);
}

function addClaimControl(row, combat, slotIndex, side, claimant) {
  row.querySelectorAll(".gis-claim-button, .gis-revoke-button").forEach((e) => e.remove());
  const controls = findControlsContainer(row);

  if (!claimant && userHasEligibleCombatant(combat, side, slotIndex)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gis-claim-button";
    button.textContent = "Claim";
    button.title = `Claim this ${SIDE_META[side].label} slot with the selected token`;
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await claimSlot(combat, slotIndex);
    });
    controls.append(button);
    return;
  }

  if (claimant) {
    const canRevoke = game.user.isGM || (
      userOwnsCombatant(game.user, claimant) && (combat.turn == null || slotIndex >= combat.turn)
    );
    if (!canRevoke) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "gis-revoke-button";
    button.textContent = "Unclaim";
    button.title = game.user.isGM ? "Clear this slot claim" : "Release your slot claim";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await revokeSlot(combat, slotIndex);
    });
    controls.append(button);
  }
}

function addPendingInitiativeControl(row, combat, combatant, side, activationId = -1) {
  row.querySelectorAll(".gis-claim-button, .gis-revoke-button, .gis-pending-roll").forEach((e) => e.remove());
  hideNativeInitiativeRoll(row);
  hideNativeInitiativeValue(row);

  const controls = findControlsContainer(row);
  const wrap = document.createElement("span");
  wrap.className = "gis-pending-roll";

  const select = document.createElement("select");
  select.className = "gis-skill-select";
  select.setAttribute("aria-label", "Initiative skill");

  const vigilance = resolveInitiativeSkill(combatant.actor, "vigilance");
  const cool = resolveInitiativeSkill(combatant.actor, "cool");
  for (const resolved of [vigilance, cool]) {
    const option = document.createElement("option");
    option.value = resolved.role;
    option.textContent = resolved.skillName;
    select.append(option);
  }

  select.value = getChoice(combat, combatant);
  select.addEventListener("change", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setChoice(combat, combatant, event.currentTarget.value);
  });
  select.addEventListener("click", (event) => event.stopPropagation());

  const button = document.createElement("button");
  button.type = "button";
  button.className = "gis-roll-button";
  button.textContent = "Roll";
  button.title = `Roll ${SIDE_META[side].label} initiative`;
  button.disabled = !userOwnsCombatant(game.user, combatant);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await rollInitiative(combat, combatant, getChoice(combat, combatant), { activationId });
  });

  wrap.append(select, button);
  controls.append(wrap);
}

function addPendingCombatantUI(row, combat, slot, side) {
  const origin = slot.origin;
  row.classList.remove("gis-pc-slot", "gis-neutral-slot", "gis-npc-slot", "gis-slot-claimed");
  row.classList.add("gis-slot-row", "gis-pending-slot", `gis-${side}-slot`);

  let badge = row.querySelector(":scope > .gis-slot-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "gis-slot-badge";
    row.prepend(badge);
  }
  badge.classList.remove("gis-pc", "gis-neutral", "gis-npc");
  badge.classList.add(`gis-${SIDE_META[side].className}`);
  badge.textContent = `${SIDE_META[side].label} · ROLL INITIATIVE`;

  // A pending hostile/neutral activation still follows the same identity
  // privacy rules as every other combat entry. The GM may reveal it explicitly.
  if (sideUsesHiddenIdentity(origin)) {
    const name = findNameElement(row);
    if (name) {
      name.textContent = visibleCombatantName(origin);
      name.title = visibleCombatantName(origin);
    }
    addSideRevealControl(row, origin, side);
  }

  setSlotInitiativeDisplay(row, slot);
  addPendingInitiativeControl(row, combat, origin, side, slot.activationId);
}

function addSlotUI(root, combat) {
  const rows = findRows(root);
  const slots = slotDescriptors(combat);

  rows.forEach((row, slotIndex) => {
    const slot = slots[slotIndex];
    const origin = slot?.origin;
    if (!origin) return;

    const side = dispositionSide(origin);

    // An extra activation with no initiative is pending even though its origin
    // combatant may already have rolled a normal initiative value.
    if (slot.initiative === null || slot.initiative === undefined) {
      addPendingCombatantUI(row, combat, slot, side);
      return;
    }

    const claimant = claimantForSlot(combat, slotIndex);

    row.classList.remove("gis-pc-slot", "gis-neutral-slot", "gis-npc-slot", "gis-pending-slot");
    row.classList.add("gis-slot-row", `gis-${side}-slot`);
    row.classList.toggle("gis-slot-claimed", Boolean(claimant));
    row.classList.toggle("gis-slot-defeated", Boolean(claimant && combatantDefeated(claimant)));
    addSlotBadge(row, side, claimant);
    applyClaimedIdentity(row, claimant, side);
    setSlotInitiativeDisplay(row, slot);
    addTrackerStatuses(row, claimant);
    addSideRevealControl(row, claimant, side);
    addClaimControl(row, combat, slotIndex, side, claimant);
  });
}

function addPlayerEndTurn(root, combat) {
  if (game.user.isGM || !combat.started || combat.turn == null) return;
  const claimant = claimantForSlot(combat, combat.turn);
  if (!claimant || !userOwnsCombatant(game.user, claimant)) return;

  if (root.querySelector(".gis-end-turn")) return;
  const footer = root.querySelector("footer, .combat-tracker-footer, .encounter-controls") ?? root;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gis-end-turn";
  button.textContent = "End Turn";
  button.title = "Pass the active initiative slot to the next slot";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    requestGM({
      type: "advance",
      combatId: combat.id,
      round: combat.round,
      turn: combat.turn,
      slotKey: slotKeyAt(combat, combat.turn)
    });
  });
  footer.append(button);
}

function enhanceTracker(app, html) {
  if (game.system.id !== "genesys") return;
  const root = rootElement(html);
  if (!root) return;

  const combat = app?.viewed ?? ui.combat?.viewed ?? game.combat;
  if (!combat) return;

  if (combat.started) {
    ensureEffectiveTurns(combat);
    addSlotUI(root, combat);
  } else {
    addPreparationControls(root, combat);
  }
  addPlayerEndTurn(root, combat);
}

// ---------------------------------------------------------------------------
// Carousel UI
// ---------------------------------------------------------------------------

function carouselEnabled() {
  try {
    return Boolean(game.settings.get(MODULE_ID, "enableCarousel"));
  } catch {
    return false;
  }
}

function carouselScale() {
  try {
    const value = Number(game.settings.get(MODULE_ID, "carouselScale") ?? 100);
    return Math.max(60, Math.min(120, Number.isFinite(value) ? value : 100));
  } catch {
    return 100;
  }
}

function carouselRoundStateKey(combat) {
  return `${combat.id}:${combat.round ?? 0}`;
}

function carouselDisplayMode(combat) {
  if (!combat?.started) return "expanded";
  return carouselCollapseAllState.get(carouselRoundStateKey(combat)) ?? "auto";
}

function carouselSlotExpanded(combat, slotIndex) {
  if (!combat?.started) return true;
  const mode = carouselDisplayMode(combat);
  if (mode === "collapsed") return false;
  if (mode === "expanded") return true;
  return combat.turn === slotIndex;
}

function setCarouselSlotExpanded(combat, slotIndex, expanded) {
  if (!combat?.started || combat.turn !== slotIndex) return;
  // Opening a manually-collapsed active card returns to the normal mode:
  // only the current slot is expanded. Closing it collapses every card.
  carouselCollapseAllState.set(carouselRoundStateKey(combat), expanded ? "auto" : "collapsed");
}

function collapseAllCarouselSlots(combat) {
  if (!combat?.started) return;
  carouselCollapseAllState.set(carouselRoundStateKey(combat), "collapsed");
}

function expandAllCarouselSlots(combat) {
  if (!combat?.started) return;
  carouselCollapseAllState.set(carouselRoundStateKey(combat), "expanded");
}

function orderedPreCombatants(combat) {
  if (!combat) return [];
  const current = Array.from(combat.combatants ?? []);
  const byId = new Map(current.map((combatant) => [combatant.id, combatant]));
  let order = Array.from(carouselPreCombatOrder.get(combat.id) ?? []);

  order = order.filter((id) => byId.has(id));
  const known = new Set(order);
  for (const combatant of current) {
    if (known.has(combatant.id)) continue;
    order.push(combatant.id);
    known.add(combatant.id);
  }

  carouselPreCombatOrder.set(combat.id, order);
  return order.map((id) => byId.get(id)).filter(Boolean);
}

function clearCarouselState(combatId) {
  for (const key of [...carouselCollapseAllState.keys()]) {
    if (key.startsWith(`${combatId}:`)) carouselCollapseAllState.delete(key);
  }
  carouselPreCombatOrder.delete(combatId);
}

function removeCarousel() {
  document.getElementById(CAROUSEL_ID)?.remove();
}

function scheduleCarouselRender(delay = 25) {
  if (carouselRenderTimer) clearTimeout(carouselRenderTimer);
  carouselRenderTimer = setTimeout(() => {
    carouselRenderTimer = null;
    try {
      renderCarousel();
    } catch (err) {
      console.error(`${MODULE_ID} | Carousel render failed`, err);
    }
  }, delay);
}

function dataPath(object, path) {
  try {
    return foundry.utils.getProperty(object, path);
  } catch {
    return undefined;
  }
}

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function numericFromNode(node, preferred = ["adjusted", "total", "value", "current", "base"]) {
  const direct = finiteNumber(node);
  if (direct !== undefined) return direct;
  if (!node || typeof node !== "object") return undefined;
  for (const key of preferred) {
    const value = finiteNumber(node[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstNumericAt(system, paths, preferred) {
  for (const path of paths) {
    const value = numericFromNode(dataPath(system, path), preferred);
    if (value !== undefined) return value;
  }
  return undefined;
}

function findNodeByKey(root, wantedKeys, maxDepth = 5) {
  if (!root || typeof root !== "object") return undefined;
  const wanted = new Set(wantedKeys.map((k) => normalizeName(k).replace(/[^a-zа-яіїєґ0-9]/gi, "")));
  const queue = [{ value: root, depth: 0 }];
  const seen = new WeakSet();

  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeName(key).replace(/[^a-zа-яіїєґ0-9]/gi, "");
      if (wanted.has(normalized)) return child;
      if (depth < maxDepth && child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return undefined;
}

function resourceFromSystem(system, kind) {
  const isWounds = kind === "wounds";
  const key = isWounds ? "wounds" : "strain";
  const thresholdKey = isWounds ? "woundThreshold" : "strainThreshold";

  const currentPaths = [
    `stats.${key}.value`, `stats.${key}.current`, `stats.${key}.used`,
    `${key}.value`, `${key}.current`, `${key}.used`,
    `attributes.${key}.value`, `attributes.${key}.current`,
    `health.${key}.value`, `health.${key}.current`
  ];
  const maxPaths = [
    `stats.${key}.threshold`, `stats.${key}.max`, `stats.${key}.maximum`,
    `stats.${thresholdKey}.value`, `stats.${thresholdKey}.adjusted`, `stats.${thresholdKey}`,
    `${key}.threshold`, `${key}.max`, `${key}.maximum`,
    `${thresholdKey}.value`, `${thresholdKey}.adjusted`, `${thresholdKey}`,
    `attributes.${key}.threshold`, `attributes.${key}.max`
  ];

  let current = firstNumericAt(system, currentPaths, ["value", "current", "used", "adjusted", "total"]);
  let max = firstNumericAt(system, maxPaths, ["value", "adjusted", "total", "max", "threshold"]);

  const resourceNode = findNodeByKey(system, [key]);
  if (current === undefined && resourceNode !== undefined) {
    current = numericFromNode(resourceNode, ["value", "current", "used", "adjusted", "total"]);
  }
  if (max === undefined && resourceNode && typeof resourceNode === "object") {
    max = numericFromNode(resourceNode, ["threshold", "max", "maximum"]);
  }

  const thresholdNode = findNodeByKey(system, [thresholdKey]);
  if (max === undefined && thresholdNode !== undefined) {
    max = numericFromNode(thresholdNode, ["adjusted", "total", "value", "max"]);
  }

  if (current === undefined && max === undefined) return null;
  return {
    current: Math.max(0, current ?? 0),
    max: max !== undefined ? Math.max(0, max) : undefined
  };
}

function defenseFromSystem(system) {
  let melee = firstNumericAt(system, [
    "stats.defense.melee", "stats.defence.melee", "defense.melee", "defence.melee",
    "stats.meleeDefense", "stats.meleeDefence", "meleeDefense", "meleeDefence",
    "stats.defenseMelee", "stats.defenceMelee", "defenseMelee", "defenceMelee"
  ], ["adjusted", "total", "value", "current", "base"]);
  let ranged = firstNumericAt(system, [
    "stats.defense.ranged", "stats.defence.ranged", "defense.ranged", "defence.ranged",
    "stats.rangedDefense", "stats.rangedDefence", "rangedDefense", "rangedDefence",
    "stats.defenseRanged", "stats.defenceRanged", "defenseRanged", "defenceRanged"
  ], ["adjusted", "total", "value", "current", "base"]);

  const node = findNodeByKey(system, ["defense", "defence"]);
  if (node && typeof node === "object") {
    if (melee === undefined) melee = numericFromNode(node.melee, ["adjusted", "total", "value", "current", "base"]);
    if (ranged === undefined) ranged = numericFromNode(node.ranged, ["adjusted", "total", "value", "current", "base"]);
  }

  if (melee === undefined && ranged === undefined && node !== undefined) {
    const single = numericFromNode(node, ["adjusted", "total", "value", "current", "base"]);
    if (single !== undefined) melee = ranged = single;
  }

  if (melee === undefined && ranged === undefined) return null;
  return { melee: melee ?? 0, ranged: ranged ?? 0 };
}

function itemSystem(item) {
  return item?.system ?? item?.systemData ?? {};
}

function itemIsEquipped(item) {
  const system = itemSystem(item);
  const state = normalizeName(system.state ?? system.equipped ?? system.status);
  if (typeof system.equipped === "boolean") return system.equipped;
  return state === "equipped" || state === "worn" || state === "active";
}

function itemQualityRating(quality) {
  if (!quality) return 0;
  const raw = quality.rating ?? quality.value ?? quality.rank;
  const rating = finiteNumber(raw) ?? numericFromNode(raw, ["adjusted", "total", "value", "current", "base"]);
  if (rating !== undefined) return Math.max(0, rating);
  return 1;
}

function qualityMatches(name, kind) {
  const normalized = normalizeName(name);
  if (kind === "defensive") {
    return normalized.includes("defensive") ||
      normalized.includes("захисн") ||
      normalized.includes("оборонн");
  }
  return normalized.includes("deflection") ||
    normalized.includes("відбит") ||
    normalized.includes("відхил");
}

function characteristicValue(system, characteristic) {
  return numericFromNode(
    dataPath(system, `characteristics.${characteristic}`),
    ["adjusted", "total", "value", "current", "base"]
  ) ?? 0;
}

function calculatedEquipmentStats(actor, system) {
  // Genesys 0.2.19 keeps Wounds/Strain directly on the actor, but the sheet's
  // displayed Soak/Defense are derived from Brawn and equipped Items. Reading
  // only actor.system can therefore return unmodified base values.
  let soak = characteristicValue(system, "brawn");
  let melee = 0;
  let ranged = 0;

  // Preserve any explicit actor-level bonuses if a world/module stores them.
  const actorSoak = firstNumericAt(system, [
    "stats.soak.bonus", "soak.bonus", "attributes.soak.bonus"
  ], ["adjusted", "total", "value", "current", "base"]);
  soak += actorSoak ?? 0;

  const actorDefense = defenseFromSystem(system);
  if (actorDefense) {
    melee += actorDefense.melee ?? 0;
    ranged += actorDefense.ranged ?? 0;
  }

  for (const item of actor?.items ?? []) {
    if (!itemIsEquipped(item)) continue;
    const itemData = itemSystem(item);

    // Armor contributes its soak and its general defense to both bands.
    if (["armor", "armour"].includes(normalizeName(item.type))) {
      soak += finiteNumber(itemData.soak) ?? numericFromNode(itemData.soak, ["adjusted", "total", "value", "base"]) ?? 0;
      const armorDefense = finiteNumber(itemData.defense ?? itemData.defence) ??
        numericFromNode(itemData.defense ?? itemData.defence, ["adjusted", "total", "value", "base"]) ?? 0;
      melee += armorDefense;
      ranged += armorDefense;
    }

    // Equipped weapons/shields/armor can carry Defensive or Deflection.
    for (const quality of itemData.qualities ?? []) {
      const qName = quality?.name ?? quality?.label ?? "";
      const rating = itemQualityRating(quality);
      if (qualityMatches(qName, "defensive")) melee += rating;
      if (qualityMatches(qName, "deflection")) ranged += rating;
    }
  }

  return {
    soak: Math.max(0, soak),
    defense: { melee: Math.max(0, melee), ranged: Math.max(0, ranged) }
  };
}

function explicitDerivedSoak(system) {
  return firstNumericAt(system, [
    "stats.soak.adjusted", "stats.soak.total",
    "soak.adjusted", "soak.total",
    "attributes.soak.adjusted", "attributes.soak.total"
  ], ["adjusted", "total"]);
}

function explicitDerivedDefense(system) {
  const melee = firstNumericAt(system, [
    "stats.defense.melee.adjusted", "stats.defense.melee.total",
    "stats.defence.melee.adjusted", "stats.defence.melee.total",
    "defense.melee.adjusted", "defense.melee.total",
    "defence.melee.adjusted", "defence.melee.total"
  ], ["adjusted", "total"]);
  const ranged = firstNumericAt(system, [
    "stats.defense.ranged.adjusted", "stats.defense.ranged.total",
    "stats.defence.ranged.adjusted", "stats.defence.ranged.total",
    "defense.ranged.adjusted", "defense.ranged.total",
    "defence.ranged.adjusted", "defence.ranged.total"
  ], ["adjusted", "total"]);
  if (melee === undefined && ranged === undefined) return null;
  return { melee: melee ?? 0, ranged: ranged ?? 0 };
}

function actorCarouselStats(actor) {
  if (!actor) return { soak: undefined, defense: null, wounds: null, strain: null };
  const system = actor.system ?? actor.systemData ?? {};
  const calculated = calculatedEquipmentStats(actor, system);

  // Prefer explicitly marked derived totals when a system/module supplies
  // them; otherwise use the same Genesys ingredients the character sheet uses.
  const soak = explicitDerivedSoak(system) ?? calculated.soak;
  const defense = explicitDerivedDefense(system) ?? calculated.defense;

  return {
    soak,
    defense,
    wounds: resourceFromSystem(system, "wounds"),
    strain: resourceFromSystem(system, "strain")
  };
}

function resourcePercent(resource) {
  if (!resource?.max || resource.max <= 0) return 0;
  return Math.max(0, Math.min(100, (Number(resource.current ?? 0) / Number(resource.max)) * 100));
}

function makeResourceBar(label, resource, kind, { privateValues = false } = {}) {
  if (!resource) return null;
  const wrap = document.createElement("div");
  wrap.className = `gis-carousel-resource gis-carousel-${kind}${privateValues ? " gis-carousel-resource-private" : ""}`;
  const maxText = resource.max !== undefined ? resource.max : "?";
  const over = resource.max !== undefined && resource.current > resource.max;
  if (over && !privateValues) wrap.classList.add("gis-resource-over");

  if (!privateValues) {
    wrap.innerHTML = `
      <div class="gis-carousel-resource-label"><span>${label}</span><strong>${resource.current}/${maxText}</strong></div>
      <div class="gis-carousel-bar" title="${label}"><span style="width:${resourcePercent(resource)}%"></span></div>
    `;
  } else {
    wrap.innerHTML = `<div class="gis-carousel-bar" title="${label}"><span style="width:${resourcePercent(resource)}%"></span></div>`;
  }
  return wrap;
}

function makeStatsBlock(combatant) {
  const actor = combatant?.actor;
  const stats = actorCarouselStats(actor);
  const wrap = document.createElement("div");
  wrap.className = "gis-carousel-stats";

  const privateNpc = sideUsesHiddenIdentity(combatant) && !game.user.isGM;

  if (!privateNpc) {
    const compact = document.createElement("div");
    compact.className = "gis-carousel-compact-stats";
    if (stats.soak !== undefined) {
      const el = document.createElement("span");
      el.innerHTML = `<b>Soak</b> ${stats.soak}`;
      compact.append(el);
    }
    if (stats.defense) {
      const el = document.createElement("span");
      el.innerHTML = `<b>Def R/M</b> ${stats.defense.ranged}/${stats.defense.melee}`;
      compact.append(el);
    }
    if (compact.children.length) wrap.append(compact);
  }

  const wounds = makeResourceBar("Wounds", stats.wounds, "wounds", { privateValues: privateNpc });
  const strain = makeResourceBar("Strain", stats.strain, "strain", { privateValues: privateNpc });
  if (wounds) wrap.append(wounds);
  if (strain) wrap.append(strain);

  const statuses = makeStatusRow(combatant);
  if (statuses) wrap.append(statuses);

  return wrap;
}

function canRevokeSlot(combat, slotIndex, claimant) {
  if (!claimant) return false;
  if (game.user.isGM) return true;
  return userOwnsCombatant(game.user, claimant) && (combat.turn == null || slotIndex >= combat.turn);
}

function canEndCurrentSlot(combat, slotIndex, claimant) {
  if (!combat?.started || combat.turn !== slotIndex || !claimant) return false;
  return game.user.isGM || userOwnsCombatant(game.user, claimant);
}

function makeCarouselButton(text, className, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `gis-carousel-button ${className ?? ""}`.trim();
  button.textContent = text;
  if (title) button.title = title;
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await onClick?.(event);
    } catch (err) {
      console.error(`${MODULE_ID} | Carousel action failed`, err);
      ui.notifications.error("Genesys Initiative Slots: carousel action failed. Check the console for details.");
    }
  });
  return button;
}

function makeSideRevealCarouselButton(combatant) {
  if (!game.user.isGM || !combatant || !sideUsesHiddenIdentity(combatant)) return null;
  const side = dispositionSide(combatant);
  const label = SIDE_META[side]?.label ?? "NPC";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gis-carousel-toggle gis-carousel-reveal-name";
  const revealed = sideNameRevealed(combatant);
  button.innerHTML = `<i class="fa-solid ${revealed ? "fa-eye" : "fa-eye-slash"}"></i>`;
  button.title = revealed ? `Hide this ${label} name from players` : `Reveal this ${label} name to all players`;
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await toggleSideNameReveal(combatant);
  });
  return button;
}

function combatantToken(combatant) {
  if (!combatant?.tokenId || !canvas?.ready) return null;
  return canvas.tokens?.get(combatant.tokenId) ?? null;
}

function bindActorCardInteractions(card, combatant) {
  if (!combatant) return;
  card.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, select")) return;
    event.preventDefault();
    event.stopPropagation();
    combatant.actor?.sheet?.render?.(true);
  });
  card.querySelector(".gis-carousel-portrait")?.addEventListener("click", async (event) => {
    if (event.target.closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    const token = combatantToken(combatant);
    if (!token) return;
    try {
      await token.control({ releaseOthers: true });
    } catch {
      token.control?.({ releaseOthers: true });
    }
  });
}

function makeSkillSelect(combat, combatant) {
  const select = document.createElement("select");
  select.className = "gis-carousel-skill-select";
  select.setAttribute("aria-label", "Initiative skill");
  const vigilance = resolveInitiativeSkill(combatant.actor, "vigilance");
  const cool = resolveInitiativeSkill(combatant.actor, "cool");
  for (const resolved of [vigilance, cool]) {
    const option = document.createElement("option");
    option.value = resolved.role;
    option.textContent = resolved.skillName;
    select.append(option);
  }
  select.value = getChoice(combat, combatant);
  select.addEventListener("change", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setChoice(combat, combatant, event.currentTarget.value);
  });
  select.addEventListener("click", (event) => event.stopPropagation());
  return select;
}

function makeCarouselIdentity(combatant) {
  const identity = document.createElement("div");
  identity.className = "gis-carousel-identity";

  const img = document.createElement("img");
  img.className = "gis-carousel-portrait";
  img.src = combatant.img ?? combatant.actor?.img ?? "icons/svg/mystery-man.svg";
  img.alt = "";

  const name = document.createElement("div");
  name.className = "gis-carousel-name";
  name.textContent = visibleCombatantName(combatant);
  name.title = name.textContent;

  identity.append(img, name);
  return identity;
}

function makeActorCarouselCard(combat, combatant, { preCombat = false, pending = false, activationId = -1, initiativeOverride } = {}) {
  const side = dispositionSide(combatant);
  const meta = SIDE_META[side];
  const card = document.createElement("article");
  card.className = `gis-carousel-card gis-carousel-${meta.className}`;
  card.classList.toggle("gis-carousel-defeated", combatantDefeated(combatant));

  const initiativeValue = initiativeOverride !== undefined ? initiativeOverride : combatant.initiative;
  const initiative = formatInitiative(initiativeValue);

  const actorHead = document.createElement("div");
  actorHead.className = "gis-carousel-card-head";
  const sideLabel = document.createElement("span");
  sideLabel.className = "gis-carousel-side";
  sideLabel.textContent = `${meta.label}${pending ? " · ROLL" : ""}`;
  const init = document.createElement("span");
  init.className = "gis-carousel-init";
  init.textContent = initiative;
  actorHead.append(sideLabel, init);

  if (combatantDefeated(combatant)) {
    const defeated = document.createElement("span");
    defeated.className = "gis-carousel-defeated-badge";
    defeated.textContent = "DEFEATED";
    defeated.title = "Marked Defeated";
    actorHead.append(defeated);
  }
  if (game.user.isGM && ["npc", "neutral"].includes(side)) {
    const reveal = makeSideRevealCarouselButton(combatant);
    if (reveal) actorHead.append(reveal);
  }

  card.append(actorHead, makeCarouselIdentity(combatant), makeStatsBlock(combatant));
  const actions = document.createElement("div");
  actions.className = "gis-carousel-actions";

  if ((preCombat || pending) && initiativeValue == null) {
    actions.append(makeSkillSelect(combat, combatant));
    const roll = makeCarouselButton("Roll", "gis-carousel-primary", "Roll initiative", async () => {
      await rollInitiative(combat, combatant, getChoice(combat, combatant), { activationId });
      scheduleCarouselRender();
    });
    roll.disabled = !userOwnsCombatant(game.user, combatant);
    actions.append(roll);
  } else if (preCombat && initiativeValue != null) {
    const rolled = document.createElement("span");
    rolled.className = "gis-carousel-rolled";
    rolled.textContent = `Rolled ${initiative}`;
    actions.append(rolled);
  }

  if (actions.children.length) card.append(actions);
  bindActorCardInteractions(card, combatant);
  return card;
}

function makeSlotCarouselCard(combat, slot, slotIndex) {
  const origin = slot.origin;
  const side = dispositionSide(origin);
  const meta = SIDE_META[side];
  const claimant = claimantForSlot(combat, slotIndex);
  const pending = slot.initiative == null;

  if (pending) {
    return makeActorCarouselCard(combat, origin, {
      pending: true,
      activationId: slot.activationId,
      initiativeOverride: slot.initiative
    });
  }

  const active = combat.turn === slotIndex;
  const expanded = carouselSlotExpanded(combat, slotIndex);

  const card = document.createElement("article");
  card.className = `gis-carousel-card gis-carousel-slot gis-carousel-${meta.className}`;
  card.classList.toggle("gis-carousel-active", active);
  card.classList.toggle("gis-carousel-claimed", Boolean(claimant));
  card.classList.toggle("gis-carousel-defeated", Boolean(claimant && combatantDefeated(claimant)));
  card.classList.toggle("gis-carousel-expanded", expanded);
  card.classList.toggle("gis-carousel-compact", !expanded);

  const head = document.createElement("div");
  head.className = "gis-carousel-card-head";
  const sideLabel = document.createElement("span");
  sideLabel.className = "gis-carousel-side";
  sideLabel.textContent = `${meta.label} SLOT`;
  const init = document.createElement("span");
  init.className = "gis-carousel-init";
  init.textContent = formatInitiative(slot.initiative);
  head.append(sideLabel, init);

  if (claimant && combatantDefeated(claimant)) {
    const defeated = document.createElement("span");
    defeated.className = "gis-carousel-defeated-badge";
    defeated.textContent = "DEFEATED";
    defeated.title = "Marked Defeated";
    head.append(defeated);
  }

  if (active) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "gis-carousel-toggle";
    toggle.textContent = expanded ? "▴" : "▾";
    toggle.title = expanded ? "Collapse active slot details" : "Expand active slot details";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setCarouselSlotExpanded(combat, slotIndex, !expanded);
      scheduleCarouselRender(0);
    });
    head.append(toggle);
  }
  if (game.user.isGM && ["npc", "neutral"].includes(side) && claimant) {
    const reveal = makeSideRevealCarouselButton(claimant);
    if (reveal) head.append(reveal);
  }
  card.append(head);

  if (!expanded) {
    if (claimant) {
      card.append(makeCarouselIdentity(claimant));
      bindActorCardInteractions(card, claimant);
    }

    if (active) {
      card.addEventListener("click", (event) => {
        if (event.target.closest("button, select, .gis-carousel-portrait")) return;
        event.preventDefault();
        event.stopPropagation();
        setCarouselSlotExpanded(combat, slotIndex, true);
        scheduleCarouselRender(0);
      });
    }
    return card;
  }

  if (claimant) {
    card.append(makeCarouselIdentity(claimant), makeStatsBlock(claimant));
    bindActorCardInteractions(card, claimant);
  } else {
    const empty = document.createElement("div");
    empty.className = "gis-carousel-empty-slot";
    const glyph = document.createElement("div");
    glyph.className = "gis-carousel-slot-glyph";
    glyph.textContent = meta.label;
    const label = document.createElement("strong");
    label.textContent = `${meta.label} Slot`;
    empty.append(glyph, label);
    card.append(empty);
  }

  const actions = document.createElement("div");
  actions.className = "gis-carousel-actions";

  if (!claimant && userHasEligibleCombatant(combat, side, slotIndex)) {
    actions.append(makeCarouselButton("Claim", "gis-carousel-primary", `Claim this ${meta.label} slot with the selected token`, async () => {
      await claimSlot(combat, slotIndex);
      scheduleCarouselRender();
    }));
  }

  if (claimant && canRevokeSlot(combat, slotIndex, claimant)) {
    actions.append(makeCarouselButton("Unclaim", "", "Release this slot claim", async () => {
      await revokeSlot(combat, slotIndex);
      scheduleCarouselRender();
    }));
  }

  if (claimant && canEndCurrentSlot(combat, slotIndex, claimant)) {
    actions.append(makeCarouselButton("End Turn", "gis-carousel-primary", "Pass to the next initiative slot", async () => {
      if (game.user.isGM) {
        await combat.nextTurn();
        broadcastRefresh(combat.id);
      } else {
        requestGM({
          type: "advance",
          combatId: combat.id,
          round: combat.round,
          turn: combat.turn,
          slotKey: slotKeyAt(combat, combat.turn)
        });
      }
    }));
  }

  if (actions.children.length) card.append(actions);
  return card;
}

async function carouselPrevious(combat) {
  if (!game.user.isGM || !combat?.started) return;
  if (typeof combat.previousTurn === "function") await combat.previousTurn();
  else if (combat.turn > 0) await combat.update({ turn: combat.turn - 1 });
  broadcastRefresh(combat.id);
}

async function carouselNext(combat) {
  if (!game.user.isGM || !combat?.started) return;
  await combat.nextTurn();
  broadcastRefresh(combat.id);
}

function makeCarouselHeader(combat) {
  const header = document.createElement("header");
  header.className = "gis-carousel-header";

  const status = document.createElement("div");
  status.className = "gis-carousel-status";
  status.textContent = combat.started ? `Round ${combat.round}` : "Initiative";
  header.append(status);

  const controls = document.createElement("div");
  controls.className = "gis-carousel-header-actions";

  // Collapse/Expand All is presentation-only and therefore available to every client.
  if (combat.started) {
    const mode = carouselDisplayMode(combat);
    if (mode === "collapsed") {
      controls.append(makeCarouselButton("Expand All", "gis-carousel-collapse-all", "Expand every initiative card on this client", async () => {
        expandAllCarouselSlots(combat);
        scheduleCarouselRender(0);
      }));
    } else {
      controls.append(makeCarouselButton("Collapse All", "gis-carousel-collapse-all", "Collapse every initiative card on this client", async () => {
        collapseAllCarouselSlots(combat);
        scheduleCarouselRender(0);
      }));
    }
  }

  if (game.user.isGM) {
    if (!combat.started) {
      controls.append(makeCarouselButton("Begin Encounter", "gis-carousel-primary", "Start the encounter", async () => {
        await combat.startCombat();
        broadcastRefresh(combat.id);
      }));
    } else {
      controls.append(
        makeCarouselButton("‹", "gis-carousel-nav", "Previous slot", async () => carouselPrevious(combat)),
        makeCarouselButton("›", "gis-carousel-nav", "Next slot", async () => carouselNext(combat)),
        makeCarouselButton("End Encounter", "", "End the encounter", async () => {
          await combat.endCombat();
          broadcastRefresh(combat.id);
        })
      );
    }
  }

  const hide = makeCarouselButton("×", "gis-carousel-hide", "Hide carousel on this client", async () => {
    await game.settings.set(MODULE_ID, "enableCarousel", false);
    removeCarousel();
  });
  controls.append(hide);
  header.append(controls);
  return header;
}

function carouselCombat() {
  return ui.combat?.viewed ?? game.combat ?? null;
}

function renderCarousel() {
  if (game.system.id !== "genesys") return;
  if (!carouselEnabled()) {
    removeCarousel();
    return;
  }

  const combat = carouselCombat();
  if (!combat) {
    removeCarousel();
    return;
  }

  if (combat.started) ensureEffectiveTurns(combat);

  let shell = document.getElementById(CAROUSEL_ID);
  if (!shell) {
    shell = document.createElement("section");
    shell.id = CAROUSEL_ID;
    shell.className = "gis-carousel-shell";
    shell.setAttribute("aria-label", "Genesys Initiative Carousel");
    document.body.append(shell);
  }

  shell.style.setProperty("--gis-carousel-scale", String(carouselScale() / 100));
  shell.replaceChildren();
  shell.append(makeCarouselHeader(combat));

  const viewport = document.createElement("div");
  viewport.className = "gis-carousel-viewport";
  const track = document.createElement("div");
  track.className = "gis-carousel-track";

  if (combat.started) {
    const slots = slotDescriptors(combat);
    slots.forEach((slot, slotIndex) => track.append(makeSlotCarouselCard(combat, slot, slotIndex)));
  } else {
    // Do not use combat.turns here: Genesys re-sorts that array as each result
    // is rolled. Keep the preparation cards fixed until Begin Encounter, then
    // structured combat may reorder them into the real initiative slot order.
    const combatants = orderedPreCombatants(combat);
    combatants.forEach((combatant) => track.append(makeActorCarouselCard(combat, combatant, { preCombat: true })));
  }

  if (!track.children.length) {
    const empty = document.createElement("div");
    empty.className = "gis-carousel-no-combatants";
    empty.textContent = "No combatants";
    track.append(empty);
  }

  viewport.append(track);
  shell.append(viewport);

  requestAnimationFrame(() => {
    const active = shell.querySelector(".gis-carousel-active");
    active?.scrollIntoView?.({ behavior: "auto", block: "nearest", inline: "center" });
  });
}

function applyEffectiveTurns(combat, origins = originTurns(combat)) {
  if (!combat) return [];
  const effective = origins.map((origin, slotIndex) => claimantForSlot(combat, slotIndex) ?? origin);
  combat.turns = effective;

  const currentSlotClaimant = combat.started && combat.turn != null
    ? claimantForSlot(combat, combat.turn)
    : undefined;
  const currentCombatant = currentSlotClaimant ?? null;

  // Combat.current is history/identity metadata. For an unclaimed Genesys slot
  // there intentionally is no active character yet; once claimed, Foundry sees
  // the claimant as the active combatant/token.
  combat.current = {
    ...(combat.current ?? {}),
    round: combat.round,
    turn: combat.turn,
    combatantId: currentCombatant?.id ?? null,
    tokenId: currentCombatant?.tokenId ?? null
  };

  return effective;
}

function ensureEffectiveTurns(combat) {
  if (!combat?.started) return;
  const origins = originTurns(combat);
  if (!origins.length) return;
  applyEffectiveTurns(combat, origins);
}

function installCombatSlotPatch() {
  const CombatClass = CONFIG.Combat?.documentClass ?? game.combat?.constructor;
  const proto = CombatClass?.prototype;
  if (!proto || proto.__gisSlotTurnPatch) return;

  if (typeof proto.setupTurns === "function") {
    const originalSetupTurns = proto.setupTurns;
    proto.setupTurns = function (...args) {
      const result = originalSetupTurns.apply(this, args);
      const systemOrigins = Array.from(result ?? this.turns ?? []);
      const descriptors = buildSlotDescriptors(this);

      // Only trust the reconstructed descriptors if they align exactly with the
      // system's sorted origin array. This gives extra activations stable keys
      // while retaining a safe fallback if Genesys changes its turn builder.
      const aligned = descriptors.length === systemOrigins.length &&
        descriptors.every((slot, index) => slot.origin?.id === systemOrigins[index]?.id);
      this.__gisSlotDescriptors = aligned
        ? descriptors
        : systemOrigins.map((origin, index) => ({
            origin,
            initiative: origin?.initiative,
            activationId: -1,
            key: `${origin?.id ?? "slot"}:${index}`,
            disposition: combatantDisposition(origin),
            id: origin?.id
          }));
      const slotOrigins = this.__gisSlotDescriptors.map((slot) => slot.origin);

      // During Genesys' own initiative-roll transaction, let the system work
      // against origin combatants. Once the transaction ends our roll wrapper
      // rebuilds the claimant-backed turn array and restores the same slot.
      if (!this.__gisInternalInitiativeRoll && this.started) applyEffectiveTurns(this, slotOrigins);
      return this.turns;
    };
  }

  // Core v13 turn markers derive from Combat#combatant, which in turn derives
  // from turns[turn]. Claimed slots are already claimant-backed by setupTurns.
  // For an unclaimed slot, temporarily hide the origin combatant while Foundry
  // refreshes markers so nobody is falsely highlighted before a claim exists.
  if (typeof proto._updateTurnMarkers === "function") {
    const originalUpdateTurnMarkers = proto._updateTurnMarkers;
    proto._updateTurnMarkers = function (...args) {
      const shouldSuppress = this.started && this.turn != null && !claimantForSlot(this, this.turn);
      if (!shouldSuppress) return originalUpdateTurnMarkers.apply(this, args);

      const savedTurns = this.turns;
      const tempTurns = Array.from(savedTurns ?? []);
      tempTurns[this.turn] = null;
      this.turns = tempTurns;
      try {
        return originalUpdateTurnMarkers.apply(this, args);
      } finally {
        this.turns = savedTurns;
      }
    };
  }

  // Genesys 0.2.19 preserves the current turn during initiative rerolls by
  // remembering this.combatant.id. Because claimant-backed turns can contain a
  // combatant at a slot they did not roll, preserve the stable slot key instead.
  if (typeof proto.rollInitiative === "function") {
    const originalRollInitiative = proto.rollInitiative;
    proto.rollInitiative = async function (...args) {
      const currentKey = this.started && this.turn != null ? slotKeyAt(this, this.turn) : null;
      const previousOrigins = originTurns(this);

      this.__gisInternalInitiativeRoll = true;
      if (previousOrigins.length) this.turns = Array.from(previousOrigins);

      try {
        return await originalRollInitiative.apply(this, args);
      } finally {
        this.__gisInternalInitiativeRoll = false;
        this.setupTurns?.();

        if (currentKey && this.started) {
          const newIndex = slotKeys(this).indexOf(currentKey);
          if (newIndex >= 0 && this.turn !== newIndex) {
            try {
              await this.update({ turn: newIndex });
            } catch (err) {
              console.error(`${MODULE_ID} | Failed to preserve the active initiative slot after reroll`, err);
            }
          }
        }

        ensureEffectiveTurns(this);
        try {
          this._updateTurnMarkers?.();
        } catch (err) {
          console.warn(`${MODULE_ID} | Could not refresh combat turn markers after initiative roll`, err);
        }
      }
    };
  }

  Object.defineProperty(proto, "__gisSlotTurnPatch", {
    value: true,
    configurable: true
  });
}

function refreshCombatPresentation(combat) {
  if (!combat) return;
  if (combat.started) {
    combat.setupTurns?.();
    ensureEffectiveTurns(combat);
    try {
      combat._updateTurnMarkers?.();
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not refresh claimant turn marker`, err);
    }
  }
  if ((ui.combat?.viewed ?? game.combat)?.id === combat.id) ui.combat?.render?.();
}

function broadcastRefresh(combatId) {
  const combat = game.combats.get(combatId);
  refreshCombatPresentation(combat);
  game.socket.emit(SOCKET, { type: "refresh", combatId });
}

function registerSocket() {
  game.socket.on(SOCKET, async (payload) => {
    if (!payload?.type) return;

    if (payload.type === "refresh") {
      refreshCombatPresentation(game.combats.get(payload.combatId));
      return;
    }

    if (payload.type === "actionResult") {
      if (payload.targetUserId !== game.user.id) return;
      if (!payload.ok && payload.message) ui.notifications.warn(payload.message);
      if (payload.ok && (ui.combat?.viewed ?? game.combat)?.id === payload.combatId) ui.combat?.render?.();
      return;
    }

    if (!game.user.isGM || activeGM()?.id !== game.user.id) return;

    const combat = game.combats.get(payload.combatId);
    if (!combat) return;
    const requester = game.users.get(payload.userId);
    if (!requester) return;

    try {
      if (payload.type === "claim") {
        if (combat.round !== payload.round) {
          game.socket.emit(SOCKET, { type: "actionResult", targetUserId: requester.id, combatId: combat.id, ok: false, message: "The encounter advanced before the slot could be claimed." });
          return;
        }

        const chosen = combat.combatants.get(payload.combatantId);
        if (!chosen) {
          game.socket.emit(SOCKET, { type: "actionResult", targetUserId: requester.id, combatId: combat.id, ok: false, message: "The selected token is no longer in this encounter." });
          return;
        }

        // Resolve by stable slot key rather than trusting a stale numeric index
        // if initiative order changed while the socket request was in flight.
        let slotIndex = payload.slotIndex;
        if (payload.slotKey) {
          const resolvedIndex = slotKeys(combat).indexOf(payload.slotKey);
          if (resolvedIndex < 0) {
            game.socket.emit(SOCKET, { type: "actionResult", targetUserId: requester.id, combatId: combat.id, ok: false, message: "That initiative slot no longer exists." });
            return;
          }
          slotIndex = resolvedIndex;
        }

        const ok = await performClaim(combat, slotIndex, chosen, requester, {
          tokenId: payload.tokenId,
          sceneId: payload.sceneId
        });
        game.socket.emit(SOCKET, {
          type: "actionResult",
          targetUserId: requester.id,
          combatId: combat.id,
          ok,
          message: ok ? "" : "The slot could not be claimed. Make sure exactly one token you control is selected and that it matches the slot side."
        });
        if (ok) broadcastRefresh(combat.id);
        return;
      }

      if (payload.type === "revoke") {
        if (combat.round !== payload.round) return;
        let slotIndex = payload.slotIndex;
        if (payload.slotKey) {
          const resolvedIndex = slotKeys(combat).indexOf(payload.slotKey);
          if (resolvedIndex < 0) return;
          slotIndex = resolvedIndex;
        }
        if (await performRevoke(combat, slotIndex, requester)) broadcastRefresh(combat.id);
        return;
      }

      if (payload.type === "advance") {
        if (combat.round !== payload.round || combat.turn !== payload.turn) return;
        if (payload.slotKey && slotKeyAt(combat, combat.turn) !== payload.slotKey) return;
        const claimant = claimantForSlot(combat, combat.turn);
        if (!claimant || !userOwnsCombatant(requester, claimant)) return;
        await combat.nextTurn();
        broadcastRefresh(combat.id);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Socket action failed`, payload, err);
    }
  });
}

Hooks.once("init", () => {
  if (game.system.id !== "genesys") return;

  game.settings.register(MODULE_ID, "enableCarousel", {
    name: "Enable Initiative Carousel",
    hint: "Show the independent horizontal Genesys initiative carousel. The normal Encounter Tracker remains available and unchanged by this setting.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => scheduleCarouselRender(0)
  });

  game.settings.register(MODULE_ID, "carouselScale", {
    name: "Genesys Carousel Scale (%)",
    hint: "Scale the entire Genesys initiative carousel on this client. 100% is the default size.",
    scope: "client",
    config: true,
    type: Number,
    default: 100,
    range: {
      min: 60,
      max: 120,
      step: 5
    },
    onChange: () => scheduleCarouselRender(0)
  });

  game.settings.register(MODULE_ID, "vigilanceSkillName", {
    name: "Vigilance skill name",
    hint: "Optional world override. Leave blank for automatic detection. Example: Пильність.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "coolSkillName", {
    name: "Cool skill name",
    hint: "Optional world override. Leave blank for automatic detection. Example: Самовладання.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  console.log(`${MODULE_ID} | Initializing`);
});

Hooks.once("ready", () => {
  if (game.system.id !== "genesys") return;

  const [major, minor, patch] = String(game.system.version ?? "0.0.0").split(".").map(Number);
  if (major !== 0 || minor !== 2 || patch !== 19) {
    ui.notifications.warn(`Genesys Initiative Slots was built for Genesys 0.2.19. Current system: ${game.system.version}.`);
  }

  installCombatSlotPatch();
  registerSocket();
  if (game.combat?.started) refreshCombatPresentation(game.combat);
  if (game.user.isGM && game.combat?.started) scheduleReconcile(game.combat);
  scheduleCarouselRender(0);
});

Hooks.on("renderCombatTracker", (app, html) => {
  enhanceTracker(app, html);
  scheduleCarouselRender();
});

// Initiative/order changes while combat is running can reorder combat.turns.
// Reconcile the system's index-based Genesys claims with our stable slot keys.
Hooks.on("createCombatant", (combatant) => { scheduleReconcile(combatant.parent); scheduleCarouselRender(); });
Hooks.on("deleteCombatant", (combatant) => { scheduleReconcile(combatant.parent); scheduleCarouselRender(); });
Hooks.on("updateCombatant", (combatant, changes) => {
  if (Object.prototype.hasOwnProperty.call(changes ?? {}, "initiative")) scheduleReconcile(combatant.parent);
  const needsTrackerRefresh = Object.prototype.hasOwnProperty.call(changes ?? {}, "defeated") || Boolean(changes?.flags?.[MODULE_ID]);
  if (needsTrackerRefresh && (ui.combat?.viewed ?? game.combat)?.id === combatant.parent?.id) ui.combat?.render?.();
  scheduleCarouselRender();
});
Hooks.on("updateCombat", (combat, changes) => {
  scheduleCarouselRender();
  if (combat?.started) {
    // Flags can change without a turn-index update when a player claims or
    // releases a slot. Rebuild claimant-backed turns on every combat update;
    // this is local state only and does not write another document update.
    refreshCombatPresentation(combat);
  }

  if (Object.prototype.hasOwnProperty.call(changes ?? {}, "round") ||
      Object.prototype.hasOwnProperty.call(changes ?? {}, "turn")) {
    scheduleReconcile(combat);
  }
});

Hooks.on("deleteCombat", (combat) => {
  clearCombatChoices(combat.id);
  clearCarouselState(combat.id);
  removeCarousel();
  const timer = reconcileTimers.get(combat.id);
  if (timer) clearTimeout(timer);
  reconcileTimers.delete(combat.id);
});
Hooks.on("combatEnd", (combat) => {
  clearCombatChoices(combat.id);
  clearCarouselState(combat.id);
  scheduleCarouselRender();
});
Hooks.on("combatStart", (combat) => {
  // The preparation order has served its purpose. Once structured combat
  // begins, render the sorted Genesys slot order and expand only the active slot.
  carouselPreCombatOrder.delete(combat?.id);
  scheduleCarouselRender();
});
function refreshForEffectParent(effect) {
  const actor = effect?.parent;
  if (!actor) return;
  const combat = carouselCombat();
  if (!combat?.combatants?.some?.((combatant) => combatant.actor?.id === actor.id || combatant.actor?.uuid === actor.uuid)) return;
  scheduleCarouselRender(0);
  if ((ui.combat?.viewed ?? game.combat)?.id === combat.id) ui.combat?.render?.();
}

Hooks.on("createActiveEffect", (effect) => refreshForEffectParent(effect));
Hooks.on("updateActiveEffect", (effect) => refreshForEffectParent(effect));
Hooks.on("deleteActiveEffect", (effect) => refreshForEffectParent(effect));
Hooks.on("canvasReady", () => scheduleCarouselRender());
Hooks.on("updateActor", (actor) => {
  const combat = carouselCombat();
  if (combat?.combatants?.some?.((combatant) => combatant.actor?.id === actor.id || combatant.actor?.uuid === actor.uuid)) scheduleCarouselRender();
});

function refreshForActorItem(item) {
  const actor = item?.parent;
  if (!actor || actor.documentName !== "Actor") return;
  const combat = carouselCombat();
  if (!combat?.combatants?.some?.((combatant) => combatant.actor?.id === actor.id || combatant.actor?.uuid === actor.uuid)) return;
  scheduleCarouselRender(0);
}

Hooks.on("createItem", (item) => refreshForActorItem(item));
Hooks.on("updateItem", (item) => refreshForActorItem(item));
Hooks.on("deleteItem", (item) => refreshForActorItem(item));

Hooks.on("updateToken", (token) => {
  const combat = carouselCombat();
  if (!combat?.combatants?.some?.((combatant) => combatant.tokenId === token.id)) return;
  scheduleCarouselRender();
  if ((ui.combat?.viewed ?? game.combat)?.id === combat.id) ui.combat?.render?.();
});
