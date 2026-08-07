'use client';

import { useState } from 'react';

/** One pre-positioned horizontal strip segment (percent-based — the server did
 *  all the time math; this component only draws and handles clicks). */
export interface PreparedStripSegment {
  leftPct: number;
  widthPct: number;
  color: string;
  durLabel: string; // "47m" / "1h 20m" — REAL seconds in the segment
  catLabel: string; // "Billable" / "Idle (at desk)" / …
  rangeLabel: string; // "9:05a–9:50a"
}
export interface PreparedStripTick {
  label: string;
  leftPct: number;
}

const POPUP_ZONE = 46; // headroom above the bar for the click bubble

/**
 * The horizontal workday strip (Today / Reporting day view). Click any painted
 * block — billable, non-billable, or idle — to pin a small bubble above it with
 * how long it was; click it again (or another block) to move/dismiss it.
 */
export function DayStripView({
  segments,
  ticks,
  label,
}: {
  segments: PreparedStripSegment[];
  ticks: PreparedStripTick[];
  label?: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const sel = selected != null ? segments[selected] : undefined;
  // Bubble centre: middle of the segment, clamped so it can't run off the edges.
  const centrePct = sel ? Math.min(96, Math.max(4, sel.leftPct + sel.widthPct / 2)) : 0;

  return (
    <div style={{ margin: '4px 0 2px' }}>
      {label && <div className="small muted" style={{ marginBottom: 2 }}>{label}</div>}
      <div style={{ position: 'relative', height: POPUP_ZONE }}>
        {sel && (
          <div
            style={{
              position: 'absolute',
              left: `${centrePct}%`,
              bottom: 4,
              transform: 'translateX(-50%)',
              background: '#fff',
              border: '1px solid #d7dbe0',
              borderRadius: 10,
              boxShadow: '0 3px 10px rgba(0,0,0,0.14)',
              padding: '4px 12px',
              textAlign: 'center',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 2,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.15 }}>{sel.durLabel}</div>
            <div className="muted" style={{ fontSize: 10 }}>
              {sel.catLabel} · {sel.rangeLabel}
            </div>
            <span
              style={{
                position: 'absolute', left: '50%', bottom: -7, transform: 'translateX(-50%)',
                width: 0, height: 0,
                borderLeft: '7px solid transparent', borderRight: '7px solid transparent',
                borderTop: '7px solid #d7dbe0',
              }}
            />
            <span
              style={{
                position: 'absolute', left: '50%', bottom: -5, transform: 'translateX(-50%)',
                width: 0, height: 0,
                borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
                borderTop: '6px solid #fff',
              }}
            />
          </div>
        )}
      </div>
      <div
        onClick={() => setSelected(null)}
        style={{
          position: 'relative',
          height: 22,
          borderRadius: 6,
          background: 'rgba(150,158,168,0.18)', // "away" track: light translucent gray
          overflow: 'hidden',
        }}
      >
        {segments.map((s, i) => (
          <span
            key={i}
            onClick={(e) => {
              e.stopPropagation();
              setSelected((cur) => (cur === i ? null : i));
            }}
            style={{
              position: 'absolute',
              left: `${s.leftPct}%`,
              width: `${s.widthPct}%`,
              top: 0,
              bottom: 0,
              background: s.color,
              cursor: 'pointer',
              outline: selected === i ? '2px solid #133048' : 'none',
              outlineOffset: -2,
            }}
          />
        ))}
      </div>
      <div style={{ position: 'relative', height: 14 }}>
        {ticks.map((t) => (
          <span
            key={t.label}
            className="muted"
            style={{
              position: 'absolute',
              left: `${t.leftPct}%`,
              transform: 'translateX(-50%)',
              fontSize: 10,
            }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
