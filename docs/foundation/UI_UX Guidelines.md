> **Translation Notice:** This document was originally authored in Arabic and has been
> translated into English while preserving its complete content and all original details.
> It remains part of the immutable founding design record (`docs/foundation/`) and does
> **not** describe current system behavior.

I authored this guide to serve as the unified visual and technical reference for the
**LUGX** project.

This guide is designed to achieve the delicate balance between "complex engineering
functionality" and "simple aesthetic appearance," relying on `shadcn/ui` and
`Tailwind CSS` as its technical foundation.

---

# 📐 LUGX UI/UX Design Guidelines (v1.0)

**Classification:** Confidential — restricted to the development and design team.
**Philosophy:** "Engineering Luxury."

---

## 1. Visual Direction

### 1.1 Concept: Quiet Luxury

We abandon visual noise. Luxury in LUGX does not mean ornamentation — it means
**"precision"** and **"material quality."** The interface must feel as if it were made of
high-grade materials (polished titanium, frosted glass, carbon fiber), not merely
colored pixels.

*   **Principle:** "Content is the hero." The interface recedes into the background to
    yield space to the text and the AI tools.
*   **Feel:** solid, responsive, dark, and comfortable for the eye during long working
    sessions.

### 1.2 Negative Space Strategy

White space (black, in our case) is not emptiness — it is an active design element.

*   **Breathing rule:** do not crowd elements. Leave generous padding/margins around the
    main editor block.
*   **Focus:** use negative space to direct the user's eye toward the "primary action"
    button (such as AI generation) without arrows or loud colors.

---

## 2. Design System

### 2.1 Color Palette — Dark Mode Only

We adopt a monochromatic color system based on **Zinc** gradations to create visual depth
without distraction.

*   **Surfaces:**
    *   **Base (Void):** `bg-zinc-950` (the main background; muted black, not pure #000).
    *   **First layer (Elevated):** `bg-zinc-900/50` (for the sidebar and cards).
    *   **Borders:** `border-zinc-800` (ultra-subtle borders).

*   **Typography Colors:**
    *   **Headings:** `text-zinc-50` (near-pure white).
    *   **Body text:** `text-zinc-300` (light gray for eye comfort).
    *   **Secondary text:** `text-zinc-500` (for inactive elements).

*   **Accent Colors — "The AI Pulse":**
    *   A single color signals AI or primary actions.
    *   **Color:** `Electric Indigo` or `Violet` with a subtle glow effect.
    *   **Code:** `indigo-500` (used at low opacity in backgrounds, strong in text).

### 2.2 Typography

We use geometric sans-serif typefaces that reflect modernity and support Arabic and
English in perfect harmony.

*   **Latin font:** `Geist Sans` or `Inter` (with `tracking-tight` letter spacing on headings).
*   **Arabic font:** `IBM Plex Sans Arabic` or `Readex Pro` (low-contrast geometric faces
    suited to technical interfaces).
*   **Weights:**
    *   Rely on Light/Regular weights for body text to reinforce elegance.
    *   Use Medium weight for headings. Heavy `Bold` is forbidden except in extreme
        necessity.

### 2.3 Iconography

*   **Library:** `Lucide React` (the standard with shadcn).
*   **Style:** stroke-based, thin and uniform thickness (1.5px).
*   **Size:** small and precise (16px–20px). Oversized icons are forbidden.

---

## 3. Interactive Components (UI Components)

### 3.1 Buttons

*   **Shape:** rectangles with slightly softened corners (`rounded-md` or equivalent
    ~6px). Fully circular corners (`rounded-full`) are avoided except for small floating
    buttons.
*   **Default state:** dark background (`bg-zinc-900`) with very light borders
    (`border-zinc-800`) and a slight inner glow on hover.
*   **AI buttons:** the generation button must be distinguished by a very subtle color
    gradient or luminous borders (`border-indigo-500/50`).

### 3.2 Input Fields (Inputs & Editor)

*   **The editor (TipTap):** completely borderless — the text floats in space. The caret
    must take the Accent color with smooth motion.
*   **Standard fields:** transparent or semi-transparent backgrounds, with an underline
    only, or very dark gray borders that disappear when unfocused.

### 3.3 Micro-interactions

Luxury means "calm." Motion must be imperceptible.

*   **Speed:** relatively slow (300ms–500ms).
*   **Type:** `ease-out`. Avoid "bouncy/spring" motions — they suggest playfulness, and
    we target professionalism.
*   **Appearance:** elements fade in softly (Fade-in) with a slight upward movement.

---

## 4. Standards & Constraints

Based on the requirements document (PRD) and the technical inputs:

1.  **Contrast Constraint:**
    *   Maintain high text contrast to guarantee readability, but without using "pure
        white on pure black" to avoid eye strain (the halation effect).

2.  **Hierarchy Constraint:**
    *   The AI tools (Correct, Improve, Summarize) must be visually distinguished from
        traditional formatting tools (Bold, Italic). The former belong on a floating or
        distinct bar; the latter on a less prominent fixed bar.

3.  **Tier Visuals Constraint:**
    *   **Free plan:** clean, standard interface.
    *   **Ultra plan:** add extremely subtle visual touches (such as very faint gold
        borders `border-yellow-500/20`, or a small "Ultra" badge beside the name) to
        reinforce a sense of exclusivity without vulgarity.

4.  **Responsiveness:**
    *   Desktop-first priority given the nature of the application (professional text
        editing), while ensuring a smooth reading experience on mobile.

---

**Note to developers:**
When implementing this guide with `Tailwind`, rely on the `zinc` classes for neutral
colors, and use `backdrop-blur-md` on floating menus to create the "Frosted Glass" effect
that reinforces depth and luxury.

