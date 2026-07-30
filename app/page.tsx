"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ────────────────────────── model ────────────────────────── */

type Item = { id: string; label: string; amount: string; rec: boolean };
type Side = "in" | "out";
type Month = { in: Item[]; out: Item[] };
type Data = { v: 1; cur: string; months: Record<string, Month> };

const KEY = "aihlete.money.v1";
const CURRENCIES = ["RM", "$", "€", "£", "¥", "₹", "S$", "A$"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const empty = (): Data => ({ v: 1, cur: "RM", months: {} });

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(key: string, n: number) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return monthKey(d);
}

function monthLabel(key: string) {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** "1,500" · "2.5k" · "rm 90" all land as numbers. */
function parseAmt(raw: string) {
  const t = raw.toLowerCase().replace(/[^0-9.k-]/g, "");
  if (!t) return 0;
  const mult = t.endsWith("k") ? 1000 : 1;
  const n = parseFloat(t.replace(/k/g, ""));
  return Number.isFinite(n) ? n * mult : 0;
}

const sum = (items: Item[]) => items.reduce((a, i) => a + parseAmt(i.amount), 0);

/** Tidy what you typed once you leave the field: "12k" → "12,000". */
function tidy(raw: string) {
  if (!raw.trim()) return "";
  const n = parseAmt(raw);
  if (!n) return raw.trim();
  return n.toLocaleString("en-US", {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function money(n: number, cur: string) {
  const abs = Math.abs(n);
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: abs % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${cur}${body}`;
}

/**
 * A month you haven't touched yet inherits the recurring lines from the last
 * month you did touch — the way the old sheet repeated the same rows every
 * column. Inherited months are previews: nothing is written until you edit.
 */
function resolve(data: Data, key: string): Month {
  const own = data.months[key];
  if (own) return own;
  for (let i = 1; i <= 36; i++) {
    const prev = data.months[shiftMonth(key, -i)];
    if (!prev) continue;
    // ids must be deterministic: an inherited row keeps the same identity
    // between the preview render and the moment an edit materialises it,
    // otherwise React remounts the input mid-keystroke and focus is lost.
    const carry = (s: Side) =>
      prev[s].filter((x) => x.rec).map((x) => ({ ...x, id: `${key}:${x.id}` }));
    return { in: carry("in"), out: carry("out") };
  }
  return { in: [], out: [] };
}

/* ────────────────────────── page ────────────────────────── */

export default function Page() {
  const [data, setData] = useState<Data>(empty);
  const [key, setKey] = useState(() => monthKey(new Date()));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const p = JSON.parse(raw) as Data;
        if (p && p.months) setData({ v: 1, cur: p.cur || "RM", months: p.months });
      }
    } catch {
      /* corrupted store — start clean rather than crash */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(KEY, JSON.stringify(data));
  }, [data, ready]);

  const month = useMemo(() => resolve(data, key), [data, key]);

  /** Materialise the shown month (it may be an inherited preview), then edit. */
  const edit = useCallback(
    (side: Side, fn: (items: Item[]) => Item[]) => {
      setData((d) => {
        const cur = resolve(d, key);
        return {
          ...d,
          months: { ...d.months, [key]: { ...cur, [side]: fn(cur[side]) } },
        };
      });
    },
    [key],
  );

  const income = sum(month.in);
  const spend = sum(month.out);
  const net = income - spend;
  const rate = income > 0 ? Math.round((net / income) * 100) : 0;

  const strip = useMemo(() => {
    const keys = Array.from({ length: 12 }, (_, i) => shiftMonth(key, i - 11));
    const nets = keys.map((k) => {
      const m = resolve(data, k);
      return sum(m.in) - sum(m.out);
    });
    const peak = Math.max(1, ...nets.map(Math.abs));
    return keys.map((k, i) => ({ k, net: nets[i], h: Math.abs(nets[i]) / peak }));
  }, [data, key]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `aihlete-money-${key}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = (file: File) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const p = JSON.parse(String(r.result)) as Data;
        if (p && p.months) setData({ v: 1, cur: p.cur || "RM", months: p.months });
      } catch {
        alert("that file isn't a money export");
      }
    };
    r.readAsText(file);
  };

  if (!ready) return <main className="wrap" />;

  const verb = net > 0 ? "left over in" : net < 0 ? "short in" : "even in";
  const shownMonth = MONTH_NAMES[Number(key.split("-")[1]) - 1].toLowerCase();

  return (
    <main className="wrap">
      <div className="top">
        <div className="brand">
          aihlete <span>/ money</span>
        </div>
        <div className="monthnav">
          <button onClick={() => setKey(shiftMonth(key, -1))} aria-label="previous month">
            ‹
          </button>
          <div className="label">{monthLabel(key)}</div>
          <button onClick={() => setKey(shiftMonth(key, 1))} aria-label="next month">
            ›
          </button>
        </div>
      </div>

      <div className="hero">
        <span className={`amount${net < 0 ? " short" : ""}`}>
          {net < 0 ? "−" : ""}
          {money(net, data.cur)}
        </span>
        <span className="cap">
          {verb} {shownMonth}
          {income > 0
            ? net < 0
              ? ` · ${Math.abs(rate)}% more than you make`
              : ` · ${rate}% of what you make`
            : ""}
        </span>
      </div>

      <div className="cols">
        <List
          title="Coming in"
          total={money(income, data.cur)}
          items={month.in}
          onEdit={(fn) => edit("in", fn)}
          placeholder="salary"
        />
        <List
          title="Going out"
          total={money(spend, data.cur)}
          items={month.out}
          onEdit={(fn) => edit("out", fn)}
          placeholder="rent"
        />
      </div>

      <div className="strip">
        <div className="bars">
          {strip.map((b) => (
            <button
              key={b.k}
              className={`bar${b.net < 0 ? " neg" : ""}${b.k === key ? " now" : ""}`}
              onClick={() => setKey(b.k)}
              title={`${monthLabel(b.k)} · ${b.net < 0 ? "−" : ""}${money(b.net, data.cur)}`}
            >
              <i style={{ height: `${Math.max(1, b.h * 100)}%` }} />
            </button>
          ))}
        </div>
        <div className="keys">
          {strip.map((b) => (
            <span key={b.k} className={b.k === key ? "now" : ""}>
              {MONTH_NAMES[Number(b.k.split("-")[1]) - 1][0]}
            </span>
          ))}
        </div>
      </div>

      <div className="foot">
        <div>private · saved on this device · • repeats every month</div>
        <div className="acts">
          <button
            onClick={() =>
              setData((d) => ({
                ...d,
                cur: CURRENCIES[(CURRENCIES.indexOf(d.cur) + 1) % CURRENCIES.length],
              }))
            }
          >
            {data.cur}
          </button>
          <button onClick={exportJson}>export</button>
          <label>
            <button onClick={(e) => (e.currentTarget.nextElementSibling as HTMLInputElement)?.click()}>
              import
            </button>
            <input
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importJson(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
    </main>
  );
}

/* ────────────────────────── list ────────────────────────── */

function List({
  title,
  total,
  items,
  onEdit,
  placeholder,
}: {
  title: string;
  total: string;
  items: Item[];
  onEdit: (fn: (items: Item[]) => Item[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState({ label: "", amount: "" });
  const labelRef = useRef<HTMLInputElement>(null);

  const commit = () => {
    if (!draft.label.trim() && !draft.amount.trim()) return;
    onEdit((list) => [
      ...list,
      { id: uid(), label: draft.label.trim(), amount: tidy(draft.amount), rec: true },
    ]);
    setDraft({ label: "", amount: "" });
  };

  const patch = (id: string, p: Partial<Item>) =>
    onEdit((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)));

  const drop = (id: string) => onEdit((list) => list.filter((i) => i.id !== id));

  return (
    <section className="col">
      <h2>
        {title} <b>{total}</b>
      </h2>

      {items.map((i) => (
        <div className="row" key={i.id}>
          <button
            className={`dot${i.rec ? " on" : ""}`}
            title={i.rec ? "repeats every month" : "one-off"}
            onClick={() => patch(i.id, { rec: !i.rec })}
          >
            •
          </button>
          <input
            className="label"
            value={i.label}
            placeholder="what"
            onChange={(e) => patch(i.id, { label: e.target.value })}
            onBlur={() => {
              if (!i.label.trim() && !i.amount.trim()) drop(i.id);
            }}
          />
          <input
            className="val"
            value={i.amount}
            placeholder="0"
            inputMode="decimal"
            onChange={(e) => patch(i.id, { amount: e.target.value })}
            onBlur={() => {
              const t = tidy(i.amount);
              if (t !== i.amount) patch(i.id, { amount: t });
              if (!i.label.trim() && !t) drop(i.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                patch(i.id, { amount: tidy(i.amount) });
                labelRef.current?.focus();
              }
            }}
          />
          <button className="del" title="remove" onClick={() => drop(i.id)}>
            ×
          </button>
        </div>
      ))}

      <div
        className="row draft"
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          commit();
        }}
      >
        <span className="dot" aria-hidden>
          +
        </span>
        <input
          ref={labelRef}
          className="label"
          value={draft.label}
          placeholder={items.length ? "add" : placeholder}
          onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <input
          className="val"
          value={draft.amount}
          placeholder="0"
          inputMode="decimal"
          onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              labelRef.current?.focus();
            }
          }}
        />
        <span className="del" aria-hidden />
      </div>
    </section>
  );
}
