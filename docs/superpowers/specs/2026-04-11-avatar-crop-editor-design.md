# Avatar Crop Editor

**Date:** 2026-04-11
**Scope:** Interactive circular crop editor modal for Racing account avatar upload

## Problem

The current avatar upload in `racing-account.ejs` auto-crops to 128×128 from center with no user control. Users cannot reposition or zoom their image before saving.

## Solution

Replace the auto-crop with an interactive modal editor. When a user selects an image via "Change Photo", a modal opens with drag-to-pan, scroll/slider-to-zoom, circular mask preview, and two live preview circles showing how the avatar will look at display sizes.

## File Changed

`src/views/racing-account.ejs` — modify the `uploadAvatar()` function and add the crop editor modal markup + logic. No new files, no dependencies, no server changes.

## Modal Layout

~480px wide modal (option B from brainstorming):

- **Left (240×240):** Crop area canvas with circular mask. Dark overlay outside the circle, dashed circle border. Image rendered behind the mask. Drag to pan, scroll to zoom.
- **Right:** Two live preview circles (72px and 36px) that update in real-time from the crop state, with size labels.
- **Bottom:** Zoom slider (range input, styled `#3ecf8e` accent) with −/+ labels. Cancel and Save buttons.
- **Backdrop:** Dark fixed overlay, click-outside closes modal.

## Interactions

- **Drag-to-pan:** `mousedown`/`mousemove`/`mouseup` on crop area. Also `touchstart`/`touchmove`/`touchend` for mobile.
- **Scroll-to-zoom:** `wheel` event on crop area, synced with slider.
- **Zoom slider:** Range input, synced with scroll wheel.
- **Zoom range:** Image fit-to-fill (minimum, so circle is always fully covered) → 3× magnification (maximum).
- **Position clamping:** Image position clamped so the circle area is always fully filled — no empty/transparent space allowed.

## Rendering

- Hidden `<canvas>` element for compositing.
- `requestAnimationFrame` loop draws image at current pan offset + zoom level, applies circular mask, updates both preview circles.
- Crop area rendered as a `<canvas>` element with the circle mask drawn via canvas clipping or dark overlay.

## Save Flow

1. User clicks "Change Photo" → native file picker opens.
2. File selected → 500KB size check (existing) → modal opens with image loaded, centered, fit-to-fill the circle.
3. User drags and zooms → previews update live.
4. "Save" → draw final 128×128 canvas from current crop state → `canvas.toDataURL('image/jpeg', 0.8)` → existing `POST /racing/account/avatar` fetch → update avatar preview on page → close modal.
5. "Cancel" or backdrop click → close modal, discard changes.

## Unchanged

- Upload endpoint: `POST /racing/account/avatar`
- Data format: base64 JPEG data URL
- Output size: 128×128 pixels
- File size limit: 500KB (checked before opening editor)

## Styling

Match existing Racing account page card styling:
- Background: `#1a1b23` card with `rgba(255,255,255,0.08)` border
- Accent: `#3ecf8e` for slider, save button
- Font: inherit from page (Outfit/DM Sans)
- Backdrop: `rgba(0,0,0,0.7)` fixed overlay
