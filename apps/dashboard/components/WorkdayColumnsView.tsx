'use client';

import { useState } from 'react';

/** One vertical bar's worth of pre-positioned segments (percent-based, so this
 *  client view needs no time math — the server prepared it). */
export interface PreparedDay {
  key: string;
  label: string;
  sublabel?: string;
  workedLabel: string; // e.g. "9.40h"
  segments: Array<{ topPct: number; heightPct: number; color: string }>;
}
export interface PreparedTick {
  label: string;
  topPct: number;
}

const TRACK_BG = 'rgba(150,158,168,0.18)';
const AXIS_GAP = 8; // gap between the time axis and the first column
const POPUP_ZONE = 48; // headroom reserved above the bars for the click popup

/**
 * The interactive multi-day workday view (Reporting week/month). Click a day to
 * pin a small popup above the bars showing hours worked that day; click it again
 * (or another day) to move/dismiss it. All positioning is percent-based from
 * server-prepared data, so no time math runs on the client.
 */
export function WorkdayColumnsView({
  days,
  ticks,
  height,
  colWidth,
  colGap,
  axisWidth,
}: {
  days: PreparedDay[];
  ticks: PreparedTick[];
  height: number;
  colWidth: number;
  colGap: number;
  axisWidth: number;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  // x of a column's centre, measured from the container's left edge.
  const centreOf = (i: number) => axisWidth + AXIS_GAP + i * (colWidth + colGap) + colWidth / 2;
  const innerWidth = axisWidth + AXIS_GAP + days.length * (colWidth + colGap);

  return (
    <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
      <div style={{ position: 'relative', minWidth: innerWidth }}>
        {/* popup zone above the bars */}
        <div style={{ position: 'relative', height: POPUP_ZONE }}>
          {selected != null && days[selected] && (
            <div
              style={{
                position: 'absolute',
                left: centreOf(selected),
                bottom: 6,
                transform: 'translateX(-50%)',
                background: '#fff',
                border: '1px solid #d7dbe0',
                borderRadius: 10,
                boxShadow: '0 3px 10px rgba(0,0,0,0.14)',
                padding: '5px 12px',
                textAlign: 'center',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.1 }}>{days[selected]!.workedLabel}</div>
              <div className="muted" style={{ fontSize: 10 }}>worked</div>
              {/* downward caret: border-colored triangle behind, white triangle in front */}
              <span
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: -7,
                  transform: 'translateX(-50%)',
                  width: 0,
                  height: 0,
                  borderLeft: '7px solid transparent',
                  borderRight: '7px solid transparent',
                  borderTop: '7px solid #d7dbe0',
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: -5,
                  transform: 'translateX(-50%)',
                  width: 0,
                  height: 0,
                  borderLeft: '6px solid transparent',
                  borderRight: '6px solid transparent',
                  borderTop: '6px solid #fff',
                }}
              />
            </div>
          )}
        </div>

        {/* time axis + day columns */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: AXIS_GAP }}>
          <div style={{ position: 'relative', width: axisWidth, height, flex: '0 0 auto' }}>
            {ticks.map((t) => (
              <span
                key={t.label}
                className="muted"
                style={{
                  position: 'absolute',
                  top: `${t.topPct}%`,
                  right: 2,
                  transform: 'translateY(-50%)',
                  fontSize: 10,
                  whiteSpace: 'nowrap',
                }}
              >
                {t.label}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: colGap }}>
            {days.map((d, i) => (
              <div
                key={d.key}
                onClick={() => setSelected((cur) => (cur === i ? null : i))}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  width: colWidth,
                  flex: '0 0 auto',
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    position: 'relative',
                    width: '100%',
                    height,
                    borderRadius: 5,
                    background: TRACK_BG,
                    overflow: 'hidden',
                    outline: selected === i ? '2px solid #1f8a4c' : 'none',
                    outlineOffset: 1,
                  }}
                >
                  {d.segments.map((s, j) => (
                    <span
                      key={j}
                      style={{
                        position: 'absolute',
                        top: `${s.topPct}%`,
                        height: `${s.heightPct}%`,
                        left: 0,
                        right: 0,
                        background: s.color,
                      }}
                    />
                  ))}
                </div>
                <div
                  className="muted"
                  style={{
                    fontSize: 10,
                    marginTop: 3,
                    textAlign: 'center',
                    lineHeight: 1.2,
                    fontWeight: selected === i ? 700 : undefined,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{d.label}</div>
                  {d.sublabel && <div>{d.sublabel}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
