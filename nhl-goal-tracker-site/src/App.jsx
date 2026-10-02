import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  ComposedChart,
  Bar,
  BarChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

/* ----------------------------------------------------------------------- *
 *  Design tokens
 *  Color   — rink-ice #EEF3F6 (bg), rink-navy #0B2545 (ink/structure),
 *            ice-blue #2FB6C4 (cold), ember #FF5A36 (hot),
 *            slate #56646E (body text)
 *  Layout  — left rail (live search + watchlist), main hero + two-up panel
 *            (trend chart / prediction), opponent bar chart + ledger below.
 *            Hairline rink-navy rules + corner tick marks stand in for
 *            card shadows.
 *  Data    — live from the NHL's public API (api-web.nhle.com), merging
 *            the current and previous season so streaks/opponent history
 *            stay consistent even early in a season.
 * ----------------------------------------------------------------------- */

const TEAM_NAMES = {
  ANA: "Anaheim Ducks", BOS: "Boston Bruins", BUF: "Buffalo Sabres",
  CGY: "Calgary Flames", CAR: "Carolina Hurricanes", CHI: "Chicago Blackhawks",
  COL: "Colorado Avalanche", CBJ: "Columbus Blue Jackets", DAL: "Dallas Stars",
  DET: "Detroit Red Wings", EDM: "Edmonton Oilers", FLA: "Florida Panthers",
  LAK: "Los Angeles Kings", MIN: "Minnesota Wild", MTL: "Montreal Canadiens",
  NSH: "Nashville Predators", NJD: "New Jersey Devils", NYI: "New York Islanders",
  NYR: "New York Rangers", OTT: "Ottawa Senators", PHI: "Philadelphia Flyers",
  PIT: "Pittsburgh Penguins", SJS: "San Jose Sharks", SEA: "Seattle Kraken",
  STL: "St. Louis Blues", TBL: "Tampa Bay Lightning", TOR: "Toronto Maple Leafs",
  UTA: "Utah Mammoth", VAN: "Vancouver Canucks", VGK: "Vegas Golden Knights",
  WSH: "Washington Capitals", WPG: "Winnipeg Jets",
};

function teamName(abbr) {
  return TEAM_NAMES[abbr] || abbr;
}

// NHL seasons run Oct→Jun. Resolve the current/most-recent season code
// (e.g. 20252026) plus the one before it, so there's always a full,
// consistent window of games even right after a new season starts.
function recentSeasonCodes() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const startYear = m >= 10 ? y : y - 1;
  const cur = `${startYear}${startYear + 1}`;
  const prev = `${startYear - 1}${startYear}`;
  return [cur, prev];
}

async function safeJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

function fmtDate(d) {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function rollingAverage(arr, key, window) {
  return arr.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = arr.slice(start, i + 1);
    const sum = slice.reduce((s, g) => s + g[key], 0);
    return +(sum / slice.length).toFixed(2);
  });
}

function computeStreak(gamesDesc) {
  if (!gamesDesc.length) return { type: "neutral", length: 0 };
  const scored = gamesDesc[0].goals > 0;
  let len = 0;
  for (const g of gamesDesc) {
    if (scored && g.goals > 0) len++;
    else if (!scored && g.goals === 0) len++;
    else break;
  }
  if (scored && len >= 2) return { type: "hot", length: len };
  if (!scored && len >= 2) return { type: "cold", length: len };
  return { type: "neutral", length: len };
}

function computeOpponentStats(games) {
  const map = {};
  for (const g of games) {
    if (!map[g.opponent]) map[g.opponent] = { opponent: g.opponent, games: 0, goals: 0 };
    map[g.opponent].games += 1;
    map[g.opponent].goals += g.goals;
  }
  return Object.values(map)
    .map((r) => ({ ...r, rate: +(r.goals / r.games).toFixed(2) }))
    .sort((a, b) => b.games - a.games);
}

function poissonScoreProb(lambda) {
  if (lambda <= 0) return 0;
  return 1 - Math.exp(-lambda);
}

