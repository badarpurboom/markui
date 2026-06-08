import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Lightweight visual feedback overlay for any React app.
 *
 * - Toggle "Annotate" mode → left-click any element to mark it red + add a comment.
 * - "Copy for agent" copies all annotations as text you can paste to your coding agent.
 *
 * Drop it once near your app root (typically behind a dev-only flag) — no external deps.
 */

export type Annotation = {
  id: number;
  /** human-readable path to help locate the element in code */
  selector: string;
  /** a snippet of the element's visible text */
  text: string;
  /** what you want changed */
  comment: string;
  /** page coords for the marker badge */
  x: number;
  y: number;
};

export type AnnotationOverlayProps = {
  /** Corner for the toolbar. Default: 'bottom-right'. */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  /** Placeholder text inside the comment box. */
  placeholder?: string;
  /** First line of the copied text block. */
  promptPrefix?: string;
  /**
   * Called with the formatted text when "Copy for agent" is pressed.
   * If omitted, the text is written to the clipboard and an alert is shown.
   */
  onCopy?: (text: string, annotations: Annotation[]) => void;
};

// Build a readable CSS-ish path for an element so an agent can find it in code.
function describeElement(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 5) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      part += `#${node.id}`;
      parts.unshift(part);
      break;
    }
    const cls = (node.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join('.');
    if (cls) part += `.${cls}`;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === node!.tagName,
      );
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

const HIGHLIGHT_STYLE = '2px solid #ef4444';

const CORNERS: Record<NonNullable<AnnotationOverlayProps['position']>, React.CSSProperties> = {
  'bottom-right': { bottom: 16, right: 16 },
  'bottom-left': { bottom: 16, left: 16 },
  'top-right': { top: 16, right: 16 },
  'top-left': { top: 16, left: 16 },
};

export function AnnotationOverlay({
  position = 'bottom-right',
  placeholder = 'What should change here? (Ctrl+Enter to save)',
  promptPrefix = 'Please solve all these UI change requests:',
  onCopy,
}: AnnotationOverlayProps = {}) {
  const [active, setActive] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pending, setPending] = useState<{
    selector: string;
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [draft, setDraft] = useState('');
  const idRef = useRef(1);
  const hoveredRef = useRef<HTMLElement | null>(null);

  const isOverlayNode = useCallback((el: EventTarget | null) => {
    return el instanceof HTMLElement && !!el.closest('[data-annot-ui]');
  }, []);

  // Hover highlight while in active mode.
  useEffect(() => {
    if (!active) return;
    const onMove = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (isOverlayNode(el)) return;
      if (hoveredRef.current && hoveredRef.current !== el) {
        hoveredRef.current.style.outline = '';
      }
      hoveredRef.current = el;
      el.style.outline = HIGHLIGHT_STYLE;
      el.style.outlineOffset = '-1px';
    };
    document.addEventListener('mousemove', onMove, true);
    return () => {
      document.removeEventListener('mousemove', onMove, true);
      if (hoveredRef.current) hoveredRef.current.style.outline = '';
    };
  }, [active, isOverlayNode]);

  // Capture left-clicks while active.
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      if (isOverlayNode(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as HTMLElement;
      setPending({
        selector: describeElement(el),
        text: (el.innerText || el.textContent || '').trim().slice(0, 60),
        x: e.pageX,
        y: e.pageY,
      });
      setDraft('');
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [active, isOverlayNode]);

  const saveComment = () => {
    if (!pending || !draft.trim()) return;
    setAnnotations((prev) => [
      ...prev,
      {
        id: idRef.current++,
        selector: pending.selector,
        text: pending.text,
        comment: draft.trim(),
        x: pending.x,
        y: pending.y,
      },
    ]);
    setPending(null);
    setDraft('');
  };

  const copyForAgent = async () => {
    if (annotations.length === 0) return;
    const body = annotations
      .map(
        (a, i) =>
          `${i + 1}. Element: ${a.selector}\n   Visible text: "${a.text}"\n   Change: ${a.comment}`,
      )
      .join('\n\n');
    const text = `${promptPrefix}\n\n${body}`;
    if (onCopy) {
      onCopy(text, annotations);
      return;
    }
    await navigator.clipboard.writeText(text);
    alert('Copied! Paste it to your coding agent.');
  };

  const panel: React.CSSProperties = {
    position: 'fixed',
    zIndex: 2147483647,
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
  };

  return (
    <div data-annot-ui>
      {/* Toolbar */}
      <div style={{ ...panel, ...CORNERS[position], display: 'flex', gap: 8 }}>
        {annotations.length > 0 && (
          <button
            onClick={copyForAgent}
            style={{
              background: '#111827',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '8px 12px',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0,0,0,.25)',
            }}
          >
            Copy for agent ({annotations.length})
          </button>
        )}
        <button
          onClick={() => setActive((v) => !v)}
          style={{
            background: active ? '#ef4444' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '8px 12px',
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,.25)',
          }}
        >
          {active ? 'Annotating… (click to stop)' : 'Annotate'}
        </button>
      </div>

      {/* Saved markers */}
      {annotations.map((a, i) => (
        <div
          key={a.id}
          title={a.comment}
          style={{
            ...panel,
            top: a.y - 10,
            left: a.x - 10,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: '#ef4444',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            pointerEvents: 'none',
          }}
        >
          {i + 1}
        </div>
      ))}

      {/* Comment box for the pending click */}
      {pending && (
        <div
          style={{
            ...panel,
            top: Math.min(pending.y + 8, window.innerHeight - 180),
            left: Math.min(pending.x + 8, window.innerWidth - 280),
            width: 260,
            background: '#fff',
            color: '#111827',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            padding: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,.2)',
          }}
        >
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
            {pending.selector}
          </div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComment();
              if (e.key === 'Escape') setPending(null);
            }}
            placeholder={placeholder}
            style={{
              width: '100%',
              minHeight: 60,
              border: '1px solid #d1d5db',
              borderRadius: 6,
              padding: 6,
              fontSize: 13,
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button
              onClick={saveComment}
              style={{
                background: '#16a34a',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '6px 10px',
                cursor: 'pointer',
              }}
            >
              Save
            </button>
            <button
              onClick={() => setPending(null)}
              style={{
                background: '#f3f4f6',
                color: '#111827',
                border: 'none',
                borderRadius: 6,
                padding: '6px 10px',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default AnnotationOverlay;
