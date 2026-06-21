import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import html2canvas from 'html2canvas';

/**
 * Advanced visual feedback overlay for React apps.
 *
 * Features:
 * - Inspect Mode → Click any element to annotate, capture Fiber source info, and screenshot.
 * - Draw Mode → Sketch freehand lines/arrows to point out issues.
 * - Glassmorphism UI → Dark mode Slate-900 toolbar and comment boxes.
 * - Local Sync Server → Automatically writes annotations to `markui.json`.
 * - Classification → Categorize (Bug, Style, etc.) and prioritize (High, Med, Low).
 */

export type Annotation = {
  id: number;
  selector: string;
  text: string;
  comment: string;
  x: number;
  y: number;
  percentX?: number;
  percentY?: number;
  sourceFile?: string;
  sourceLine?: number;
  priority?: 'Low' | 'Medium' | 'High';
  type?: 'Bug' | 'Styling' | 'Feature' | 'Refactor';
  screenshot?: string; // base64 string
  drawing?: {
    points: { x: number; y: number }[];
    color: string;
  }[];
};

export type AnnotationOverlayProps = {
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  placeholder?: string;
  promptPrefix?: string;
  onCopy?: (text: string, annotations: Annotation[]) => void;
};

// Traverse React Fiber node to find source file and line info
function getReactSource(el: Element): { fileName: string; lineNumber: number } | null {
  const keys = Object.keys(el);
  const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  if (!fiberKey) return null;
  
  let curr = (el as any)[fiberKey];
  while (curr) {
    if (curr._debugSource) {
      let fileName = curr._debugSource.fileName || '';
      if (fileName.includes('/src/')) {
        fileName = 'src/' + fileName.split('/src/')[1];
      } else if (fileName.includes('\\src\\')) {
        fileName = 'src/' + fileName.split('\\src\\')[1];
      }
      return {
        fileName,
        lineNumber: curr._debugSource.lineNumber
      };
    }
    curr = curr.return;
  }
  return null;
}

