import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { searchTowns, zipsFor } from "@/lib/places.functions";
import type { Town } from "@/lib/places";

/**
 * The town box: a few letters offer the towns they could be; choosing one
 * fills in the town, its state and the country, and its postal code where
 * the town has only one. A town with several shows them to pick from —
 * a postal code is typed onto every application, so it is never guessed.
 * Typing a town the list does not have still works: it is kept as typed.
 */
export function TownField(props: {
  className: string;
  value: string;
  onType: (city: string) => void;
  onChoose: (place: { city: string; state: string; country: string; postal_code?: string }) => void;
}) {
  const search = useServerFn(searchTowns);
  const zips = useServerFn(zipsFor);
  const [towns, setTowns] = useState<Town[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<string[]>([]);
  const asked = useRef(0);
  const typed = useRef(false);

  // Ask a moment after the typing stops, and only for something typed here:
  // not for the town already on file when the page opens.
  useEffect(() => {
    if (!typed.current || props.value.trim().length < 3) {
      setTowns([]);
      return;
    }
    const mine = ++asked.current;
    const t = setTimeout(async () => {
      setBusy(true);
      const r = await search({ data: { q: props.value } }).catch(() => ({ towns: [] as Town[] }));
      if (mine !== asked.current) return;
      setBusy(false);
      setTowns(r.towns);
      setOpen(true);
    }, 350);
    return () => clearTimeout(t);
  }, [props.value, search]);

  async function choose(t: Town) {
    typed.current = false;
    setOpen(false);
    setTowns([]);
    setChoices([]);
    props.onChoose({ city: t.city, state: t.state, country: "United States" });
    const r = await zips({ data: { city: t.city, state: t.state } }).catch(() => ({ zips: [] as string[] }));
    if (r.zips.length === 1) props.onChoose({ city: t.city, state: t.state, country: "United States", postal_code: r.zips[0]! });
    else setChoices(r.zips);
  }

  return (
    <div className="relative">
      <input
        className={props.className}
        value={props.value}
        autoComplete="off"
        placeholder="start typing your town"
        onChange={(e) => { typed.current = true; setChoices([]); props.onType(e.target.value); }}
        onFocus={() => towns.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (towns.length || busy) ? (
        <div className="absolute z-20 mt-1 w-full border border-border bg-card text-xs shadow-lg">
          {towns.map((t) => (
            <button key={t.label} type="button" className="block w-full px-2 py-1.5 text-left hover:bg-background" onMouseDown={(e) => e.preventDefault()} onClick={() => void choose(t)}>
              {t.label}
            </button>
          ))}
          {!towns.length && busy ? <div className="px-2 py-1.5 text-muted-foreground">looking…</div> : null}
        </div>
      ) : null}
      {choices.length > 1 ? (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted-foreground">this town has {choices.length} postal codes; pick yours:</span>
          {choices.slice(0, 24).map((z) => (
            <button key={z} type="button" className="border border-border px-1.5 py-0.5 hover:border-primary" onClick={() => { props.onChoose({ city: townName(props.value), state: "", country: "United States", postal_code: z }); setChoices([]); }}>
              {z}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const townName = (v: string) => v.split(",")[0]!.trim();
