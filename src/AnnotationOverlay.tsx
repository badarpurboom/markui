import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Lightweight visual feedback overlay for any React app.
 *
 * - Toggle "Annotate" mode → left-click any element to mark it red + add a comment.
 * - Edit or delete existing markers by clicking them.
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

const STORAGE_KEY = 'react-annotate-overlay-data';

export function AnnotationOverlay({
  position = 'bottom-right',
  placeholder = 'What should change here? (Ctrl+Enter to save)',
  promptPrefix = 'Please solve all these UI change requests:',
  onCopy,
}: AnnotationOverlayProps = {}) {
  const [active, setActive] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  
  const [pending, setPending] = useState<{
    id?: number; // If editing an existing annotation
    selector: string;
    text: string;
    x: number;
    y: number;
  } | null>(null);
  
  const [draft, setDraft] = useState('');
  const idRef = useRef(annotations.reduce((max, a) => Math.max(max, a.id), 0) + 1);
  const hoveredRef = useRef<HTMLElement | null>(null);

  // Save to localStorage whenever annotations change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(annotations));
    } catch {
      // Ignore storage errors
    }
  }, [annotations]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape closes dialog or stops annotating
      if (e.key === 'Escape') {
        if (pending) {
          setPending(null);
        } else if (active) {
          setActive(false);
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, pending]);

  const isOverlayNode = useCallback((el: EventTarget | null) => {
    return el instanceof HTMLElement && !!el.closest('[data-annot-ui]');
  }, []);

  // Hover highlight while in active mode.
  useEffect(() => {
    if (!active || pending) return; // Don't highlight if dialog is open
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
  }, [active, pending, isOverlayNode]);

  // Capture left-clicks while active.
  useEffect(() => {
    if (!active || pending) return;
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
  }, [active, pending, isOverlayNode]);

  const saveComment = () => {
    if (!pending || !draft.trim()) return;
    
    if (pending.id) {
      // Edit existing
      setAnnotations((prev) => 
        prev.map(a => a.id === pending.id ? { ...a, comment: draft.trim() } : a)
      );
    } else {
      // Add new
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
    }
    setPending(null);
    setDraft('');
  };

  const deleteComment = () => {
    if (!pending || !pending.id) return;
    setAnnotations((prev) => prev.filter(a => a.id !== pending.id));
    setPending(null);
    setDraft('');
  };

  const clearAll = () => {
    if (confirm('Are you sure you want to clear all annotations?')) {
      setAnnotations([]);
      setPending(null);
    }
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

  const glassStyle: React.CSSProperties = {
    background: 'rgba(255, 255, 255, 0.85)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(229, 231, 235, 0.5)',
    boxShadow: '0 8px 32px rgba(0,0,0,.15)',
  };

  const buttonStyle: React.CSSProperties = {
    border: 'none',
    borderRadius: 8,
    padding: '8px 12px',
    cursor: 'pointer',
    fontWeight: 500,
    transition: 'all 0.2s',
  };

  return (
    <div data-annot-ui>
      {/* Toolbar */}
      <div style={{ ...panel, ...CORNERS[position], display: 'flex', gap: 8, alignItems: 'center' }}>
        {annotations.length > 0 && (
          <>
            <button
              onClick={clearAll}
              style={{
                ...buttonStyle,
                background: 'rgba(255, 255, 255, 0.85)',
                backdropFilter: 'blur(8px)',
                color: '#ef4444',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                boxShadow: '0 2px 8px rgba(0,0,0,.1)',
              }}
            >
              Clear
            </button>
            <button
              onClick={copyForAgent}
              style={{
                ...buttonStyle,
                background: '#111827',
                color: '#fff',
                boxShadow: '0 4px 12px rgba(0,0,0,.25)',
              }}
            >
              Copy for agent ({annotations.length})
            </button>
          </>
        )}
        <button
          onClick={() => {
            setActive((v) => !v);
            if (pending) setPending(null);
          }}
          style={{
            ...buttonStyle,
            background: active ? '#ef4444' : '#2563eb',
            color: '#fff',
            boxShadow: '0 4px 12px rgba(0,0,0,.25)',
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
          onClick={() => {
            setPending({
              id: a.id,
              selector: a.selector,
              text: a.text,
              x: a.x,
              y: a.y,
            });
            setDraft(a.comment);
            setActive(true); // Ensure active is on so we don't trigger regular click
          }}
          style={{
            ...panel,
            top: a.y - 12,
            left: a.x - 12,
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: pending?.id === a.id ? '#3b82f6' : '#ef4444',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 2px 6px rgba(0,0,0,.3)',
            border: '2px solid #fff',
            transition: 'background 0.2s',
            zIndex: pending?.id === a.id ? 2147483648 : 2147483647,
          }}
        >
          {i + 1}
        </div>
      ))}

      {/* Comment box for the pending click or editing */}
      {pending && (
        <div
          style={{
            ...panel,
            ...glassStyle,
            top: Math.min(pending.y + 12, window.innerHeight - 180),
            left: Math.min(pending.x + 12, window.innerWidth - 280),
            width: 280,
            color: '#111827',
            borderRadius: 12,
            padding: 14,
            zIndex: 2147483649,
          }}
        >
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8, wordBreak: 'break-all' }}>
            {pending.selector}
          </div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComment();
            }}
            placeholder={placeholder}
            style={{
              width: '100%',
              minHeight: 70,
              background: 'rgba(255, 255, 255, 0.7)',
              border: '1px solid rgba(209, 213, 219, 0.8)',
              borderRadius: 8,
              padding: 8,
              fontSize: 13,
              resize: 'vertical',
              boxSizing: 'border-box',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button
              onClick={saveComment}
              style={{
                ...buttonStyle,
                background: '#16a34a',
                color: '#fff',
                padding: '6px 12px',
                flex: 1,
              }}
            >
              Save
            </button>
            {pending.id && (
              <button
                onClick={deleteComment}
                style={{
                  ...buttonStyle,
                  background: '#fee2e2',
                  color: '#dc2626',
                  padding: '6px 12px',
                }}
              >
                Delete
              </button>
            )}
            <button
              onClick={() => {
                setPending(null);
                setDraft('');
              }}
              style={{
                ...buttonStyle,
                background: 'rgba(243, 244, 246, 0.8)',
                color: '#374151',
                padding: '6px 12px',
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
