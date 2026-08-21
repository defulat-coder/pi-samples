---
name: design-system-langsmith
description: >
  Apply the LangSmith design system when building or updating UI.
  Use when creating components, choosing colors or typography,
  or reviewing designs for dashboard interfaces.
---

# LangSmith — Design System Skill

## When to Use

- Building new UI components for LangSmith.
- Reviewing or updating existing component styles.
- Choosing colors, typography, or spacing for dashboard pages.
- Checking designs against the extracted token set.

## Context

- **Product:** LangSmith — https://eu.smith.langchain.com/o/831f7197-f855-4b1d-9fac-5d7ff8f58b39?tab=manage
- **Surface:** dashboard
- **Audience:** Business users and internal teams
- **Character:** Data-driven application interface with a rich, diverse color palette and 3 typefaces.
- **Full guideline:** see [DESIGN.md](./DESIGN.md) in this skill directory for the complete component-authoring workflow.

## Tokens

### Colors

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

### Typography

**Font stack:** Inter, Fira Code, Aeonik Mono

| Level | Size | Usage |
|-------|------|-------|
| text-xs | 13px | Captions, metadata |
| text-sm | 16px | Labels, secondary text |
| text-base | 18px | Body text (default) |

**Weight scale:** 400 · 500 · 600
**Line heights:** 21.6px · 24px · 15.6px · 16.1px · 21px · 20px

### Spacing

**Base unit:** 4px

`space-1: 1px` · `space-2: 2px` · `space-3: 4px` · `space-4: 6px` · `space-5: 8px` · `space-6: 12px` · `space-7: 16px` · `space-8: 24px` · `space-9: 32px` · `space-10: 44px` · `space-11: 48px` · `space-12: 64px`

### Shapes

**Border radius:** `radius-sm: 3px` · `radius-md: 4px` · `radius-lg: 6px 0px 0px 6px` · `radius-xl: 6px` · `radius-full: 9999px`

### Elevation

- **shadow-sm:** `rgb(255, 255, 255) 0px 0px 0px 0px inset, rgba(0, 0, 0, 0) 0px 0px 0px 1px inset, rgba(0, 0, 0, 0) 0px 0px 0px 0px`
- **shadow-md:** `rgb(255, 255, 255) 0px 0px 0px 0px, rgba(125, 197, 251, 0.5) 0px 0px 0px 1px, rgba(16, 24, 40, 0.1) 0px 10px 15px -3px, rgba(16, 24, 40, 0.05) 0px 4px 6px -2px`

### Motion

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

## Component Inventory

- **Buttons:** 9 detected
- **Links:** 20 detected
- **Lists:** 1 detected
- **Tables:** 1 detected
- **Images:** 38 detected

## Constraints

### Always

- Use tokens from the tables above — do not introduce new values.
- Include hover, focus-visible, and disabled states for interactive elements.
- Follow the 4px spacing grid.
- Meet WCAG 2.2 AA contrast minimums.

### Never

- Do not introduce colors outside the extracted palette.
- Do not use arbitrary spacing values — stick to the scale.
- Do not mix border-radius values. Pin to the detected set (3px, 4px, 6px 0px 0px 6px, 6px, 9999px).
- Do not use decorative shadows on data-dense layouts.
- Do not hide critical status information behind interactions.
- Do not ship components without defining hover, focus-visible, and disabled states.

## Tone

Efficient, data-forward, action-oriented. Labels over sentences.

## Authoring Workflow

When creating or documenting a component for this system:

1. State intent — one sentence on purpose.
2. Map tokens — list every token the component uses.
3. Define anatomy — named parts with token assignments.
4. Specify states — default, hover, focus-visible, active, disabled, loading, error, empty.
5. Describe interactions — keyboard, pointer, touch, edge cases.
6. Add a11y criteria — testable pass/fail checks.
7. List anti-patterns — concrete misuse examples.
8. Close with the Definition of Done checklist.

## Output Structure

Component guidelines must contain, in order:

1. Overview (purpose, when to use, when not to use)
2. Tokens and foundations
3. Anatomy, variants, responsive behavior
4. States and interactions
5. Accessibility (ARIA, contrast, focus, screen reader)
6. Content guidelines (copy rules, tone)
7. Anti-patterns with reasoning

## Component Requirements

- Reference only tokens from the tables above.
- Define all states: default, hover, focus-visible, active, disabled, loading, error.
- Handle edge cases: empty, overflow, truncation, max content.
- Include keyboard navigation behavior.
- Document ARIA roles and labels.

## Definition of Done

- Default state renders (smoke test).
- All states visually verified.
- Zero hardcoded visual values — tokens only.
- Keyboard navigation works without pointer.
- No critical a11y violations.
- Tested at min and max breakpoint.
- At least one anti-pattern documented.
- Purpose, usage, and limitations documented.
