'use client';

import { useRouter } from 'next/navigation';

/**
 * Native calendar picker: click the field, the browser pops a month calendar,
 * pick a day, and we navigate to `${base}/<picked date>${suffix}`. This is the
 * conventional "jump to a day" control, instead of stepping with arrows.
 */
export function DateJump({ date, base, suffix = '' }: { date: string; base: string; suffix?: string }) {
  const router = useRouter();
  return (
    <input
      type="date"
      value={date}
      onChange={(e) => {
        if (e.target.value) router.push(`${base}/${e.target.value}${suffix}`);
      }}
      style={{ fontWeight: 600 }}
      aria-label="Pick a date"
    />
  );
}