function computePrediction(gamesDesc, opponentAbbr) {
  if (!gamesDesc.length) return null;
  const recentWindow = gamesDesc.slice(0, 10);
  const recentRate = recentWindow.reduce((s, g) => s + g.goals, 0) / recentWindow.length;
  const vsOpp = gamesDesc.filter((g) => g.opponent === opponentAbbr);
  const oppRate = vsOpp.length ? vsOpp.reduce((s, g) => s + g.goals, 0) / vsOpp.length : null;
  const lambda =
    oppRate !== null && vsOpp.length >= 3 ? 0.65 * recentRate + 0.35 * oppRate : recentRate;
  return {
    expectedGoals: +lambda.toFixed(2),
    scoreProb: Math.round(poissonScoreProb(lambda) * 100),
    recentRate: +recentRate.toFixed(2),
    oppRate: oppRate !== null ? +oppRate.toFixed(2) : null,
    oppGames: vsOpp.length,
  };
}

function TickCorner({ position = "top-left" }) {
  const style = {
    position: "absolute",
    width: 10,
    height: 10,
    borderColor: "#0B2545",
    ...(position === "top-left" && { top: -1, left: -1, borderTop: "2px solid", borderLeft: "2px solid" }),
    ...(position === "bottom-right" && { bottom: -1, right: -1, borderBottom: "2px solid", borderRight: "2px solid" }),
  };
  return <div style={style} />;
}

function Panel({ children, style }) {
  return (
    <div style={{ position: "relative", border: "1px solid #C7D3DA", padding: "20px 22px", background: "#FFFFFF", ...style }}>
      <TickCorner position="top-left" />
      <TickCorner position="bottom-right" />
      {children}
    </div>
  );
}

function StreakBadge({ streak }) {
  const map = {
    hot: { label: `Hot streak · ${streak.length} straight`, bg: "#FF5A36", fg: "#fff" },
    cold: { label: `Cold streak · ${streak.length} straight`, bg: "#2FB6C4", fg: "#fff" },
    neutral: { label: "No active streak", bg: "#E4EAEE", fg: "#56646E" },
  };
  const s = map[streak.type];
  return (
    <span style={{ display: "inline-block", padding: "6px 14px", fontSize: 13, fontWeight: 600, color: s.fg, background: s.bg }}>
      {s.label}
    </span>
  );
}

