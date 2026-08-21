# LangSmith

## Overview

**Product:** LangSmith
**URL:** https://eu.smith.langchain.com/o/831f7197-f855-4b1d-9fac-5d7ff8f58b39?tab=manage
**Surface type:** dashboard
**Audience:** Business users and internal teams
**Brand character:** Data-driven application interface with a rich, diverse color palette and 3 typefaces.

> **Note:** Surface detection confidence is low. Verify the inferred audience and brand context before relying on this file.

### Design Principles

- Data visibility — the most important metric should be visible without interaction.
- Progressive disclosure — surface summaries, reveal detail on demand.
- Efficiency over decoration — every pixel should communicate state or enable action.

## Colors

| Token | Value | Role |
|-------|-------|------|
| --brand-200 | `#145095` | Accent |
| --brand-300 | `#1566B8` | Accent |
| --brand-400 | `#006DDD` | Accent |
| --brand-500 | `#0078F1` | Accent |
| --brand-600 | `#008DFF` | Accent |
| --text-status-orange | `#FF5D1B` | Accent |
| --text-status-orange | `#EE7207` | Accent |
| --text-status-green | `#02AE45` | Accent |
| --text-status-yellow | `#C98E06` | Accent |
| --text-status-green | `#0FC966` | Accent |
| --text-status-yellow | `#E6A81B` | Accent |
| --brand-700 | `#5FBEF8` | Accent |
| --brand-75 | `#9DD2FC` | Accent |
| --brand-800 | `#CCE9FF` | Accent |
| --brand-900 | `#E5F4FF` | Accent |
| --brand-950 | `#F2FAFF` | Accent |
| --border-status-green | `#064C21` | Border |
| --border-status-orange | `#7C2B09` | Border |
| --border-status-yellow | `#5B4300` | Border |
| --border-status-red | `#FDA29B` | Border |

_Showing 20 of 26 detected colors. Full palette available in the extension._

## Typography

**Font stack:** Inter, Fira Code, Aeonik Mono

| Level | Size | Usage |
|-------|------|-------|
| text-xs | 13px | Captions, metadata |
| text-sm | 16px | Labels, secondary text |
| text-base | 18px | Body text (default) |

**Weight scale:** 400 · 500 · 600
**Line heights:** 21.6px · 24px · 15.6px · 16.1px · 21px · 20px

## Spacing

**Base unit:** 4px

`space-1: 1px` · `space-2: 2px` · `space-3: 4px` · `space-4: 6px` · `space-5: 8px` · `space-6: 12px` · `space-7: 16px` · `space-8: 24px` · `space-9: 32px` · `space-10: 44px` · `space-11: 48px` · `space-12: 64px`

## Shapes

**Border radius:** `radius-sm: 3px` · `radius-md: 4px` · `radius-lg: 6px 0px 0px 6px` · `radius-xl: 6px` · `radius-full: 9999px`

## Elevation

- **shadow-sm:** `rgb(255, 255, 255) 0px 0px 0px 0px inset, rgba(0, 0, 0, 0) 0px 0px 0px 1px inset, rgba(0, 0, 0, 0) 0px 0px 0px 0px`
- **shadow-md:** `rgb(255, 255, 255) 0px 0px 0px 0px, rgba(125, 197, 251, 0.5) 0px 0px 0px 1px, rgba(16, 24, 40, 0.1) 0px 10px 15px -3px, rgba(16, 24, 40, 0.05) 0px 4px 6px -2px`

## Motion

- **duration-fast:** `all`
- **duration-fast:** `none`
- **duration-fast:** `cubic-bezier(0.4, 0, 0.2, 1)`
- **duration-fast:** `color 0.15s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.15s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.15s cubic-bezier(0.4, 0, 0.2, 1), text-decoration-color 0.15s cubic-bezier(0.4, 0, 0.2, 1), fill 0.15s cubic-bezier(0.4, 0, 0.2, 1), stroke 0.15s cubic-bezier(0.4, 0, 0.2, 1)`
- **duration-fast:** `0.15s cubic-bezier(0.4, 0, 0.2, 1)`
- **duration-base:** `0.2s cubic-bezier(0.4, 0, 0.2, 1)`
- **duration-base:** `padding 0.2s cubic-bezier(0.4, 0, 0.2, 1)`
- **duration-base:** `0.2s`
- **duration-base:** `color 0.3s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.3s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.3s cubic-bezier(0.4, 0, 0.2, 1), text-decoration-color 0.3s cubic-bezier(0.4, 0, 0.2, 1), fill 0.3s cubic-bezier(0.4, 0, 0.2, 1), stroke 0.3s cubic-bezier(0.4, 0, 0.2, 1)`
- **duration-base:** `0.3s cubic-bezier(0.4, 0, 0.2, 1)`
- **duration-base:** `0.3s`
- **duration-slow:** `2s cubic-bezier(0.4, 0, 0.6, 1) infinite pulse`