function describeElement(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 5) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      const id = node.id;
      if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) {
        part += `#${id}`;
        parts.unshift(part);
        break;
      }
    }
    
    const className = node.getAttribute('class');
    const classStr = typeof className === 'string' ? className : '';
    if (classStr) {
      const cls = classStr
        .split(/\s+/)
        .filter((c) => c && !c.includes(':') && c.length < 30 && !c.startsWith('hover:'))
        .slice(0, 2)
        .join('.');
      if (cls) part += `.${cls}`;
    }
    
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === node!.tagName,
      );
      if (sameTag.length > 1) {
        part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    node = node.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

const CORNERS: Record<NonNullable<AnnotationOverlayProps['position']>, React.CSSProperties> = {
  'bottom-right': { bottom: 20, right: 20 },
  'bottom-left': { bottom: 20, left: 20 },
  'top-right': { top: 20, right: 20 },
  'top-left': { top: 20, left: 20 },
};

const STORAGE_KEY = 'react-annotate-overlay-data';

function fallbackCopyText(text: string): boolean {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.top = '0';
  textArea.style.left = '0';
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  let successful = false;
  try {
    successful = document.execCommand('copy');
  } catch (err) {
    console.error('Fallback copy failed', err);
  }
  document.body.removeChild(textArea);
  return successful;
}

export function AnnotationOverlay({
  position = 'bottom-right',
  placeholder = 'What should change here? (Ctrl+Enter to save)',
  promptPrefix = 'Please solve all these UI change requests:',
  onCopy,
}: AnnotationOverlayProps = {}) {
  const [active, setActive] = useState(false);
  const [mode, setMode] = useState<'inspect' | 'draw'>('inspect');
  const [annotations, setAnnotations] = useState<Annotation[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  
  const [pending, setPending] = useState<{
    id?: number;
    selector: string;
    text: string;
    x: number;
    y: number;
    percentX?: number;
    percentY?: number;
    sourceFile?: string;
    sourceLine?: number;
    priority?: 'Low' | 'Medium' | 'High';
    type?: 'Bug' | 'Styling' | 'Feature' | 'Refactor';
    screenshot?: string;
    drawing?: {
      points: { x: number; y: number }[];
      color: string;
    }[];
  } | null>(null);
  
  const [draft, setDraft] = useState('');
  const [mounted, setMounted] = useState(false);
  const [tick, setTick] = useState(0);
  
  // Custom states for dropdowns
  const [draftPriority, setDraftPriority] = useState<'Low' | 'Medium' | 'High'>('Medium');
  const [draftType, setDraftType] = useState<'Bug' | 'Styling' | 'Feature' | 'Refactor'>('Bug');

  // Drawing strokes coordinates state
  const [tempStroke, setTempStroke] = useState<{ x: number; y: number }[] | null>(null);

  const [hoveredRect, setHoveredRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  const idRef = useRef(annotations.reduce((max, a) => Math.max(max, a.id), 0) + 1);

  // Inject CSS Styles
  useEffect(() => {
    setMounted(true);
    const css = `
      @keyframes annot-pulse-red {
        0% { box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.7), 0 4px 12px rgba(244, 63, 94, 0.3); }
        70% { box-shadow: 0 0 0 8px rgba(244, 63, 94, 0), 0 4px 12px rgba(244, 63, 94, 0.3); }
        100% { box-shadow: 0 0 0 0 rgba(244, 63, 94, 0), 0 4px 12px rgba(244, 63, 94, 0.3); }
      }
      @keyframes annot-pulse-blue {
        0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7), 0 4px 12px rgba(59, 130, 246, 0.3); }
        70% { box-shadow: 0 0 0 8px rgba(59, 130, 246, 0), 0 4px 12px rgba(59, 130, 246, 0.3); }
        100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0), 0 4px 12px rgba(59, 130, 246, 0.3); }
      }
      @keyframes annot-slide-in {
        from { transform: translateY(12px) scale(0.95); opacity: 0; }
        to { transform: translateY(0) scale(1); opacity: 1; }
      }
      .annot-btn {
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        border: none;
        border-radius: 8px;
        padding: 6px 12px;
        cursor: pointer;
        font-weight: 600;
        font-size: 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      .annot-btn:hover {
        transform: translateY(-1px);
        filter: brightness(1.1);
      }
      .annot-btn:active {
        transform: translateY(0);
      }
      .annot-marker {
        transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275), background 0.25s;
      }
      .annot-marker:hover {
        transform: scale(1.18);
        z-index: 2147483648;
      }
      .annot-textarea:focus {
        border-color: #6366f1 !important;
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2) !important;
      }
      .annot-select {
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #cbd5e1;
        font-size: 11px;
        border-radius: 6px;
        padding: 4px 8px;
        outline: none;
        cursor: pointer;
        transition: all 0.2s;
      }
      .annot-select:focus {
        border-color: #6366f1;
      }
      .annot-mode-toggle {
        display: flex;
        background: rgba(0, 0, 0, 0.25);
        border-radius: 8px;
        padding: 2px;
        border: 1px solid rgba(255, 255, 255, 0.05);
      }
      .annot-mode-btn {
        border: none;
        background: transparent;
        color: #94a3b8;
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.2s;
      }
      .annot-mode-btn.active {
        background: rgba(255, 255, 255, 0.08);
        color: #f8fafc;
      }
    `;
    const styleEl = document.createElement('style');
    styleEl.setAttribute('type', 'text/css');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
    
    return () => {
      setMounted(false);
      document.head.removeChild(styleEl);
    };
  }, []);

  // Update layout trigger on resize/scroll
  useEffect(() => {
    const update = () => setTick((t) => t + 1);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, []);

  // Sync to Local Server
  const syncWithLocalServer = async (data: Annotation[]) => {
    try {
      await fetch('http://localhost:3001/api/annotations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data, null, 2),
      });
    } catch {
      // Fail silently if server is not running
    }
  };

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(annotations));
    syncWithLocalServer(annotations);
  }, [annotations]);

  // Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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
    if (!(el instanceof Element)) return false;
    return !!el.closest('[data-annot-ui]');
  }, []);

  // html2canvas capture helper
  const captureElementScreenshot = async (el: HTMLElement): Promise<string | undefined> => {
    try {
      // Hide annotations overlay elements before screenshotting
      const overlayUIs = document.querySelectorAll('[data-annot-ui]');
      overlayUIs.forEach(ui => {
        (ui as HTMLElement).style.visibility = 'hidden';
      });

      const canvas = await html2canvas(el, {
        useCORS: true,
        logging: false,
        backgroundColor: null,
        scale: 1,
      });

      overlayUIs.forEach(ui => {
        (ui as HTMLElement).style.visibility = 'visible';
      });

      let finalCanvas = canvas;
      // Downscale if too large
      if (canvas.width > 500 || canvas.height > 500) {
        const maxDim = 500;
        const scale = Math.min(maxDim / canvas.width, maxDim / canvas.height);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width * scale;
        tempCanvas.height = canvas.height * scale;
        const ctx = tempCanvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(canvas, 0, 0, tempCanvas.width, tempCanvas.height);
          finalCanvas = tempCanvas;
        }
      }

      return finalCanvas.toDataURL('image/jpeg', 0.8);
    } catch (err) {
      console.warn('[markui] Failed to capture screenshot', err);
      return undefined;
    }
  };

  // Inspect Hover Highlight overlay bounding box calculation
  useEffect(() => {
    if (!active || pending || mode !== 'inspect') {
      setHoveredRect(null);
      return;
    }
    const onMove = (e: MouseEvent) => {
      const el = e.target as Element;
      if (isOverlayNode(el)) {
        setHoveredRect(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      setHoveredRect({
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width,
        height: rect.height,
      });
    };
    const onLeave = () => {
      setHoveredRect(null);
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseleave', onLeave, true);
    return () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseleave', onLeave, true);
    };
  }, [active, pending, mode, isOverlayNode]);

  // Capture Click events in Inspect Mode
  useEffect(() => {
    if (!active || pending || mode !== 'inspect') return;
    const onClick = async (e: MouseEvent) => {
      if (isOverlayNode(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      
      const el = e.target as HTMLElement;
      const rect = el.getBoundingClientRect();
      
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      const percentX = rect.width > 0 ? clickX / rect.width : 0.5;
      const percentY = rect.height > 0 ? clickY / rect.height : 0.5;

      // React Fiber debug source
      const fiberSource = getReactSource(el);

      // Capture screenshot
      const screenshot = await captureElementScreenshot(el);

      setPending({
        selector: describeElement(el),
        text: (el.innerText || el.textContent || '').trim().slice(0, 60),
        x: e.pageX,
        y: e.pageY,
        percentX,
        percentY,
        sourceFile: fiberSource?.fileName,
        sourceLine: fiberSource?.lineNumber,
        priority: 'Medium',
        type: 'Bug',
        screenshot,
      });
      
      setDraftPriority('Medium');
      setDraftType('Bug');
      setDraft('');
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [active, pending, mode, isOverlayNode]);

  // Draw Mode mouse capture events
  const handleDrawingStart = (e: React.MouseEvent<HTMLDivElement>) => {
    if (mode !== 'draw' || pending) return;
    e.preventDefault();
    const x = e.clientX + window.scrollX;
    const y = e.clientY + window.scrollY;
    setTempStroke([{ x, y }]);
  };

  const handleDrawingMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!tempStroke) return;
    e.preventDefault();
    const x = e.clientX + window.scrollX;
    const y = e.clientY + window.scrollY;
    setTempStroke((prev) => (prev ? [...prev, { x, y }] : null));
  };

  const handleDrawingEnd = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!tempStroke) return;
    e.preventDefault();
    if (tempStroke.length > 2) {
      setPending({
        selector: 'Canvas Sketch',
        text: 'Freehand Drawing Sketch',
        x: tempStroke[0].x,
        y: tempStroke[0].y,
        drawing: [{
          points: tempStroke,
          color: '#f43f5e',
        }],
        priority: 'Medium',
        type: 'Bug',
      });
      setDraftPriority('Medium');
      setDraftType('Bug');
      setDraft('');
    }
    setTempStroke(null);
  };

  // Get dynamic coordinates of annotation markers
  const getAnnotationCoords = useCallback((a: Annotation) => {
    if (a.percentX !== undefined && a.percentY !== undefined) {
      try {
        const el = document.querySelector(a.selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          return {
            x: rect.left + window.scrollX + a.percentX * rect.width,
            y: rect.top + window.scrollY + a.percentY * rect.height,
            found: true,
          };
        }
      } catch {
        // Selector match error fallback
      }
    }
    return { x: a.x, y: a.y, found: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const saveComment = () => {
    if (!pending || !draft.trim()) return;
    
    const commentData = {
      comment: draft.trim(),
      priority: draftPriority,
      type: draftType,
    };

    if (pending.id) {
      // Edit
      setAnnotations((prev) => 
        prev.map(a => a.id === pending.id ? { ...a, ...commentData } : a)
      );
    } else {
      // Add
      setAnnotations((prev) => [
        ...prev,
        {
          id: idRef.current++,
          selector: pending.selector,
          text: pending.text,
          comment: commentData.comment,
          priority: commentData.priority,
          type: commentData.type,
          x: pending.x,
          y: pending.y,
          percentX: pending.percentX,
          percentY: pending.percentY,
          sourceFile: pending.sourceFile,
          sourceLine: pending.sourceLine,
          screenshot: pending.screenshot,
          drawing: pending.drawing,
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
      .map((a, i) => {
        let details = `${i + 1}. Element: ${a.selector}\n`;
        if (a.sourceFile) {
          details += `   Source Code: ${a.sourceFile}:${a.sourceLine}\n`;
        }
        details += `   Visible Text: "${a.text}"\n`;
        details += `   Type: ${a.type || 'Bug'} | Priority: ${a.priority || 'Medium'}\n`;
        details += `   Change Requested: ${a.comment}`;
        if (a.screenshot) {
          details += `\n   Screenshot Attachment: [Stored in data JSON]`;
        }
        if (a.drawing) {
          details += `\n   Visual Canvas Sketch: [Shapes drawn on screen]`;
        }
        return details;
      })
      .join('\n\n');
      
    const text = `${promptPrefix}\n\n${body}`;
    
    if (onCopy) {
      onCopy(text, annotations);
      return;
    }
    
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        // Fallback
      }
    }
    
    if (!copied) {
      copied = fallbackCopyText(text);
    }
    
    if (copied) {
      alert('Copied! Paste it to your coding agent.');
    } else {
      alert('Could not copy to clipboard. Please copy it manually.');
    }
  };

  if (!mounted) return null;

  const panel: React.CSSProperties = {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: 13,
    boxSizing: 'border-box',
  };

  const glassStyle: React.CSSProperties = {
    background: 'rgba(15, 23, 42, 0.88)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2)',
  };

  let activeCoords = { x: 0, y: 0 };
  if (pending) {
    if (pending.id) {
      const match = annotations.find((a) => a.id === pending.id);
      activeCoords = match ? getAnnotationCoords(match) : { x: pending.x, y: pending.y };
    } else {
      activeCoords = { x: pending.x, y: pending.y };
    }
  }

  const getCommentBoxStyle = (coords: { x: number; y: number }): React.CSSProperties => {
    const docWidth = document.documentElement.scrollWidth || window.innerWidth;
    const docHeight = document.documentElement.scrollHeight || window.innerHeight;
    
    const width = 310;
    const height = 310; // Extra room for tags and screenshot thumbnails
    
    let left = coords.x + 16;
    if (left + width > docWidth) {
      left = Math.max(16, coords.x - width - 16);
    }
    
    let top = coords.y + 16;
    if (top + height > docHeight) {
      top = Math.max(16, coords.y - height - 16);
    }
    
    return {
      ...panel,
      ...glassStyle,
      position: 'absolute',
      top,
      left,
      width,
      color: '#f8fafc',
      borderRadius: 16,
      padding: 16,
      zIndex: 2147483649,
      animation: 'annot-slide-in 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards',
    };
  };

  const getMarkerColor = (type?: string, isEditing?: boolean) => {
    if (isEditing) return 'linear-gradient(135deg, #3b82f6, #1d4ed8)'; // Indigo edit glow
    switch (type) {
      case 'Styling': return 'linear-gradient(135deg, #6366f1, #4f46e5)'; // Indigo
      case 'Feature': return 'linear-gradient(135deg, #10b981, #059669)'; // Emerald
      case 'Refactor': return 'linear-gradient(135deg, #f59e0b, #d97706)'; // Amber
      case 'Bug':
      default:
        return 'linear-gradient(135deg, #f43f5e, #e11d48)'; // Red Rose
    }
  };

  return createPortal(
    <div data-annot-ui>
      {/* Floating Highlight overlay bounding box */}
      {hoveredRect && (
        <div
          style={{
            position: 'absolute',
            top: hoveredRect.top,
            left: hoveredRect.left,
            width: hoveredRect.width,
            height: hoveredRect.height,
            border: '2px solid #6366f1',
            borderRadius: 6,
            pointerEvents: 'none',
            zIndex: 2147483645,
            boxSizing: 'border-box',
            boxShadow: '0 0 0 9999px rgba(99, 102, 241, 0.01), 0 0 14px rgba(99, 102, 241, 0.45)',
            transition: 'all 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        />
      )}

      {/* SVG Canvas drawing display */}
      <svg
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 2147483641,
        }}
      >
        {/* Draw completed saved strokes */}
        {annotations.map((a) =>
          a.drawing?.map((stroke, idx) => (
            <path
              key={`${a.id}-${idx}`}
              d={`M ${stroke.points.map((p) => `${p.x} ${p.y}`).join(' L ')}`}
              fill="none"
              stroke={pending?.id === a.id ? '#3b82f6' : stroke.color}
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                filter: pending?.id === a.id
                  ? 'drop-shadow(0 0 5px rgba(59, 130, 246, 0.7))'
                  : 'drop-shadow(0 0 4px rgba(244, 63, 94, 0.4))',
              }}
            />
          ))
        )}

        {/* Draw temporary stroke currently being sketched */}
        {tempStroke && tempStroke.length > 1 && (
          <path
            d={`M ${tempStroke.map((p) => `${p.x} ${p.y}`).join(' L ')}`}
            fill="none"
            stroke="#f43f5e"
            strokeWidth={3.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              filter: 'drop-shadow(0 0 4px rgba(244, 63, 94, 0.6))',
            }}
          />
        )}
      </svg>

      {/* Transparent Overlay panel for capture sketching in Draw Mode */}
      {active && mode === 'draw' && !pending && (
        <div
          onMouseDown={handleDrawingStart}
          onMouseMove={handleDrawingMove}
          onMouseUp={handleDrawingEnd}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'auto',
            zIndex: 2147483640,
            cursor: 'crosshair',
            background: 'rgba(0, 0, 0, 0.01)', // tiny background to capture clicks in empty areas
          }}
        />
      )}

      {/* Main Toolbar */}
      <div 
        className="annot-glass-panel"
        style={{ 
          ...panel, 
          ...glassStyle,
          position: 'fixed',
          ...CORNERS[position], 
          display: 'flex', 
          gap: 12, 
          alignItems: 'center',
          padding: '8px 14px',
          borderRadius: 16,
          zIndex: 2147483647,
        }}
      >
        {active && (
          <div className="annot-mode-toggle">
            <button
              onClick={() => setMode('inspect')}
              className={`annot-mode-btn ${mode === 'inspect' ? 'active' : ''}`}
            >
              Inspect
            </button>
            <button
              onClick={() => setMode('draw')}
              className={`annot-mode-btn ${mode === 'draw' ? 'active' : ''}`}
            >
              Draw
            </button>
          </div>
        )}

        {annotations.length > 0 && (
          <>
            <button
              onClick={clearAll}
              className="annot-btn"
              style={{
                background: 'transparent',
                color: '#94a3b8',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                padding: '6px 12px',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)';
                e.currentTarget.style.color = '#f87171';
                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = '#94a3b8';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
              }}
            >
              Clear
            </button>
            <button
              onClick={copyForAgent}
              className="annot-btn"
              style={{
                background: 'linear-gradient(135deg, #10b981, #059669)',
                color: '#fff',
                boxShadow: '0 4px 12px rgba(16, 185, 129, 0.25)',
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
          className="annot-btn"
          style={{
            background: active 
              ? 'linear-gradient(135deg, #f43f5e, #be123c)' 
              : 'linear-gradient(135deg, #6366f1, #4f46e5)',
            color: '#fff',
            boxShadow: active 
              ? '0 4px 12px rgba(244, 63, 94, 0.3)' 
              : '0 4px 12px rgba(99, 102, 241, 0.3)',
          }}
        >
          {active ? `Annotating… (${mode})` : 'Annotate'}
        </button>
      </div>

      {/* Saved markers */}
      {annotations.map((a, i) => {
        const coords = getAnnotationCoords(a);
        const isEditing = pending?.id === a.id;
        
        return (
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
                percentX: a.percentX,
                percentY: a.percentY,
                sourceFile: a.sourceFile,
                sourceLine: a.sourceLine,
                priority: a.priority,
                type: a.type,
                screenshot: a.screenshot,
                drawing: a.drawing,
              });
              setDraft(a.comment);
              setDraftPriority(a.priority || 'Medium');
              setDraftType(a.type || 'Bug');
              setActive(true);
            }}
            className="annot-marker"
            style={{
              ...panel,
              position: 'absolute',
              top: coords.y - 14,
              left: coords.x - 14,
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: getMarkerColor(a.type, isEditing),
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: 12,
              cursor: 'pointer',
              boxShadow: isEditing 
                ? '0 0 16px rgba(59, 130, 246, 0.8), 0 4px 8px rgba(0, 0, 0, 0.3)' 
                : `0 0 12px rgba(244, 63, 94, 0.5), 0 4px 8px rgba(0, 0, 0, 0.3)`,
              border: '2px solid #ffffff',
              zIndex: isEditing ? 2147483648 : 2147483646,
              animation: isEditing 
                ? 'annot-pulse-blue 2s infinite' 
                : 'annot-pulse-red 2s infinite',
            }}
          >
            {i + 1}
          </div>
        );
      })}

      {/* Comment box for pending clicks or edits */}
      {pending && (
        <div style={getCommentBoxStyle(activeCoords)}>
          {/* File source mapping header */}
          <div 
            style={{ 
              fontSize: 10, 
              color: '#94a3b8', 
              marginBottom: 8, 
              wordBreak: 'break-all',
              fontFamily: 'monospace',
              background: 'rgba(0, 0, 0, 0.2)',
              padding: '4px 6px',
              borderRadius: 6,
              border: '1px solid rgba(255, 255, 255, 0.05)',
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' }}>
              {pending.sourceFile ? pending.sourceFile : pending.selector}
            </span>
            {pending.sourceFile && (
              <span style={{ color: '#6366f1', fontWeight: 'bold' }}>
                L{pending.sourceLine}
              </span>
            )}
          </div>

          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComment();
            }}
            placeholder={placeholder}
            className="annot-textarea"
            style={{
              width: '100%',
              minHeight: 65,
              background: 'rgba(15, 23, 42, 0.6)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: 10,
              padding: 10,
              fontSize: 13,
              color: '#f8fafc',
              resize: 'vertical',
              boxSizing: 'border-box',
              outline: 'none',
              fontFamily: 'inherit',
              transition: 'all 0.2s',
            }}
          />

          {/* Tags selectors & Screenshot thumbnail container */}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
              <span style={{ fontSize: 9, color: '#64748b', fontWeight: 'bold' }}>TYPE</span>
              <select
                value={draftType}
                onChange={(e: any) => setDraftType(e.target.value)}
                className="annot-select"
              >
                <option value="Bug">🐛 Bug</option>
                <option value="Styling">🎨 Style</option>
                <option value="Feature">✨ Feature</option>
                <option value="Refactor">⚙️ Refactor</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
              <span style={{ fontSize: 9, color: '#64748b', fontWeight: 'bold' }}>PRIORITY</span>
              <select
                value={draftPriority}
                onChange={(e: any) => setDraftPriority(e.target.value)}
                className="annot-select"
              >
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
              </select>
            </div>

            {/* Render Screenshot thumbnail if captured */}
            {pending.screenshot && (
              <div 
                style={{ 
                  width: 42, 
                  height: 42, 
                  borderRadius: 6, 
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  background: `url(${pending.screenshot}) no-repeat center center`,
                  backgroundSize: 'cover',
                  marginTop: 12,
                  boxShadow: '0 4px 6px rgba(0, 0, 0, 0.2)',
                  cursor: 'zoom-in',
                }}
                onClick={() => {
                  const w = window.open();
                  w?.document.write(`<img src="${pending.screenshot}" style="max-width:100%; max-height:100%;" />`);
                }}
                title="Zoom Screenshot"
              />
            )}
          </div>

          {/* Comment box controls */}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              onClick={saveComment}
              className="annot-btn"
              style={{
                background: 'linear-gradient(135deg, #10b981, #059669)',
                color: '#fff',
                padding: '7px 14px',
                flex: 1,
                boxShadow: '0 4px 10px rgba(16, 185, 129, 0.2)',
              }}
            >
              Save
            </button>
            {pending.id && (
              <button
                onClick={deleteComment}
                className="annot-btn"
                style={{
                  background: 'rgba(239, 68, 68, 0.15)',
                  color: '#f87171',
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                  padding: '7px 12px',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'linear-gradient(135deg, #ef4444, #e11d48)';
                  e.currentTarget.style.color = '#fff';
                  e.currentTarget.style.borderColor = 'transparent';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)';
                  e.currentTarget.style.color = '#f87171';
                  e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.2)';
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
              className="annot-btn"
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                color: '#cbd5e1',
                border: '1px solid rgba(255, 255, 255, 0.05)',
                padding: '7px 12px',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.14)';
                e.currentTarget.style.color = '#fff';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                e.currentTarget.style.color = '#cbd5e1';
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}

export default AnnotationOverlay;


