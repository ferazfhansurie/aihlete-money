"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ────────────────────────── model ────────────────────────── */

type Item = { id: string; label: string; amount: string; rec: boolean; cnt?: boolean };
type Side = "in" | "out";
type Month = { in: Item[]; out: Item[] };
type Data = { v: 1; cur: string; months: Record<string, Month> };

const CODE_KEY = "aihlete.money.code";
/* sha256("aihlete-money-gate:<password>") — the password itself isn't in the
   bundle, and it doubles as the document key, so everyone who unlocks lands on
   the same numbers with no codes to pass around. */
const GATE_HASH = "70f937c7e61e98fc561e0132e5f3c48702163f618a3899fa852cfe5a9987f9ba";
const SYNC_URL = "https://aihlete-money-sync.vercel.app/api/doc";
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
  return `${MONTH_NAMES[m - 1].toLowerCase()} ${y}`;
}

/** "1,500" · "2.5k" · "rm 90" all land as numbers. */
function parseAmt(raw: string) {
  const t = raw.toLowerCase().replace(/[^0-9.k-]/g, "");
  if (!t) return 0;
  const mult = t.endsWith("k") ? 1000 : 1;
  const n = parseFloat(t.replace(/k/g, ""));
  return Number.isFinite(n) ? n * mult : 0;
}

const counted = (i: Item) => i.cnt !== false;
/** In-hand money: only lines you've ticked as actually landed. */
const sum = (items: Item[]) =>
  items.reduce((a, i) => (counted(i) ? a + parseAmt(i.amount) : a), 0);
/** Expected-but-not-landed: invoices you've sent, bills not yet paid. */
const pending = (items: Item[]) =>
  items.reduce((a, i) => (counted(i) ? a : a + parseAmt(i.amount)), 0);

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

/* ────────────────────────── shared store ──────────────────────────
 * No accounts. The password IS the key: the server document is keyed by
 * sha256(password), so the password never leaves the browser and everyone who
 * types it reads and writes the same numbers.
 */

const normalise = (code: string) => code.trim().toLowerCase().replace(/\s+/g, "");