## Components

- **Buttons:** 9 detected
- **Links:** 20 detected
- **Lists:** 1 detected
- **Tables:** 1 detected
- **Images:** 38 detected

## Do's and Don'ts

### Do

- Reference tokens by name, not raw values — agents and developers should use `color.text.primary`, not `#171717`.
- Define all interactive states: default, hover, focus-visible, active, disabled.
- Use the spacing scale for all padding, margin, and gap values.
- Write content in sentence case. Reserve ALL CAPS for acronyms only.
- Test every component at the smallest and largest breakpoint before shipping.

### Don't

- Do not introduce colors outside the extracted palette.
- Do not use arbitrary spacing values — stick to the scale.
- Do not mix border-radius values. Pin to the detected set (3px, 4px, 6px 0px 0px 6px, 6px, 9999px).
- Do not use decorative shadows on data-dense layouts.
- Do not hide critical status information behind interactions.
- Do not ship components without defining hover, focus-visible, and disabled states.

## Writing Tone

Efficient, data-forward, action-oriented. Labels over sentences.

## Authoring Workflow

When creating or updating a component guideline for this system, follow this sequence:

1. **State the intent** — one sentence on what the component does and why it exists.
2. **Map tokens** — list every color, spacing, typography, and radius token the component uses. No raw values.
3. **Define anatomy** — break the component into named parts (container, label, icon, etc.) with their token assignments.
4. **Specify states** — document every state: default, hover, focus-visible, active, disabled, loading, error, empty.
5. **Describe interactions** — keyboard, pointer, and touch behavior, including edge cases (long content, overflow, truncation).
6. **Add accessibility criteria** — write testable pass/fail checks (e.g. "focus ring must be visible at 3:1 contrast").
7. **List anti-patterns** — concrete examples of misuse with a brief explanation of why each is wrong.
8. **Close with a QA checklist** — a mechanical list of verifiable items (see Definition of Done below).

## Required Output Structure

Every component guideline produced from this system must contain these sections, in order:

1. Overview — purpose, when to use, when not to use.
2. Tokens and foundations — all referenced tokens from the tables above.
3. Anatomy and variants — named parts, variant matrix, responsive behavior.
4. States and interactions — full state table, keyboard/pointer/touch behavior.
5. Accessibility — ARIA attributes, contrast requirements, focus management, screen reader behavior.
6. Content guidelines — copy length, tone, capitalisation, placeholder text rules.
7. Anti-patterns — explicit examples of what not to build, with reasoning.

## Component Requirements

Every component built against this system must:

- Reference only tokens defined in the tables above — no hardcoded hex, px, or font values.
- Define all interactive states: default, hover, focus-visible, active, disabled, loading, error.
- Specify responsive behavior at the smallest and largest supported breakpoint.
- Handle edge cases: empty state, overflow / truncation, maximum content length.
- Include keyboard navigation (Tab, Enter, Escape, Arrow keys where applicable).
- Document ARIA roles, labels, and live-region behavior where relevant.
- Include known page component density: - **Buttons:** 9 detected
- **Links:** 20 detected
- **Lists:** 1 detected
- **Tables:** 1 detected
- **Images:** 38 detected

## Definition of Done

A component is not complete until every item below is checked:

- Renders correctly in its default state (smoke test).
- All states documented and visually verified (hover, focus, disabled, loading, error, empty).
- All visual values use design tokens — zero hardcoded values.
- Keyboard navigation works without a pointer.
- No critical accessibility violations (contrast, ARIA, focus order).
- Tested at smallest and largest breakpoint.
- Anti-patterns section lists at least one concrete misuse example.
- Documentation covers purpose, usage, props/API, and limitations.
