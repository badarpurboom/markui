# react-annotate-overlay

Lightweight **visual feedback overlay** for any React app. Turn on annotate mode, **left-click** any element to mark it red, type what you want changed, and **copy all requests** as ready-to-paste text for your AI coding agent (Claude Code, Cursor, etc.).

No external dependencies. One component. Drop it in once.

## Install

```bash
npm install react-annotate-overlay
```

> React 17+ is a peer dependency.

## Usage

Mount it once near your app root. Keep it dev-only so it never ships to production:

```tsx
import { AnnotationOverlay } from 'react-annotate-overlay';

function Root() {
  return (
    <>
      <App />
      {import.meta.env.DEV && <AnnotationOverlay />}
    </>
  );
}
```

For Create React App / Next.js use `process.env.NODE_ENV === 'development'` instead of `import.meta.env.DEV`.

## How it works

1. A floating **Annotate** button appears in the corner. Click it → annotate mode on.
2. Hover any element → it gets a **red outline**. **Left-click** it.
3. A comment box opens → write what should change → **Save** (or `Ctrl/Cmd+Enter`).
4. Add as many markers as you like (numbered 1, 2, 3…).
5. Click **Copy for agent (N)** → formatted text is copied to your clipboard.
6. Paste it to your coding agent.

### Copied format

```
Please solve all these UI change requests:

1. Element: div.card > button:nth-of-type(2)
   Visible text: "Save Invoice"
   Change: make it green and add a loading spinner

2. Element: header#topbar > nav
   Visible text: "Dashboard"
   Change: make this link bold
```

The `Element` path + `Visible text` give the agent enough to locate the exact element in your code.

## Props

All optional.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `position` | `'bottom-right' \| 'bottom-left' \| 'top-right' \| 'top-left'` | `'bottom-right'` | Toolbar corner. |
| `placeholder` | `string` | `'What should change here? …'` | Comment box placeholder. |
| `promptPrefix` | `string` | `'Please solve all these UI change requests:'` | First line of the copied text. |
| `onCopy` | `(text: string, annotations: Annotation[]) => void` | — | Override the copy action (e.g. write to a file or POST to a server). If omitted, copies to clipboard. |

## License

MIT