async function sha(prefix: string, value: string) {
  const bytes = new TextEncoder().encode(`${prefix}${normalise(value)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function docId(code: string) {
  const bytes = new TextEncoder().encode(`aihlete-money:${normalise(code)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/* ────────────────────────── page ────────────────────────── */

export default function Page() {
  const [data, setData] = useState<Data>(empty);
  const [key, setKey] = useState(() => monthKey(new Date()));
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [gateErr, setGateErr] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "err">("idle");
  const [note, setNote] = useState("");
  const idRef = useRef<string | null>(null);
  const revRef = useRef(0);
  const dataRef = useRef<Data>(data);
  const dirtyRef = useRef(false);
  dataRef.current = data;
  dirtyRef.current = dirty;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(CODE_KEY);
      if (saved) setCode(saved);
    } catch {
      /* private-mode browsers can refuse storage; the gate still works */
    }
    setReady(true);
  }, []);

  const month = useMemo(() => resolve(data, key), [data, key]);

  /** Materialise the shown month (it may be an inherited preview), then edit. */
  const edit = useCallback(
    (side: Side, fn: (items: Item[]) => Item[]) => {
      setDirty(true);
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
  const dueIn = pending(month.in);
  const dueOut = pending(month.out);
  const net = income - spend;
  const rate = income > 0 ? Math.round((net / income) * 100) : 0;

  /**
   * Money rolls over. Every month's balance is every earlier month's leftovers
   * plus this month's net — so the strip is a balance curve, not 12 unrelated
   * bars, and the big number answers "how much do I actually have".
   */
  const { balances, shown } = useMemo(() => {
    const shownKeys = Array.from({ length: 12 }, (_, i) => shiftMonth(key, i - 11));
    const touched = Object.keys(data.months).sort();
    let cursor = shownKeys[0];
    if (touched.length && touched[0] < cursor) cursor = touched[0];
    const last = shownKeys[shownKeys.length - 1];
    const out: Record<string, number> = {};
    let running = 0;
    for (let guard = 0; cursor <= last && guard < 600; guard++) {
      const m = resolve(data, cursor);
      running += sum(m.in) - sum(m.out);
      out[cursor] = running;
      cursor = shiftMonth(cursor, 1);
    }
    return { balances: out, shown: shownKeys };
  }, [data, key]);

  const balance = balances[key] ?? net;
  const carry = balance - net;

  const strip = useMemo(() => {
    const vals = shown.map((k) => balances[k] ?? 0);
    const peak = Math.max(1, ...vals.map(Math.abs));
    return shown.map((k, i) => ({ k, bal: vals[i], h: Math.abs(vals[i]) / peak }));
  }, [shown, balances]);

  /** The database is the only truth. Nothing is read from this device. */
  const pull = useCallback(async (quiet = false) => {
    const id = idRef.current;
    if (!id) return;
    if (!quiet) setStatus("loading");
    try {
      const r = await fetch(`${SYNC_URL}?id=${id}`, { cache: "no-store" });
      if (r.status === 404) {
        revRef.current = 0;
        setData(empty());
        setLoaded(true);
        setStatus("idle");
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      const remote = await r.json();
      revRef.current = Number(remote.rev) || 0;
      setData({ v: 1, cur: remote.doc?.cur || "RM", months: remote.doc?.months || {} });
      setDirty(false);
      setLoaded(true);
      setStatus("idle");
      if (!quiet) setNote("");
    } catch {
      setStatus("err");
    }
  }, []);

  /** Only ever called by the save button — no background writes. */
  const save = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    setStatus("saving");
    try {
      const r = await fetch(SYNC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, rev: revRef.current, doc: dataRef.current }),
      });
      if (r.status === 409) {
        // someone saved between our load and our save — their version wins and
        // we show it, rather than silently overwriting their numbers.
        const winner = await r.json();
        revRef.current = Number(winner.rev) || 0;
        setData({ v: 1, cur: winner.doc?.cur || "RM", months: winner.doc?.months || {} });
        setDirty(false);
        setStatus("idle");
        setNote("another device saved first — showing theirs, redo your change");
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      const { rev } = await r.json();
      revRef.current = Number(rev) || 0;
      setDirty(false);
      setStatus("idle");
      setNote("saved");
    } catch {
      setStatus("err");
      setNote("save failed — still unsaved, try again");
    }
  }, []);

  /* unlock → load from the database */
  useEffect(() => {
    if (!ready || !code) return;
    let live = true;
    (async () => {
      idRef.current = await docId(code);
      if (live) await pull();
    })();
    return () => {
      live = false;
    };
  }, [ready, code, pull]);

  /* coming back to the tab refreshes — unless you have unsaved edits */
  useEffect(() => {
    if (!code) return;
    const onWake = () => {
      if (document.visibilityState === "visible" && !dirtyRef.current) void pull(true);
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [code, pull]);

  /* ⌘S / ctrl+S saves */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  /* warn before losing unsaved edits */
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  const unlock = async (candidate: string) => {
    if ((await sha("aihlete-money-gate:", candidate)) !== GATE_HASH) {
      setGateErr(true);
      return;
    }
    const c = normalise(candidate);
    localStorage.setItem(CODE_KEY, c);
    revRef.current = 0;
    setGateErr(false);
    setPw("");
    setCode(c);
  };

  const lock = () => {
    localStorage.removeItem(CODE_KEY);
    idRef.current = null;
    revRef.current = 0;
    setCode(null);
    setLoaded(false);
    setData(empty());
    setStatus("idle");
  };

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
        if (p && p.months) {
          setData({ v: 1, cur: p.cur || "RM", months: p.months });
          setDirty(true);
        }
      } catch {
        alert("that file isn't a money export");
      }
    };
    r.readAsText(file);
  };

  if (!ready)
    return (
      <>
        <div className="glow" aria-hidden />
        <main className="wrap" />
      </>
    );

  const shownMonth = MONTH_NAMES[Number(key.split("-")[1]) - 1].toLowerCase();
  const flow =
    net > 0
      ? `${money(net, data.cur)} left this month`
      : net < 0
        ? `${money(net, data.cur)} short this month`
        : "even this month";
  const sub = [
    carry !== 0
      ? `${carry < 0 ? "−" : ""}${money(carry, data.cur)} rolled over`
      : "",
    flow,
    income > 0 && net >= 0 ? `${rate}% saved` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const projected = balance + dueIn - dueOut;
  const expected =
    dueIn || dueOut
      ? `${projected < 0 ? "−" : ""}${money(projected, data.cur)} if the expected lands`
      : "";

  if (code && !loaded)
    return (
      <>
        <div className="glow" aria-hidden />
        <main className="wrap gate">
          <div className="brand">
            aihlete <span>/ money</span>
          </div>
          <p className="fine">
            {status === "err" ? "can't reach the database — " : "loading from the database…"}
            {status === "err" ? <button className="link" onClick={() => void pull()}>retry</button> : null}
          </p>
        </main>
      </>
    );

  if (!code)
    return (
      <>
        <div className="glow" aria-hidden />
        <main className="wrap gate">
          <div className="brand">
            aihlete <span>/ money</span>
          </div>
          <form
            className="lock card"
            onSubmit={(e) => {
              e.preventDefault();
              void unlock(pw);
            }}
          >
            <label htmlFor="pw">password</label>
            <input
              id="pw"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={pw}
              placeholder="••••••••"
              onChange={(e) => {
                setPw(e.target.value);
                setGateErr(false);
              }}
            />
            <button type="submit">open</button>
            {gateErr ? <p className="bad">wrong password</p> : null}
          </form>
          <p className="fine">one shared set of numbers. everyone who has the password sees the same thing.</p>
        </main>
      </>
    );

  return (
    <>
      <div className="glow" aria-hidden />
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
        <span className={`amount${balance < 0 ? " short" : ""}`}>
          {balance < 0 ? "−" : ""}
          {money(balance, data.cur)}
        </span>
        <span className="cap">in hand end of {shownMonth}</span>
        <span className="sub">{sub}</span>
        {expected ? <span className="exp">{expected}</span> : null}
      </div>

      <div className="cols">
        <List
          title="coming in"
          total={money(income, data.cur)}
          due={dueIn ? `+${money(dueIn, data.cur)} expected` : ""}
          items={month.in}
          onEdit={(fn) => edit("in", fn)}
          placeholder="salary"
        />
        <List
          title="going out"
          total={money(spend, data.cur)}
          due={dueOut ? `+${money(dueOut, data.cur)} expected` : ""}
          items={month.out}
          onEdit={(fn) => edit("out", fn)}
          placeholder="rent"
        />
      </div>

      <div className="strip card">
        <div className="bars">
          {strip.map((b) => (
            <button
              key={b.k}
              className={`bar${b.bal < 0 ? " neg" : ""}${b.bal === 0 ? " zero" : ""}${b.k === key ? " now" : ""}`}
              onClick={() => setKey(b.k)}
              title={`${monthLabel(b.k)} · ${b.bal < 0 ? "−" : ""}${money(b.bal, data.cur)} in hand`}
            >
              <i style={{ height: `${Math.max(1, b.h * 100)}%` }} />
            </button>
          ))}
        </div>
        <div className="keys">
          {strip.map((b) => (
            <span key={b.k} className={b.k === key ? "now" : ""}>
              {MONTH_NAMES[Number(b.k.split("-")[1]) - 1][0].toLowerCase()}
            </span>
          ))}
        </div>
      </div>

      <div className="foot">
        <div>
          {status === "loading"
            ? "loading…"
            : status === "saving"
              ? "saving…"
              : status === "err"
                ? "can't reach the database"
                : dirty
                  ? "unsaved changes"
                  : "saved · everyone with the password sees this"}
          {" · "}
          filled dot = repeats monthly
          {note && !dirty ? ` · ${note}` : ""}
        </div>
        <div className="acts">
          <button
            className={dirty ? "primary" : ""}
            disabled={!dirty || status === "saving"}
            onClick={() => void save()}
          >
            {status === "saving" ? "saving…" : dirty ? "save" : "saved"}
          </button>
          <button
            onClick={() => {
              if (dirty && !confirm("discard your unsaved changes and reload from the database?")) return;
              void pull();
            }}
          >
            refresh
          </button>
          <button
            onClick={() => {
              setDirty(true);
              setData((d) => ({
                ...d,
                cur: CURRENCIES[(CURRENCIES.indexOf(d.cur) + 1) % CURRENCIES.length],
              }));
            }}
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
          <button onClick={lock}>lock</button>
        </div>
      </div>

      </main>
    </>
  );
}

