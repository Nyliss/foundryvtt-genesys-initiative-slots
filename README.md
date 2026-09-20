# Genesys Initiative Slots v0.2.5

Target: **Foundry VTT 13.351** + **Genesys 0.2.19**.

This module keeps the native Genesys `Combat`, `Combatant`, and dice engine. It adds Genesys-style initiative slots, token-based claiming, a non-modal carousel, and UI/privacy helpers without replacing the underlying combat documents.
## Demo

https://github.com/user-attachments/assets/5c16580b-5b76-4214-8773-412d624e8849

## Initiative slots

- **Vigilance** is the default initiative skill; **Cool** is optional.
- Automatic skill-name recognition includes `Vigilance / Пильність` and `Cool / Самовладання`; world overrides are available in Module Settings.
- Friendly disposition -> **PC Slot**.
- Neutral disposition -> **Neutral Slot**.
- Hostile disposition -> **NPC Slot**.
- Claims are token-driven: select exactly one token on the canvas, then press **Claim**.
- A combatant may claim one normal slot per round. Genesys extra-activation slots are tracked separately and can provide additional activations.
- New combatants or extra activations added during combat remain pending until their own initiative is rolled.
- Stable slot keys keep claims attached to the correct initiative result when initiative order changes.
- Player Claim, Unclaim, and End Turn requests are validated by the active GM through the module socket.
- Combatants marked **Defeated** cannot claim new initiative slots.

## Encounter Tracker

The normal Foundry Encounter Tracker remains available. The module adds:

- PC / Neutral / NPC slot presentation;
- Claim and Unclaim controls;
- player End Turn for the currently claimed slot;
- mid-combat initiative controls;
- status icons;
- defeated styling;
- hidden NPC/Neutral names for players, with a GM reveal/hide control.

NPC and Neutral identities are hidden from players during initiative preparation as well as during structured combat.

## Initiative Carousel

The carousel is part of this module and can be enabled or disabled independently for each client:

`Game Settings -> Configure Settings -> Module Settings -> Enable Initiative Carousel`

It is non-modal: the canvas, actor sheets, journals, tokens, and other Foundry controls remain interactive while it is visible.

### Display

- Horizontal strip at the top center of the canvas.
- Active slot is expanded by default; inactive slots are compact.
- **Collapse All / Expand All** changes only the local presentation.
- Client-side **Genesys Carousel Scale (%)** setting: 60% to 120%.
- PC / Neutral / NPC faction fills remain visually distinct.
- Initiative cards stay in stable preparation order until **Begin Encounter**, then switch to the sorted initiative-slot order.

### Claimed-card data

- portrait and visible name;
- Soak;
- Defence **R/M** (Ranged / Melee);
- Wounds bar;
- Strain bar when applicable;
- active status icons;
- Defeated state.

For players, NPC and Neutral cards hide Soak, Defence, and numeric Wounds/Strain values. Their resource bars remain visible. GMs retain the full values.

### Controls

- Before combat: Vigilance/Cool selector and Roll; GM also gets **Begin Encounter**.
- During combat: Claim, Unclaim, and End Turn.
- GM: previous/next slot and **End Encounter**.
- Portrait click selects the token when possible.
- Double-click opens the actor sheet.
- `×` disables the carousel for that client without disabling the normal Encounter Tracker.

### Installation
Paste this Manifest URL into Foundry VTT:

https://github.com/Nyliss/foundryvtt-genesys-initiative-slots/releases/latest/download/module.json

In Foundry:

Configuration and Setup → Add-on Modules → Install Module → Manifest URL

## Compatibility and maintenance notes

Built specifically for **Foundry VTT 13.351** and **Genesys 0.2.19**. The manifest intentionally pins Genesys compatibility to 0.2.19 because the module augments that version's combat setup behavior.

v0.2.5 is a maintenance cleanup release. It removes unused presentation state, hardens player socket actions against initiative reordering, avoids unsafe name interpolation in carousel HTML, keeps NPC/Neutral identity privacy consistent during preparation and mid-combat pending rolls, refreshes token-sourced statuses in both initiative UIs, blocks defeated combatants from claiming new slots, and properly distinguishes Genesys extra-activation slots from normal initiative slots.