export default function NhlGoalTracker() {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap";
    document.head.appendChild(link);
    return () => document.head.removeChild(link);
  }, []);

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const debounceRef = useRef(null);

  const [player, setPlayer] = useState(null);
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [watchlist, setWatchlist] = useState([]);
  const [opponentPick, setOpponentPick] = useState("");

  const runSearch = useCallback((q) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q || q.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await safeJson(
          `https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=15&q=${encodeURIComponent(q)}&active=true`
        );
        setSuggestions(Array.isArray(data) ? data : []);
      } catch (e) {
        setSuggestions([]);
      }
    }, 300);
  }, []);

  useEffect(() => {
    runSearch(query);
  }, [query, runSearch]);

  const loadPlayer = useCallback(async (basic) => {
    setLoading(true);
    setError(null);
    setSearchOpen(false);
    setOpponentPick("");
    try {
      const id = basic.playerId || basic.id;
      const landing = await safeJson(`https://api-web.nhle.com/v1/player/${id}/landing`);

      const seasons = recentSeasonCodes();
      const logs = await Promise.all(
        seasons.map((s) =>
          safeJson(`https://api-web.nhle.com/v1/player/${id}/game-log/${s}/2`).catch(() => ({ gameLog: [] }))
        )
      );

      const merged = [];
      logs.forEach((l) => {
        (l.gameLog || []).forEach((g) => {
          merged.push({
            date: g.gameDate,
            opponent: g.opponentAbbrev,
            goals: g.goals ?? 0,
            home: g.homeRoadFlag === "H",
          });
        });
      });
      merged.sort((a, b) => new Date(a.date) - new Date(b.date));

      const info = {
        id,
        name:
          `${landing.firstName?.default || basic.name?.split(" ")[0] || ""} ${landing.lastName?.default || ""}`.trim() ||
          basic.name,
        team: landing.currentTeamAbbrev || basic.teamAbbrev,
        position: landing.position || basic.positionCode,
        headshot: landing.headshot,
        seasonGoals: landing.featuredStats?.regularSeason?.subSeason?.goals ?? null,
      };

      setPlayer(info);
      setGames(merged);
      setWatchlist((wl) => {
        const filtered = wl.filter((p) => p.id !== info.id);
        return [info, ...filtered].slice(0, 6);
      });
    } catch (e) {
      setError("Couldn't load that player's data. The NHL API may be temporarily unavailable — try again in a moment.");
      setPlayer(null);
      setGames([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const gamesDesc = useMemo(() => [...games].reverse(), [games]);
  const streak = useMemo(() => computeStreak(gamesDesc), [gamesDesc]);
  const opponentStats = useMemo(() => computeOpponentStats(games), [games]);
  const chartData = useMemo(() => {
    const last = games.slice(-20);
    const rollAvg = rollingAverage(last, "goals", 5);
    return last.map((g, i) => ({ label: fmtDate(g.date), goals: g.goals, avg5: rollAvg[i], opponent: g.opponent }));
  }, [games]);
  const opponentChartData = useMemo(
    () => opponentStats.slice(0, 8).map((o) => ({ opponent: o.opponent, rate: o.rate })),
    [opponentStats]
  );

  const seasonAvg = useMemo(() => {
    if (!games.length) return 0;
    return +(games.reduce((s, g) => s + g.goals, 0) / games.length).toFixed(2);
  }, [games]);

  const defaultOpponent = opponentStats[0]?.opponent || "";
  const activeOpponent = opponentPick || defaultOpponent;
  const prediction = useMemo(
    () => (activeOpponent ? computePrediction(gamesDesc, activeOpponent) : null),
    [gamesDesc, activeOpponent]
  );

  return (
    <div style={{ fontFamily: "Inter, sans-serif", background: "#EEF3F6", color: "#0B2545", minHeight: "100vh", padding: "28px" }}>
      <style>{`
        * { box-sizing: border-box; }
        .num { font-family: 'Oswald', sans-serif; }
        input:focus { outline: 2px solid #2FB6C4; outline-offset: 1px; }
        button:focus-visible { outline: 2px solid #2FB6C4; outline-offset: 1px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { text-align: left; padding: 8px 10px; font-size: 13px; }
        thead th { border-bottom: 2px solid #0B2545; font-family: 'Oswald', sans-serif; font-weight: 500; letter-spacing: 0.02em; }
        tbody tr { border-bottom: 1px solid #DCE4E9; cursor: pointer; }
        tbody tr:hover { background: #F4F8FA; }
        .oppRow.active { background: #FFF3E0; }
      `}</style>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 24, maxWidth: 1180, margin: "0 auto" }}>
        <div>
          <h1 className="num" style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Goal Watch</h1>
          <p style={{ fontSize: 13, color: "#56646E", margin: "0 0 18px" }}>
            Live player scoring streaks, matchup history &amp; next-game odds.
          </p>

          <div style={{ position: "relative", marginBottom: 22 }}>
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)}
              placeholder="Search a player…"
              style={{ width: "100%", padding: "10px 12px", border: "1px solid #0B2545", fontSize: 14, background: "#fff" }}
            />
            {searchOpen && suggestions.length > 0 && (
              <div style={{ position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0, background: "#fff", border: "1px solid #0B2545", zIndex: 10, maxHeight: 280, overflowY: "auto" }}>
                {suggestions.map((s) => (
                  <div
                    key={s.playerId}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setQuery(""); setSuggestions([]); loadPlayer(s); }}
                    style={{ padding: "9px 12px", fontSize: 13, borderBottom: "1px solid #EEF3F6", display: "flex", justifyContent: "space-between" }}
                  >
                    <span>{s.name}</span>
                    <span style={{ color: "#56646E" }}>{s.teamAbbrev || s.lastTeamAbbrev || ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#56646E", marginBottom: 8 }}>
            Recently viewed
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {watchlist.length === 0 && <div style={{ fontSize: 13, color: "#8A97A0" }}>Search for a player to get started.</div>}
            {watchlist.map((p) => (
              <button
                key={p.id}
                onClick={() => loadPlayer({ playerId: p.id, name: p.name })}
                style={{ textAlign: "left", background: player?.id === p.id ? "#0B2545" : "transparent", color: player?.id === p.id ? "#fff" : "#0B2545", border: "none", padding: "8px 10px", fontSize: 13, cursor: "pointer" }}
              >
                {p.name} <span style={{ opacity: 0.7 }}>· {p.team}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          {!player && !loading && !error && (
            <Panel style={{ minHeight: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <p style={{ color: "#56646E", fontSize: 14 }}>Search for an NHL skater on the left to pull up their live scoring profile.</p>
            </Panel>
          )}
          {loading && (
            <Panel style={{ minHeight: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <p style={{ color: "#56646E", fontSize: 14 }}>Loading player data…</p>
            </Panel>
          )}
          {error && (
            <Panel><p style={{ color: "#FF5A36", fontSize: 14, margin: 0 }}>{error}</p></Panel>
          )}

          {player && !loading && !error && (
            <>
              <Panel style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
                  {player.headshot && (
                    <img src={player.headshot} alt={player.name} style={{ width: 84, height: 84, objectFit: "cover", background: "#EEF3F6" }} />
                  )}
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontSize: 12, color: "#56646E", marginBottom: 2 }}>{teamName(player.team)} · {player.position}</div>
                    <h2 className="num" style={{ fontSize: 28, margin: "0 0 8px", fontWeight: 600 }}>{player.name}</h2>
                    <StreakBadge streak={streak} />
                  </div>
                  <div style={{ display: "flex", gap: 28 }}>
                    <div>
                      <div className="num" style={{ fontSize: 32, fontWeight: 700, lineHeight: 1 }}>
                        {player.seasonGoals ?? games.reduce((s, g) => s + g.goals, 0)}
                      </div>
                      <div style={{ fontSize: 11, color: "#56646E", textTransform: "uppercase" }}>Season goals</div>
                    </div>
                    <div>
                      <div className="num" style={{ fontSize: 32, fontWeight: 700, lineHeight: 1 }}>{seasonAvg}</div>
                      <div style={{ fontSize: 11, color: "#56646E", textTransform: "uppercase" }}>Goals / game</div>
                    </div>
                  </div>
                </div>
              </Panel>

              <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18, marginBottom: 18 }}>
                <Panel>
                  <div style={{ fontSize: 12, textTransform: "uppercase", color: "#56646E", marginBottom: 10 }}>
                    Last {chartData.length} games — goals &amp; 5-game rolling average
                  </div>
                  {chartData.length === 0 ? (
                    <p style={{ fontSize: 13, color: "#8A97A0" }}>No recent game log found.</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={220}>
                      <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                        <CartesianGrid stroke="#DCE4E9" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#56646E" }} interval="preserveStartEnd" />
                        <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "#56646E" }} />
                        <ReferenceLine y={seasonAvg} stroke="#8A97A0" strokeDasharray="3 3" />
                        <Tooltip formatter={(v, n) => [v, n === "goals" ? "Goals" : "5-game avg"]} labelFormatter={(l, p) => `${l} vs ${p?.[0]?.payload?.opponent || ""}`} />
                        <Bar dataKey="goals" fill="#2FB6C4" radius={[2, 2, 0, 0]} />
                        <Line type="monotone" dataKey="avg5" stroke="#FF5A36" strokeWidth={2} dot={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  )}

                  <div style={{ fontSize: 12, textTransform: "uppercase", color: "#56646E", margin: "18px 0 10px" }}>
                    Goals per game by opponent (top 8 by games played)
                  </div>
                  {opponentChartData.length === 0 ? (
                    <p style={{ fontSize: 13, color: "#8A97A0" }}>Not enough matchup history yet.</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={opponentChartData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                        <CartesianGrid stroke="#DCE4E9" vertical={false} />
                        <XAxis dataKey="opponent" tick={{ fontSize: 10, fill: "#56646E" }} />
                        <YAxis allowDecimals tick={{ fontSize: 10, fill: "#56646E" }} />
                        <Tooltip formatter={(v) => [v, "Goals / game"]} />
                        <Bar dataKey="rate" fill="#0B2545" radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </Panel>

                <Panel style={{ borderColor: "#0B2545" }}>
                  <div style={{ fontSize: 12, textTransform: "uppercase", color: "#56646E", marginBottom: 10 }}>Next-game outlook</div>
                  {opponentStats.length > 0 ? (
                    <>
                      <label style={{ fontSize: 12, color: "#56646E", display: "block", marginBottom: 4 }}>Opponent</label>
                      <select
                        value={activeOpponent}
                        onChange={(e) => setOpponentPick(e.target.value)}
                        style={{ width: "100%", padding: "8px 10px", border: "1px solid #0B2545", fontSize: 13, marginBottom: 14, background: "#fff" }}
                      >
                        {opponentStats.map((o) => <option key={o.opponent} value={o.opponent}>{teamName(o.opponent)}</option>)}
                      </select>
                      {prediction && (
                        <>
                          <div style={{ display: "flex", gap: 20, marginBottom: 10 }}>
                            <div>
                              <div className="num" style={{ fontSize: 26, fontWeight: 700 }}>{prediction.scoreProb}%</div>
                              <div style={{ fontSize: 10, color: "#56646E", textTransform: "uppercase" }}>Chance to score</div>
                            </div>
                            <div>
                              <div className="num" style={{ fontSize: 26, fontWeight: 700 }}>{prediction.expectedGoals}</div>
                              <div style={{ fontSize: 10, color: "#56646E", textTransform: "uppercase" }}>Expected goals</div>
                            </div>
                          </div>
                          <div style={{ fontSize: 12, color: "#56646E", lineHeight: 1.5 }}>
                            Last 10 games: {prediction.recentRate} g/gm.
                            {prediction.oppGames >= 3
                              ? ` Career vs ${teamName(activeOpponent)}: ${prediction.oppRate} g/gm over ${prediction.oppGames} meetings.`
                              : ` Only ${prediction.oppGames} career meeting${prediction.oppGames === 1 ? "" : "s"} vs ${teamName(activeOpponent)} — leaning on recent form.`}
                          </div>
                        </>
                      )}
                      <div style={{ fontSize: 10, color: "#8A97A0", marginTop: 12, borderTop: "1px solid #DCE4E9", paddingTop: 8 }}>
                        A statistical estimate from recent form + head-to-head history — not a betting line.
                      </div>
                    </>
                  ) : (
                    <p style={{ fontSize: 13, color: "#8A97A0" }}>Not enough game history yet.</p>
                  )}
                </Panel>
              </div>

              <Panel>
                <div style={{ fontSize: 12, textTransform: "uppercase", color: "#56646E", marginBottom: 10 }}>Performance by opponent</div>
                {opponentStats.length === 0 ? (
                  <p style={{ fontSize: 13, color: "#8A97A0" }}>No matchup history yet.</p>
                ) : (
                  <div style={{ maxHeight: 320, overflowY: "auto" }}>
                    <table>
                      <thead><tr><th>Opponent</th><th>Games</th><th>Goals</th><th>Goals / game</th></tr></thead>
                      <tbody>
                        {opponentStats.map((o) => (
                          <tr key={o.opponent} className={o.opponent === activeOpponent ? "oppRow active" : "oppRow"} onClick={() => setOpponentPick(o.opponent)}>
                            <td>{teamName(o.opponent)}</td><td>{o.games}</td><td>{o.goals}</td><td>{o.rate}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