/* ────────────────────────── list ────────────────────────── */

function List({
  title,
  total,
  due,
  items,
  onEdit,
  placeholder,
}: {
  title: string;
  total: string;
  due: string;
  items: Item[];
  onEdit: (fn: (items: Item[]) => Item[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState({ label: "", amount: "" });
  const labelRef = useRef<HTMLInputElement>(null);

  const commit = () => {
    let label = draft.label.trim();
    let amount = draft.amount.trim();
    // Typing a bare number into the name field is the obvious phone mistake —
    // treat it as the amount instead of a line called "5700" worth nothing.
    if (!amount && /^[\d.,]+k?$/i.test(label)) {
      amount = label;
      label = "";
    }
    if (!label && !amount) return;
    onEdit((list) => [...list, { id: uid(), label, amount: tidy(amount), rec: true }]);
    setDraft({ label: "", amount: "" });
  };

  const patch = (id: string, p: Partial<Item>) =>
    onEdit((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)));

  const drop = (id: string) => onEdit((list) => list.filter((i) => i.id !== id));

  return (
    <section className="col card">
      <h2>
        <span>
          {title}
          {due ? <em>{due}</em> : null}
        </span>
        <b>{total}</b>
      </h2>

      {items.map((i) => (
        <div className={`row${counted(i) ? "" : " pending"}`} key={i.id}>
          <button
            className={`dot${i.rec ? " on" : ""}`}
            title={i.rec ? "repeats every month" : "one-off"}
            onClick={() => patch(i.id, { rec: !i.rec })}
            aria-label={i.rec ? "repeats every month" : "one-off"}
          />
          <input
            className="label"
            value={i.label}
            placeholder="what"
            onChange={(e) => patch(i.id, { label: e.target.value })}
            onBlur={() => {
              const l = i.label.trim();
              if (!l && !i.amount.trim()) return drop(i.id);
              if (!i.amount.trim() && /^[\d.,]+k?$/i.test(l))
                patch(i.id, { label: "", amount: tidy(l) });
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
          <button
            className={`chk${counted(i) ? " on" : ""}`}
            title={counted(i) ? "counted as in hand" : "expected only — not counted"}
            aria-label={counted(i) ? "counted as in hand" : "expected only"}
            onClick={() => patch(i.id, { cnt: !counted(i) })}
          >
            <i>✓</i>
          </button>
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
        <span className="dot plus" aria-hidden>
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
        <span className="chk" aria-hidden />
        <span className="del" aria-hidden />
      </div>
    </section>
  );
}
