import { useState, useMemo } from "react";

/* ─── Statistical Helpers ─── */
function normalPPF(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;
  const a = [-3.969683028665376e1,2.209460984245205e2,-2.759285104469687e2,1.383577518672690e2,-3.066479806614716e1,2.506628277459239e0];
  const b = [-5.447609879822406e1,1.615858368580409e2,-1.556989798598866e2,6.680131188771972e1,-1.328068155288572e1];
  const c = [-7.784894002430293e-3,-3.223964580411365e-1,-2.400758277161838e0,-2.549732539343734e0,4.374664141464968e0,2.938163982698783e0];
  const d = [7.784695709041462e-3,3.224671290700398e-1,2.445134137142996e0,3.754408661907416e0];
  const pL=0.02425,pH=1-pL;let q,r;
  if(p<pL){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)}
  else if(p<=pH){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)}
  else{q=Math.sqrt(-2*Math.log(1-p));return-(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)}
}

function calc({ metricType, params, confidence, power, tails, variants }) {
  const alpha = 1 - confidence / 100;
  const zA = tails === 2 ? normalPPF(1 - alpha / 2) : normalPPF(1 - alpha);
  const zB = normalPPF(power / 100);
  let n, sd, mde, warnings = [], details = {}, tips = [];

  if (metricType === "binary") {
    const p1 = params.baselineRate / 100;
    const lift = params.mde / 100;
    const p2 = p1 * (1 + lift);
    if (p2 > 1 || p2 < 0) return { n: null, warnings: ["Expected rate after lift is out of range."] };
    const pooled = (p1 + p2) / 2;
    sd = Math.sqrt(pooled * (1 - pooled));
    mde = Math.abs(p2 - p1);
    n = Math.ceil(2 * Math.pow((zA + zB) * sd / mde, 2));
    details = { baseline: (p1 * 100) + "%", expected: (p2 * 100).toFixed(2) + "%", absoluteEffect: (mde * 100).toFixed(2) + "pp" };
    if (p1 < 0.02) tips.push("With a baseline under 2%, sample sizes get very large. Consider testing a higher-funnel event (e.g. add-to-cart instead of purchase).");
    if (lift < 5) tips.push("Detecting under 5% relative lift is very expensive. Make sure this precision level is worth the traffic cost.");
    if (p1 > 0.4) tips.push("High baseline rates (>40%) are easier to test because the absolute effect size is larger.");
  } else if (metricType === "continuous") {
    sd = params.sd; mde = params.mde;
    if (sd <= 0 || mde <= 0) return { n: null, warnings: ["SD and MDE must be positive."] };
    n = Math.ceil(2 * Math.pow((zA + zB) * sd / mde, 2));
    const cohen = mde / sd;
    details = { effectSize: cohen.toFixed(3) };
    if (params.skewed) { warnings.push("Skew buffer applied (+30%)."); n = Math.ceil(n * 1.3); }
    if (cohen < 0.05) tips.push("Effect size " + cohen.toFixed(3) + " is very small. Like hearing a pin drop at a concert. Consider a less noisy metric.");
    if (cohen > 0.5) tips.push("Effect size " + cohen.toFixed(3) + " is large \u2014 should be easy to detect.");
    if (sd > params.mean * 2) tips.push("SD is more than 2x the mean \u2014 very noisy. Consider capping outliers (winsorizing) to reduce variance.");
  } else if (metricType === "count") {
    const variance = params.usePoisson ? params.mean : params.variance;
    sd = Math.sqrt(variance); mde = params.mde;
    if (mde <= 0) return { n: null, warnings: ["MDE must be positive."] };
    n = Math.ceil(2 * Math.pow((zA + zB) * sd / mde, 2));
    details = { impliedVariance: variance.toFixed(2), effectSize: (mde / sd).toFixed(3) };
    if (!params.usePoisson && params.variance > params.mean * 2) {
      warnings.push("Heavy overdispersion detected (variance >> mean).");
      tips.push("Power users are inflating variance. Consider capping extreme values or testing only among active users for a cleaner signal.");
    }
    if (params.usePoisson) tips.push("Poisson assumes variance = mean. Works for rare independent events. If power users skew your data, uncheck this and enter actual variance.");
  } else if (metricType === "revenue") {
    const pNZ = params.pctNonZero / 100;
    const overallMean = pNZ * params.meanNonZero;
    const overallVar = pNZ * (Math.pow(params.sdNonZero, 2) + Math.pow(params.meanNonZero, 2)) - Math.pow(overallMean, 2);
    sd = Math.sqrt(overallVar); mde = params.mde;
    if (mde <= 0) return { n: null, warnings: ["MDE must be positive."] };
    n = Math.ceil(2 * Math.pow((zA + zB) * sd / mde, 2));
    n = Math.ceil(n * 1.4);
    details = { overallMean: "$" + overallMean.toFixed(2), overallSD: "$" + sd.toFixed(2), coeffOfVar: (sd / overallMean).toFixed(1) + "x" };
    warnings.push("Zero-inflated buffer applied (+40%).");
    tips.push("Revenue tests are the most data-hungry. Consider decomposing: binary test on conversion + continuous test on AOV among buyers.");
    if (pNZ < 5) tips.push("Under 5% spend rate means 95%+ of data is zeros. Each buyer's behavior has outsized impact.");
  }

  return { nPerGroup: n, totalN: n * (variants || 2), sd: sd?.toFixed(4), mde: mde?.toFixed(4), warnings, details, tips };
}

function calcSensitivity(metricType, params, confidence, power, tails, variants) {
  return [0.5, 0.75, 1, 1.25, 1.5, 2].map(m => {
    const p = { ...params, mde: params.mde * m };
    const r = calc({ metricType, params: p, confidence, power, tails, variants });
    return { mdeValue: p.mde, nPerGroup: r.nPerGroup, totalN: r.totalN, isBase: m === 1 };
  });
}

/* ─── Design Tokens ─── */
const V = {
  bg: "#fafaf9", surface: "#ffffff", surfaceAlt: "#f5f4f2",
  border: "#e8e6e1", borderLight: "#f0eee9",
  text: "#1d1d1f", textSecondary: "#6e6e73", textTertiary: "#aeaeb2",
  accent: "#0071e3", accentSoft: "rgba(0,113,227,0.06)",
  green: "#34c759", greenBg: "rgba(52,199,89,0.06)",
  orange: "#ff9500", orangeBg: "rgba(255,149,0,0.06)",
  red: "#ff3b30", redBg: "rgba(255,59,48,0.06)",
  purple: "#af52de", purpleBg: "rgba(175,82,222,0.06)",
  teal: "#30b0c7", tealBg: "rgba(48,176,199,0.06)",
  radius: 14, radiusSm: 10, radiusLg: 20,
  font: "'Figtree', sans-serif", mono: "'JetBrains Mono', monospace",
  shadow: "0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03)",
  shadowLg: "0 2px 8px rgba(0,0,0,0.04), 0 8px 32px rgba(0,0,0,0.06)",
};

const TABS = [
  { id: "binary", label: "Conversion", icon: "\u25CE", color: V.accent },
  { id: "continuous", label: "Averages", icon: "\u223F", color: V.green },
  { id: "count", label: "Counts", icon: "\u2211", color: V.orange },
  { id: "revenue", label: "Revenue", icon: "$", color: V.purple },
  { id: "learn", label: "Learn", icon: "\u25C8", color: V.teal },
  { id: "decide", label: "Decide", icon: "\u2713", color: V.text },
];

/* ─── Reusable Components ─── */
function Field({ label, help, value, onChange, suffix, min, max, step = "any", mono }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <label style={{ fontSize: 13, fontWeight: 600, color: V.text, fontFamily: V.font, display: "block", marginBottom: help ? 2 : 6 }}>{label}</label>
      {help && <p style={{ fontSize: 12, color: V.textTertiary, margin: "0 0 8px", lineHeight: 1.5, fontFamily: V.font }}>{help}</p>}
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <input type="number" value={value} min={min} max={max} step={step}
          onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          style={{ width: "100%", padding: "11px 14px", paddingRight: suffix ? 90 : 14, background: V.surface, border: "1px solid " + V.border, borderRadius: V.radiusSm, fontSize: 15, fontFamily: mono ? V.mono : V.font, color: V.text, outline: "none", transition: "border-color 0.2s, box-shadow 0.2s", WebkitAppearance: "none", MozAppearance: "textfield" }}
          onFocus={e => { e.target.style.borderColor = V.accent; e.target.style.boxShadow = "0 0 0 3px " + V.accentSoft; }}
          onBlur={e => { e.target.style.borderColor = V.border; e.target.style.boxShadow = "none"; }}
        />
        {suffix && <span style={{ position: "absolute", right: 14, fontSize: 12, color: V.textTertiary, fontFamily: V.font, fontWeight: 500, pointerEvents: "none" }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Switch({ label, help, checked, onChange }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 20, cursor: "pointer" }} onClick={() => onChange(!checked)}>
      <div style={{ width: 42, minWidth: 42, height: 26, borderRadius: 13, background: checked ? V.accent : "#d1d1d6", transition: "background 0.25s", position: "relative", marginTop: 1 }}>
        <div style={{ width: 22, height: 22, borderRadius: 11, background: "#fff", position: "absolute", top: 2, left: checked ? 18 : 2, transition: "left 0.25s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }} />
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: V.text, fontFamily: V.font }}>{label}</div>
        {help && <div style={{ fontSize: 12, color: V.textTertiary, marginTop: 2, lineHeight: 1.4, fontFamily: V.font }}>{help}</div>}
      </div>
    </div>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <div style={{ display: "inline-flex", background: V.surfaceAlt, borderRadius: V.radiusSm, padding: 3, gap: 2 }}>
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)} style={{ padding: "8px 18px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: V.font, background: value === o.value ? V.surface : "transparent", color: value === o.value ? V.text : V.textTertiary, boxShadow: value === o.value ? V.shadow : "none", transition: "all 0.2s" }}>{o.label}</button>
      ))}
    </div>
  );
}

function StatCard({ label, value, sub, color = V.accent }) {
  return (
    <div style={{ background: V.surface, borderRadius: V.radius, padding: "20px 22px", border: "1px solid " + V.borderLight, boxShadow: V.shadow, flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: V.textTertiary, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8, fontFamily: V.font }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 700, color, fontFamily: V.mono, letterSpacing: -1, lineHeight: 1 }}>{typeof value === "number" ? value.toLocaleString() : value}</div>
      {sub && <div style={{ fontSize: 12, color: V.textTertiary, marginTop: 6, fontFamily: V.font }}>{sub}</div>}
    </div>
  );
}

function Callout({ icon, title, children, color = V.accent, colorBg }) {
  return (
    <div style={{ background: colorBg || (color + "0a"), borderRadius: V.radius, padding: "16px 20px", marginBottom: 12 }}>
      {title && <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>{icon && <span style={{ fontSize: 14 }}>{icon}</span>}<span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: V.font, textTransform: "uppercase", letterSpacing: 0.5 }}>{title}</span></div>}
      <div style={{ fontSize: 13, color: V.textSecondary, lineHeight: 1.65, fontFamily: V.font }}>{children}</div>
    </div>
  );
}

function GuideBox({ icon, title, children, color = V.accent }) {
  return (
    <div style={{ borderLeft: "3px solid " + color, background: color + "06", borderRadius: "0 10px 10px 0", padding: "14px 18px", marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, fontFamily: V.font, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>{icon && <span>{icon}</span>}{title}</div>
      <div style={{ fontSize: 13, color: V.textSecondary, lineHeight: 1.65, fontFamily: V.font }}>{children}</div>
    </div>
  );
}

/* ─── Settings Panel ─── */
function SettingsPanel({ confidence, setConfidence, power, setPower, tails, setTails, variants, setVariants, dailyTraffic, setDailyTraffic, showHelp, setShowHelp }) {
  return (
    <div style={{ background: V.surfaceAlt, borderRadius: V.radius, padding: "20px 22px", border: "1px solid " + V.borderLight }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: V.textTertiary, textTransform: "uppercase", letterSpacing: 0.8, fontFamily: V.font }}>Test Settings</div>
        <button onClick={() => setShowHelp(!showHelp)} style={{ fontSize: 12, fontWeight: 600, color: V.accent, background: "none", border: "none", cursor: "pointer", fontFamily: V.font, padding: "4px 8px", borderRadius: 6 }}>{showHelp ? "Hide help" : "What are these?"}</button>
      </div>
      {showHelp && (
        <div style={{ background: V.surface, borderRadius: V.radiusSm, padding: "14px 18px", marginBottom: 16, border: "1px solid " + V.borderLight, fontSize: 13, color: V.textSecondary, lineHeight: 1.7, fontFamily: V.font }}>
          <strong style={{ color: V.text }}>Confidence</strong> = protection from false alarms. 95% means only a 5% chance of declaring a winner when nothing changed. <em>Most teams use 95%.</em><br /><br />
          <strong style={{ color: V.text }}>Power</strong> = ability to catch real wins. 80% means 80% chance of detecting a true effect. <em>80% is standard; use 90% for high-stakes tests.</em><br /><br />
          <strong style={{ color: V.text }}>Two-sided vs one-sided</strong> = Two-sided detects both improvements AND regressions (recommended). One-sided only checks one direction.<br /><br />
          <strong style={{ color: V.text }}>Variants</strong> = total groups including control. A/B = 2, A/B/C = 3. More variants = more total users needed.
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div><div style={{ fontSize: 12, fontWeight: 600, color: V.textSecondary, marginBottom: 8, fontFamily: V.font }}>Confidence</div><Seg options={[{value:90,label:"90%"},{value:95,label:"95%"},{value:99,label:"99%"}]} value={confidence} onChange={setConfidence} /></div>
        <div><div style={{ fontSize: 12, fontWeight: 600, color: V.textSecondary, marginBottom: 8, fontFamily: V.font }}>Power</div><Seg options={[{value:70,label:"70%"},{value:80,label:"80%"},{value:90,label:"90%"}]} value={power} onChange={setPower} /></div>
        <div><div style={{ fontSize: 12, fontWeight: 600, color: V.textSecondary, marginBottom: 8, fontFamily: V.font }}>Hypothesis</div><Seg options={[{value:2,label:"Two-sided"},{value:1,label:"One-sided"}]} value={tails} onChange={setTails} /></div>
        <div style={{ minWidth: 80 }}><Field label="Variants" help="Including control" value={variants} onChange={v => setVariants(Math.max(2, Math.round(v || 2)))} min={2} max={10} step={1} /></div>
        <div style={{ minWidth: 140 }}><Field label="Daily traffic" help="For duration estimate" value={dailyTraffic} onChange={setDailyTraffic} suffix="users/day" min={1} /></div>
      </div>
    </div>
  );
}

/* ─── Results Panel ─── */
function ResultsPanel({ result, dailyTraffic, variants, metricType, params, confidence, power, tails, tabColor }) {
  if (!result || !result.nPerGroup) return result?.warnings?.length ? <Callout icon="\u26A0" title="Check your inputs" color={V.red} colorBg={V.redBg}>{result.warnings.join(" ")}</Callout> : null;
  const sensitivity = calcSensitivity(metricType, params, confidence, power, tails, variants);
  const days = dailyTraffic && dailyTraffic > 0 ? Math.ceil(result.totalN / dailyTraffic) : null;

  return (
    <div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <StatCard label="Per Group" value={result.nPerGroup} sub={"\u00D7 " + variants + " groups"} color={tabColor} />
        <StatCard label="Total" value={result.totalN} sub="users needed" color={V.text} />
        {days && <StatCard label="Duration" value={days} sub={"\u2248 " + (days / 7).toFixed(1) + " weeks"} color={V.orange} />}
      </div>

      <Callout icon={"\uD83D\uDCD6"} title="What this means" color={tabColor}>
        You need <strong>{result.nPerGroup.toLocaleString()}</strong> users in each group ({result.totalN.toLocaleString()} total) to have a <strong>{power}% chance</strong> of detecting your target effect with <strong>{confidence}% confidence</strong>.
        {days ? " At " + Number(dailyTraffic).toLocaleString() + " users/day, plan for about " + days + " days (" + (days / 7).toFixed(1) + " weeks)." : ""}
        {days && days < 7 ? " That's under a week \u2014 still run for at least 7 days to capture day-of-week effects." : ""}
        {days && days > 60 ? " That's a long experiment. Consider relaxing your MDE or testing a less noisy metric." : ""}
      </Callout>

      {result.warnings.length > 0 && result.warnings.map((w, i) => <Callout key={"w"+i} icon={"\u26A0\uFE0F"} title="Note" color={V.orange} colorBg={V.orangeBg}>{w}</Callout>)}
      {result.tips && result.tips.length > 0 && result.tips.map((t, i) => <Callout key={"t"+i} icon={"\uD83D\uDCA1"} title="Pro tip" color={V.teal} colorBg={V.tealBg}>{t}</Callout>)}

      {result.details && Object.keys(result.details).length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", padding: "12px 16px", background: V.surfaceAlt, borderRadius: V.radiusSm, marginBottom: 16, fontSize: 12, fontFamily: V.font, color: V.textSecondary }}>
          {Object.entries(result.details).map(([k, v]) => <span key={k}><span style={{ color: V.textTertiary }}>{k.replace(/([A-Z])/g, " $1").trim()}:</span> <strong style={{ color: V.text, fontFamily: V.mono, fontSize: 12 }}>{v}</strong></span>)}
        </div>
      )}

      <div style={{ background: V.surface, borderRadius: V.radius, border: "1px solid " + V.borderLight, overflow: "hidden", marginBottom: 16 }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid " + V.borderLight, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: V.textSecondary, fontFamily: V.font, textTransform: "uppercase", letterSpacing: 0.6 }}>Sensitivity Table</span>
          <span style={{ fontSize: 11, color: V.textTertiary, fontFamily: V.font }}>How MDE affects sample size</span>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: V.font, fontSize: 13 }}>
          <thead><tr style={{ background: V.surfaceAlt }}>
            <th style={{ textAlign: "left", padding: "10px 18px", fontWeight: 600, color: V.textTertiary, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{metricType === "binary" ? "Relative Lift" : "MDE"}</th>
            <th style={{ textAlign: "right", padding: "10px 18px", fontWeight: 600, color: V.textTertiary, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Per Group</th>
            <th style={{ textAlign: "right", padding: "10px 18px", fontWeight: 600, color: V.textTertiary, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Total</th>
          </tr></thead>
          <tbody>{sensitivity.map((row, i) => (
            <tr key={i} style={{ background: row.isBase ? tabColor + "08" : "transparent" }}>
              <td style={{ padding: "10px 18px", fontWeight: row.isBase ? 700 : 400, color: row.isBase ? tabColor : V.text, borderBottom: "1px solid " + V.borderLight, fontFamily: V.mono, fontSize: 13 }}>
                {metricType === "binary" ? row.mdeValue.toFixed(1) + "%" : row.mdeValue.toFixed(2)}
                {row.isBase && <span style={{ fontFamily: V.font, fontSize: 11, marginLeft: 8, opacity: 0.5 }}>{"\u2190"} yours</span>}
              </td>
              <td style={{ textAlign: "right", padding: "10px 18px", fontFamily: V.mono, color: V.text, borderBottom: "1px solid " + V.borderLight, fontSize: 13 }}>{row.nPerGroup?.toLocaleString() || "\u2014"}</td>
              <td style={{ textAlign: "right", padding: "10px 18px", fontFamily: V.mono, color: V.textSecondary, borderBottom: "1px solid " + V.borderLight, fontSize: 13 }}>{row.totalN?.toLocaleString() || "\u2014"}</td>
            </tr>
          ))}</tbody>
        </table>
        <div style={{ padding: "10px 18px", fontSize: 11, color: V.textTertiary, fontFamily: V.font, borderTop: "1px solid " + V.borderLight }}>
          Halving the MDE roughly 4x the sample size. The MDE knob is the most expensive to turn.
        </div>
      </div>
    </div>
  );
}

/* ─── Calculator Tabs ─── */
function BinaryTab(props) {
  const [params, setParams] = useState({ baselineRate: 5, mde: 10 });
  const p = (k, v) => setParams(o => ({ ...o, [k]: v }));
  const result = useMemo(() => calc({ metricType: "binary", params, ...props }), [params, props.confidence, props.power, props.tails, props.variants]);
  const autoSD = Math.sqrt((params.baselineRate / 100) * (1 - params.baselineRate / 100));
  const absEffect = (params.baselineRate * params.mde / 100).toFixed(2);
  return (
    <div><div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)", gap: 32, alignItems: "start" }}>
      <div>
        <Callout icon={"\uD83D\uDCCB"} title="When to use this" color={V.accent}>
          Use for metrics where each user is a <strong>yes or no</strong>: clicked or didn't, converted or didn't, bounced or didn't. Common examples: signup rate, click-through rate, purchase rate, day-N retention.
        </Callout>
        <Field label="Baseline conversion rate" help={"Your current rate. Find it in your analytics over the past 2\u20134 weeks. Example: 5 out of 100 users convert = enter 5."} value={params.baselineRate} onChange={v => p("baselineRate", v)} suffix="%" min={0.01} max={99} mono />
        <Field label="Minimum detectable lift (relative)" help={params.mde + "% lift on " + params.baselineRate + "% = detecting " + params.baselineRate + "% \u2192 " + (params.baselineRate * (1 + params.mde / 100)).toFixed(2) + "% (a " + absEffect + "pp absolute change)."} value={params.mde} onChange={v => p("mde", v)} suffix="% relative" min={0.1} mono />
        <Callout icon={"\uD83D\uDCD0"} title="Auto-calculated SD" color={V.accent}>
          SD = {"\u221A"}(p {"\u00D7"} (1{"\u2212"}p)) = <strong style={{ fontFamily: V.mono }}>{autoSD.toFixed(4)}</strong><br />
          Binary metrics are special {"\u2014"} the spread is determined entirely by the rate. You don't need to look this up anywhere.
        </Callout>
        <GuideBox icon={"\uD83D\uDD0E"} title="Where to find your baseline rate" color={V.accent}>
          Check GA4, Amplitude, or Mixpanel for the event you're testing. Use at least 2 weeks of data to smooth daily variation. If your rate fluctuates a lot, use the average.
        </GuideBox>
        <GuideBox icon={"\uD83C\uDFAF"} title="How to choose your MDE" color={V.green}>
          Ask: "What's the smallest improvement worth shipping?" Consider dev cost, rollout risk, and business impact. A $1M feature shouldn't be tested for a 0.1% lift.
        </GuideBox>
      </div>
      <ResultsPanel result={result} metricType="binary" params={params} tabColor={V.accent} {...props} />
    </div></div>
  );
}

function ContinuousTab(props) {
  const [params, setParams] = useState({ mean: 50, sd: 20, mde: 5, skewed: false });
  const p = (k, v) => setParams(o => ({ ...o, [k]: v }));
  const result = useMemo(() => calc({ metricType: "continuous", params, ...props }), [params, props.confidence, props.power, props.tails, props.variants]);
  const cohen = params.sd > 0 ? (params.mde / params.sd).toFixed(2) : "?";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)", gap: 32, alignItems: "start" }}>
      <div>
        <Callout icon={"\uD83D\uDCCB"} title="When to use this" color={V.green}>
          Use for metrics where each user produces a <strong>numeric value</strong>: average order value, session duration, page load time, NPS score. Unlike binary, you MUST know the standard deviation.
        </Callout>
        <Field label="Current mean" help="Average value of your metric today. Use at least 2 weeks of data." value={params.mean} onChange={v => p("mean", v)} mono />
        <Field label="Standard deviation (SD)" help={"If SD=" + params.sd + " and mean=" + params.mean + ", most values fall in " + Math.max(0, params.mean - params.sd).toFixed(0) + "\u2013" + (params.mean + params.sd).toFixed(0) + ". Higher = noisier."} value={params.sd} onChange={v => p("sd", v)} min={0.01} mono />
        <Field label="Minimum detectable effect (absolute)" help={"Detecting " + params.mde + " on a mean of " + params.mean + " = a " + (params.mean > 0 ? ((params.mde / params.mean) * 100).toFixed(1) : 0) + "% relative change."} value={params.mde} onChange={v => p("mde", v)} min={0.01} mono />
        <Switch label="Is this metric heavily skewed?" help="Revenue, session duration, and time metrics typically are. Adds a 30% safety buffer for when CLT needs more data." checked={params.skewed} onChange={v => p("skewed", v)} />
        <Callout icon={"\uD83D\uDCCA"} title={"Effect size (Cohen's d): " + cohen} color={V.green}>
          {Number(cohen) < 0.2 ? "Very small effect \u2014 like hearing a whisper at a concert. You'll need lots of data." : Number(cohen) < 0.5 ? "Small-to-medium effect. Typical for most product experiments." : "Medium-to-large effect \u2014 should be relatively easy to detect."}
        </Callout>
        <GuideBox icon={"\uD83D\uDD0E"} title="Where to find SD" color={V.green}>
          Most analytics tools can give you SD. In SQL: <span style={{ fontFamily: V.mono, fontSize: 11, background: V.surfaceAlt, padding: "2px 4px", borderRadius: 4 }}>STDDEV(metric)</span>. Rule of thumb: for revenue, SD is often 1{"\u2013"}3x the mean. For time metrics, 0.8{"\u2013"}2x.
        </GuideBox>
      </div>
      <ResultsPanel result={result} metricType="continuous" params={params} tabColor={V.green} {...props} />
    </div>
  );
}

function CountTab(props) {
  const [params, setParams] = useState({ mean: 4, variance: 6, mde: 0.5, usePoisson: false });
  const p = (k, v) => setParams(o => ({ ...o, [k]: v }));
  const result = useMemo(() => calc({ metricType: "count", params, ...props }), [params, props.confidence, props.power, props.tails, props.variants]);
  const dispRatio = params.usePoisson ? 1 : (params.mean > 0 ? params.variance / params.mean : 0);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)", gap: 32, alignItems: "start" }}>
      <div>
        <Callout icon={"\uD83D\uDCCB"} title="When to use this" color={V.orange}>
          Use for metrics that count <strong>discrete occurrences per user</strong>: pages viewed, items added to cart, messages sent, support tickets. Often Poisson-like.
        </Callout>
        <Field label="Average count" help="Mean occurrences per user. E.g., users view 4 pages/session on average." value={params.mean} onChange={v => p("mean", v)} min={0.01} mono />
        <Switch label="Assume Poisson distribution?" help="Variance = mean automatically. Good for rare, independent events (support tickets, errors). Turn OFF if power users skew your data." checked={params.usePoisson} onChange={v => p("usePoisson", v)} />
        {!params.usePoisson && (
          <Field label="Variance" help={"In SQL: VARIANCE(metric). Unsure? Start at 1.5\u00D7 mean = " + (params.mean * 1.5).toFixed(1) + ". Dispersion ratio: " + dispRatio.toFixed(2) + "x."} value={params.variance} onChange={v => p("variance", v)} min={0.01} mono />
        )}
        <Field label="Minimum detectable effect (absolute)" help={params.mde + " on a mean of " + params.mean + " = " + (params.mean > 0 ? ((params.mde / params.mean) * 100).toFixed(1) : 0) + "% change."} value={params.mde} onChange={v => p("mde", v)} min={0.01} mono />
        {!params.usePoisson && (
          <Callout icon={dispRatio > 2 ? "\uD83D\uDD34" : dispRatio > 1.3 ? "\uD83D\uDFE1" : "\uD83D\uDFE2"} title="Dispersion check" color={dispRatio > 2 ? V.red : dispRatio > 1.3 ? V.orange : V.green}>
            Variance/Mean = <strong style={{ fontFamily: V.mono }}>{dispRatio.toFixed(2)}</strong>.
            {dispRatio > 2 ? " Heavy overdispersion \u2014 power users inflating variance. Consider capping extremes or segmenting." : dispRatio > 1.3 ? " Moderate overdispersion \u2014 normal for most product metrics. Using actual variance is the right call." : " Close to Poisson! You could toggle Poisson on for simplicity."}
          </Callout>
        )}
        <GuideBox icon={"\uD83D\uDCA1"} title="Poisson vs. Overdispersed \u2014 why it matters" color={V.orange}>
          Assuming Poisson when data is overdispersed <strong>underestimates</strong> sample size. Your test would be underpowered and you'd miss real effects half the time. Always safer to use actual variance.
        </GuideBox>
      </div>
      <ResultsPanel result={result} metricType="count" params={params} tabColor={V.orange} {...props} />
    </div>
  );
}

function RevenueTab(props) {
  const [params, setParams] = useState({ pctNonZero: 10, meanNonZero: 75, sdNonZero: 60, mde: 2 });
  const p = (k, v) => setParams(o => ({ ...o, [k]: v }));
  const result = useMemo(() => calc({ metricType: "revenue", params, ...props }), [params, props.confidence, props.power, props.tails, props.variants]);
  const overallMean = (params.pctNonZero / 100) * params.meanNonZero;
  const cvBuyers = params.meanNonZero > 0 ? (params.sdNonZero / params.meanNonZero).toFixed(2) : "?";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)", gap: 32, alignItems: "start" }}>
      <div>
        <Callout icon={"\uD83D\uDCCB"} title="When to use this" color={V.purple}>
          Use for <strong>revenue per visitor</strong> or similar zero-inflated metrics: donations/user, spend/session, tips/delivery. Key trait: <em>most users contribute $0</em>. This is the hardest metric type to test.
        </Callout>
        <Field label="% users with non-zero spend" help="What fraction actually purchases? This is your conversion rate." value={params.pctNonZero} onChange={v => p("pctNonZero", v)} suffix="%" min={0.1} max={100} mono />
        <Field label="Mean spend (among buyers only)" help="Average amount among users who DO buy. Exclude $0 users. SQL: AVG(amount) WHERE amount > 0." value={params.meanNonZero} onChange={v => p("meanNonZero", v)} suffix="$" min={0.01} mono />
        <Field label="SD of spend (among buyers)" help={"CV among buyers = SD/Mean = " + cvBuyers + ". Revenue CV of 0.8\u20131.2 is typical."} value={params.sdNonZero} onChange={v => p("sdNonZero", v)} suffix="$" min={0.01} mono />
        <Field label="Minimum detectable effect" help="Smallest change in overall $/visitor (all visitors, including $0)." value={params.mde} onChange={v => p("mde", v)} suffix="$/visitor" min={0.01} mono />
        <Callout icon={"\uD83D\uDCB0"} title="Revenue breakdown" color={V.purple}>
          Overall revenue/visitor = <strong style={{ fontFamily: V.mono }}>${overallMean.toFixed(2)}</strong> ({params.pctNonZero}% convert {"\u00D7"} ${params.meanNonZero} avg).
          Detecting ${params.mde} = {overallMean > 0 ? ((params.mde / overallMean) * 100).toFixed(1) : 0}% relative change.
        </Callout>
        <GuideBox icon={"\uD83E\uDDE9"} title="Too many users needed?" color={V.purple}>
          Decompose into two tests: (1) Binary test on conversion rate (cheaper). (2) Continuous test on AOV among buyers (less noisy {"\u2014"} no zeros). If either improves, revenue goes up.
        </GuideBox>
        <GuideBox icon={"\uD83D\uDC0B"} title="Watch for whales" color={V.red}>
          One user spending $5,000 can shift a group's average dramatically. Cap outliers at the 99th percentile BEFORE the test starts (winsorizing).
        </GuideBox>
      </div>
      <ResultsPanel result={result} metricType="revenue" params={params} tabColor={V.purple} {...props} />
    </div>
  );
}

/* ─── LEARN TAB ─── */
const CONCEPTS = [
  {
    id: "sd", emoji: "\uD83D\uDCCA", title: "Standard Deviation (SD)", subtitle: "The noise level of your data", color: V.green,
    sections: [
      { type: "text", content: "Standard deviation measures how spread out your data is around the average. It's the single most important factor in determining how much data you need. Small SD = predictable, clustered data. Large SD = scattered, noisy data." },
      { type: "analogy", icon: "\uD83C\uDFAF", title: "The Archery Analogy", content: "Imagine two archers shooting at a target. Archer A's arrows land in a tight cluster (low SD). Archer B's arrows scatter everywhere (high SD). If both switch to new bows, it's easy to tell if Archer A improved \u2014 the cluster shifted. But for Archer B, a slight improvement is hidden in the scatter. High SD makes experiments harder." },
      { type: "analogy", icon: "\uD83C\uDF21\uFE0F", title: "The Thermometer Analogy", content: "A city with temp 70\u00B0F \u00B1 2\u00B0F (low SD): if you see 73\u00B0F, something changed. A city with 70\u00B0F \u00B1 20\u00B0F (high SD): 73\u00B0F is just a normal fluctuation. You need more days of data to detect a real temperature shift in the noisy city." },
      { type: "key", content: "For binary metrics, SD = \u221A(p \u00D7 (1-p)) \u2014 auto-calculated. For continuous metrics, look it up in your analytics or SQL: STDDEV(metric). If SD is too high, consider capping outliers (winsorizing), using a less noisy metric, or segmenting users." },
      { type: "impact", content: "Doubling the SD quadruples the required sample size. It's the most expensive factor alongside MDE." },
    ],
  },
  {
    id: "mde", emoji: "\uD83D\uDD0D", title: "Minimum Detectable Effect (MDE)", subtitle: "Your experiment's sensitivity dial", color: V.accent,
    sections: [
      { type: "text", content: "MDE is the smallest real difference your experiment is designed to catch. It's a decision you make BEFORE running the test \u2014 not something you discover after. Think of it as the resolution of your microscope: finer resolution costs more (bigger sample)." },
      { type: "analogy", icon: "\u2696\uFE0F", title: "The Bathroom Scale", content: "A scale accurate to \u00B11 pound can't detect a 0.1-pound loss. It easily detects a 5-pound loss. MDE is choosing the precision of your scale. A tiny MDE requires an extremely precise (expensive) scale. A large MDE works on a cheap one." },
      { type: "analogy", icon: "\uD83D\uDCFB", title: "The Radio Signal", content: "MDE is like how faint a radio signal you want to pick up. Strong signal (large MDE) = any cheap radio works. Weak signal (small MDE) = you need a powerful antenna and clear conditions. A smaller MDE = more users to separate signal from noise." },
      { type: "key", content: "For binary metrics, use relative lift (e.g. \"detect a 10% improvement on a 5% baseline = 5.0% \u2192 5.5%\"). For continuous metrics, use absolute change (e.g. \"detect a $2 increase in AOV\"). Ask: is this the smallest change that justifies shipping the feature?" },
      { type: "impact", content: "Halving the MDE quadruples the required sample size. This is the single most expensive knob. Before committing to a tiny MDE, ask: would only a larger effect be worth acting on anyway?" },
    ],
  },
  {
    id: "confidence", emoji: "\uD83D\uDEE1\uFE0F", title: "Confidence Level (1 \u2212 \u03B1)", subtitle: "Your false alarm shield", color: V.orange,
    sections: [
      { type: "text", content: "Confidence level protects you against false positives \u2014 concluding something works when it doesn't. At 95% confidence (\u03B1 = 5%), there's only a 5% chance of this mistake. It's the bar of evidence required before declaring a winner." },
      { type: "analogy", icon: "\uD83D\uDEA8", title: "The Fire Alarm", content: "A fire alarm with 95% confidence only false-alarms 5% of the time. Set it to 80% and you get false alarms 20% of the time \u2014 you'll sometimes evacuate for nothing (ship features that don't help). Set it to 99% and false alarms almost never happen, but the alarm also becomes harder to trigger for real fires (needs more data)." },
      { type: "analogy", icon: "\u2696\uFE0F", title: "The Courtroom", content: "95% confidence is like \"beyond reasonable doubt.\" You want strong evidence before declaring a feature guilty of being effective. Lower confidence = more lenient court (more wrongful convictions = false positives). Higher confidence = stricter court (fewer mistakes, but sometimes real effects go undetected)." },
      { type: "key", content: "95% is industry standard. Use 90% for exploratory tests. Use 99% for critical decisions (pricing, core flow) where a false positive is very costly. Don't go below 90% for any decision you'd ship on." },
      { type: "watch", content: "Running 20 tests at 95% confidence? Expect ~1 false positive by pure chance. This is why you must define your primary metric BEFORE the test \u2014 don't cherry-pick the best result across many metrics." },
    ],
  },
  {
    id: "power", emoji: "\uD83D\uDCAA", title: "Statistical Power (1 \u2212 \u03B2)", subtitle: "Your ability to catch real wins", color: V.purple,
    sections: [
      { type: "text", content: "Power is the probability of detecting a real effect when it truly exists. At 80% power, if the change genuinely helps, you detect it 80% of the time. The other 20%? You miss it and wrongly conclude \"no effect\" \u2014 a false negative." },
      { type: "analogy", icon: "\uD83C\uDFA3", title: "The Fishing Net", content: "Power is net quality. An 80% net catches 8 of 10 fish (real effects). 2 escape (false negatives). A 90% net catches 9 of 10 but costs more (more data). Choose based on how bad it is to miss a fish \u2014 for high-stakes decisions, use 90%." },
      { type: "analogy", icon: "\uD83D\uDD26", title: "The Flashlight", content: "Searching a dark room for a coin. Power = flashlight brightness. At 80% you find most coins. At 50% (underpowered test) you miss half and conclude \"nothing here\" when there is. More data = brighter flashlight = fewer missed opportunities." },
      { type: "key", content: "80% is the default. Use 90% when missing a real effect is costly (e.g., you'd abandon a project based on the result). Never go below 70% \u2014 you'd be essentially flipping a biased coin." },
      { type: "watch", content: "Underpowered tests are the #1 experiment mistake. Teams run tests with too little traffic, see \"not significant,\" and conclude the feature doesn't work \u2014 when they simply couldn't detect it. Always calculate sample size BEFORE starting." },
    ],
  },
  {
    id: "sample", emoji: "\uD83D\uDC65", title: "Sample Size", subtitle: "Where everything comes together", color: V.text,
    sections: [
      { type: "text", content: "Sample size is the OUTPUT \u2014 not an input. It's determined by SD, MDE, confidence, and power. It tells you how many users per group you need for reliable results. Think of it as the price tag for your experiment." },
      { type: "analogy", icon: "\uD83C\uDFB5", title: "The Concert Analogy", content: "Hearing a specific instrument in an orchestra. If the instrument is loud (large MDE) and the orchestra is quiet (low SD), listen once. If the instrument is soft (small MDE) and the orchestra blares (high SD), you need to listen many times and average. Sample size = number of listens." },
      { type: "table", title: "The cost of each knob", rows: [
        ["Halve the MDE", "4\u00D7 more users"],
        ["Double the SD", "4\u00D7 more users"],
        ["95% \u2192 99% confidence", "~1.7\u00D7 more users"],
        ["80% \u2192 90% power", "~1.3\u00D7 more users"],
        ["Add 1 variant (A/B \u2192 A/B/C)", "1.5\u00D7 total users"],
      ]},
      { type: "key", content: "MDE and SD together drive the vast majority of cost. Confidence and power matter less. The cheapest way to shrink sample size: measure a less noisy metric or accept a larger MDE." },
      { type: "watch", content: "Never start without knowing your sample size. Never stop early because it 'looks significant.' Never extend because it 'almost' reached significance. All of these inflate false positive rates." },
    ],
  },
  {
    id: "distributions", emoji: "\uD83D\uDCC8", title: "Why Distribution Type Matters", subtitle: "Not all data behaves the same", color: V.teal,
    sections: [
      { type: "text", content: "You don't need your raw data to be normal. The Central Limit Theorem says the AVERAGE becomes approximately normal with enough samples. But \"enough\" depends on how weirdly shaped your data is. Skewed data needs more samples for CLT to kick in." },
      { type: "analogy", icon: "\uD83C\uDF0A", title: "The River Analogy", content: "Different metrics are different bodies of water. Binary = calm lake (predictable, things float or sink). Continuous = flowing river (smooth but variable). Count = rocky stream (discrete bursts). Revenue per visitor = flash flood channel (dry 90% of the time, then suddenly huge)." },
      { type: "table", title: "At a glance", rows: [
        ["Binary (conversion)", "SD auto-calculated from rate"],
        ["Continuous (averages)", "Need SD from data, watch for skew"],
        ["Count (events)", "Poisson or overdispersed?"],
        ["Revenue (zero-inflated)", "Highest variance, hardest to test"],
      ]},
      { type: "key", content: "Using the wrong type won't break math but will give the wrong sample size. Binary is simplest (SD is automatic). Revenue is hardest (extreme variance from zeros). When in doubt, use Continuous with your actual SD." },
    ],
  },
  {
    id: "pmove", emoji: "🧭", title: "P-Move (Bayesian Confidence)", subtitle: "Will it actually hold up in production?", color: V.green,
    sections: [
      { type: "text", content: "P-Move is the probability that the metric truly moves in the direction you want if you ship, given both the data AND the platform's history. Where the p-value asks 'is this just noise?', the P-Move asks 'will this actually hold up?' One is a noise filter. The other is a business compass." },
      { type: "analogy", icon: "🌦️", title: "Meteorology: the forecast", content: "A forecast does not just look at today's sky. It blends today's reading with decades of patterns. You launch Monday, the dashboard screams +30% at p=0.001, and you want to ship by lunch. But the P-Move says only 65%, because its prior knows Monday traffic is volatile and unrepresentative. It suppresses your excitement until the lift survives a full seven-day week." },
      { type: "analogy", icon: "✈️", title: "The two-gauge cockpit", content: "The p-value is your stall warning: a frequentist guardrail that screams when the data is too weird to be chance. The P-Move is your GPS heading: the business compass that says where you will actually end up. Pilots do not pick one gauge over the other. Neither should you." },
      { type: "key", content: "Above 80% P-Move is a confident ship. 70 to 80% is trending, so gather more data. Around 50% is a coin toss. Use the P-Move as the business decision and the p-value as the noise guardrail." },
      { type: "watch", content: "A significant p-value paired with a low P-Move is the classic False Alarm: it looks real today, but the prior says it will not replicate. Never ship on the p-value alone." },
    ],
  },
  {
    id: "prior", emoji: "📜", title: "The Prior (Historical Ledger)", subtitle: "Why mature products demand more proof", color: V.orange,
    sections: [
      { type: "text", content: "Before a Bayesian system trusts your new data, it checks the platform's track record. Because most ideas fail, it assumes yours fails too, until the data overwhelms that assumption. This is the memory that stops you chasing every shiny short-term spike." },
      { type: "analogy", icon: "💳", title: "Finance: the credit score", content: "Company A has run 10,000 experiments and 90% failed, because its product is already heavily optimized. Company B is a startup with 50 experiments and a 50% win rate, because the fruit still hangs low. Both see the same +2% lift. B's system trusts it instantly. A's skeptical prior assumes a fluke and demands three times the sample before it believes." },
      { type: "key", content: "The prior is why '+2% at p=0.04' can be a ship at a young product and a shrug at a mature one. To calibrate properly it needs roughly 12 months of logged experiment outcomes: each past test's variance and result." },
      { type: "watch", content: "With no prior, every short-term result looks like a win, and you will ship Monday-morning spikes that vanish by Thursday. The prior is the discipline that prevents it." },
    ],
  },
];

const CASE_STUDIES = [
  {
    id: 1, color: V.accent, tag: "CONVERSION \u00B7 BINARY", company: "E-commerce platform",
    title: "Will the new checkout flow increase purchases?",
    scenario: "Product team redesigned checkout from 3 steps to 1 page. They want to know if this increases purchase completion rate.",
    setup: "Baseline: 3.2%. Target: detect 15% relative lift (3.2% \u2192 3.68%). Settings: 95% confidence, 80% power, two-sided.",
    walkthrough: ["Metric type = Binary (did user purchase? yes/no)", "Baseline rate = 3.2%", "MDE = 15% relative lift = 0.48pp absolute", "SD auto-calculated = \u221A(0.032 \u00D7 0.968) = 0.176", "Formula \u2192 ~47,000 per group, 94,000 total"],
    result: "\u2248 47,000 per group (94,000 total)", duration: "At 5k visitors/day: ~19 days",
    insight: "Low baselines are expensive \u2014 the 0.48pp absolute effect is tiny even though 15% relative sounds big. The signal is quiet, requiring lots of data.",
    lessons: ["If traffic-limited, test a higher-funnel metric (e.g., reached checkout page) with a higher baseline.", "Don't test 5 checkout designs at once (5 \u00D7 47k = 235k). Test the top 2.", "Round to 21 days (full weeks) to capture weekend patterns."],
  },
  {
    id: 2, color: V.green, tag: "AVERAGES \u00B7 CONTINUOUS", company: "Content platform",
    title: "Do product reviews increase time on page?",
    scenario: "Team added user reviews below articles. Hypothesis: this increases session duration, which correlates with ad revenue.",
    setup: "Mean: 4.2 min, SD: 6.8 min (right-skewed). MDE: 0.5 min (30 seconds). Skew buffer: yes.",
    walkthrough: ["Metric type = Continuous (session duration)", "Mean=4.2, SD=6.8, MDE=0.5", "Cohen's d = 0.5/6.8 = 0.074 (very small!)", "Base calc \u2192 ~2,900 per group", "30% skew buffer \u2192 ~3,800 per group, 7,600 total"],
    result: "\u2248 3,800 per group (7,600 total)", duration: "At 10k visitors/day: ~1 day (run 7+ anyway)",
    insight: "CV of 1.6x means very noisy data. Skew buffer is critical \u2014 without it, actual power drops to ~70%. CLT needs more data for skewed distributions.",
    lessons: ["Session duration can be misleading \u2014 longer might mean confused, not engaged. Pair with conversion.", "Log-transforming duration often reduces skew and sample size dramatically.", "Always run 7+ days regardless of math \u2014 short tests capture novelty effects."],
  },
  {
    id: 3, color: V.orange, tag: "COUNTS \u00B7 OVERDISPERSED", company: "Mobile shopping app",
    title: "Do push notifications drive more cart additions?",
    scenario: "Growth team sends sale alerts. They measure if this increases items added to cart per user per session.",
    setup: "Mean: 2.3 items, Variance: 5.1 (2.2x overdispersed). MDE: 0.3 items. Not Poisson.",
    walkthrough: ["Metric type = Count (items per session)", "Mean=2.3, Poisson=OFF, Variance=5.1", "Dispersion ratio = 5.1/2.3 = 2.2x (overdispersed!)", "SD = \u221A5.1 = 2.26 (Poisson would be \u221A2.3 = 1.52)", "Result: ~2,250/group. Poisson would wrongly give ~1,020 (underpowered!)"],
    result: "\u2248 2,250 per group (4,500 total)", duration: "At 8k DAU: ~1 day (run 7+)",
    insight: "Poisson assumption would underestimate by 2.2x, giving only ~55% power instead of 80% \u2014 you'd miss real effects half the time. Always check if variance > mean.",
    lessons: ["Decide upfront: items per session or total per user? Be consistent.", "Randomize users on day 1, then observe for the full week.", "Consider per-user totals to avoid visit-frequency complications."],
  },
  {
    id: 4, color: V.purple, tag: "REVENUE \u00B7 ZERO-INFLATED", company: "Two-sided marketplace",
    title: "Do 'Trusted Seller' badges increase revenue/visitor?",
    scenario: "Trust team shows verified seller badges to build buyer confidence and increase purchases.",
    setup: "8% buy something. Buyers spend $62 avg (SD $55). MDE: $0.50 increase in overall $/visitor.",
    walkthrough: ["Metric = Revenue (92% spend $0)", "% non-zero=8%, Buyer mean=$62, Buyer SD=$55", "Overall $/visitor = 8% \u00D7 $62 = $4.96", "Overall SD = $20.31 (4x the mean!)", "Base calc \u00D7 1.4 buffer = ~85k/group, 170k total"],
    result: "\u2248 85,000 per group (170,000 total)", duration: "At 20k visitors/day: ~9 days",
    insight: "Overall SD ($20.31) is 4x overall mean ($4.96) because 92% contribute $0. This extreme variance makes revenue the hardest metric. The $0.50 MDE is a 10% lift \u2014 quite ambitious.",
    lessons: ["Decompose: binary test on conversion (8%\u21928.8%?) is much cheaper than testing overall revenue.", "Cap outliers at 99th percentile BEFORE the test. One $10k whale shifts a group's average.", "If 170k is impractical, raise MDE to $1.00 \u2014 roughly 4x cheaper (check sensitivity table).", "The badge likely affects conversion more than AOV \u2014 start with the binary test."],
  },
  {
    id: 5, color: V.orange, tag: "GUARDRAILS \u00b7 TRADE-OFF", company: "E-commerce platform",
    title: "Checkout got faster, but revenue dropped. Ship it?",
    scenario: "The team collapsed a 3-step checkout into a single page. It was the most-requested change of the quarter. Because checkout sits deep in the funnel, traffic is thin, so they sized for a bold 5% MDE rather than a tiny one.",
    setup: "Primary: checkout success rate. Guardrails: average order value (AOV) and page-load latency. 95% confidence, 80% power, two-sided.",
    walkthrough: ["Primary = checkout success (binary, deep funnel)", "MDE set high at 5%, because deep-funnel traffic is too thin to detect a small effect", "Result: checkout success +6.2%, P-Move 94% (a real win on the primary)", "Guardrail: AOV fell 8.5%, also significant", "Root cause: the cleaner page quietly dropped the 'frequently bought together' upsell"],
    result: "Primary +6.2% \u00b7 AOV down 8.5%", duration: "Verdict: hold, do not ship",
    insight: "The feature did exactly what it was designed to do, and that was the trap. It bought completion speed by cannibalizing basket size. A win on the North Star that breaks a guardrail is not a win, it is a bill you pay later.",
    lessons: ["A significant primary plus a broken guardrail is The Cannibal. Hold and redesign, do not ship.", "Re-introduce the upsell without re-introducing friction: try a slim inline module or a post-purchase offer.", "Name your guardrails before launch. You cannot catch a trade-off you never defined."],
  },
  {
    id: 6, color: V.text, tag: "SYNTHESIS \u00b7 KILL", company: "Search platform",
    title: "A month of engineering moved nothing. Ship it anyway?",
    scenario: "Engineering shipped a more sophisticated auto-suggest algorithm for top-of-funnel search. Because it touches 100% of traffic, the test reached high statistical power within 48 hours.",
    setup: "Primary: search-to-click rate. Guardrails: zero-result rate and API latency. MDE tiny at 0.5%, because traffic is massive.",
    walkthrough: ["Primary = search-to-click (100% of traffic, high power fast)", "Result: +0.1%, not significant", "P-Move = 51%, a pure coin toss", "Guardrail: API latency rose 15ms, significant", "Context: engineers spent a month building it"],
    result: "Primary flat \u00b7 latency +15ms", duration: "Verdict: deprecate (kill it)",
    insight: "With this much traffic the metric still did not budge, so this is not an underpowered Trend, it is a true Flatline. The only measurable effect was 15ms of added latency and a more complex codebase to carry forever.",
    lessons: ["Not significant plus a P-Move near 50% is The Flatline: the effect is genuinely zero, not merely unproven.", "Sunk cost is not a reason to ship. Code you ship is code you maintain forever.", "Contrast it with The Trend: if the P-Move were 75%, you would extend the test, not kill it. The prior is what tells the two apart."],
  },
];

function LearnTab() {
  const [expandedConcept, setExpandedConcept] = useState(null);
  const [expandedCase, setExpandedCase] = useState(null);

  const renderSection = (s, i, concept) => {
    const base = { fontSize: 13, color: V.textSecondary, lineHeight: 1.7, fontFamily: V.font };
    if (s.type === "text") return <p key={i} style={{ ...base, fontSize: 14, lineHeight: 1.75, margin: "0 0 14px" }}>{s.content}</p>;
    if (s.type === "analogy") return (
      <div key={i} style={{ background: concept.color + "06", borderLeft: "3px solid " + concept.color, borderRadius: "0 10px 10px 0", padding: "14px 18px", marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: concept.color, fontFamily: V.font, marginBottom: 6 }}>{s.icon} {s.title}</div>
        <div style={base}>{s.content}</div>
      </div>
    );
    if (s.type === "key") return (
      <div key={i} style={{ background: V.accentSoft, borderRadius: V.radiusSm, padding: "14px 18px", marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: V.accent, fontFamily: V.font, marginBottom: 4 }}>{"\uD83D\uDD11"} Key takeaway</div>
        <div style={base}>{s.content}</div>
      </div>
    );
    if (s.type === "watch") return (
      <div key={i} style={{ background: V.redBg, borderRadius: V.radiusSm, padding: "14px 18px", marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: V.red, fontFamily: V.font, marginBottom: 4 }}>{"\u26A0\uFE0F"} Common mistake</div>
        <div style={base}>{s.content}</div>
      </div>
    );
    if (s.type === "impact") return (
      <div key={i} style={{ background: V.orangeBg, borderRadius: V.radiusSm, padding: "14px 18px", marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: V.orange, fontFamily: V.font, marginBottom: 4 }}>{"\uD83D\uDCD0"} Impact on sample size</div>
        <div style={base}>{s.content}</div>
      </div>
    );
    if (s.type === "table") return (
      <div key={i} style={{ background: V.surface, borderRadius: V.radiusSm, border: "1px solid " + V.borderLight, overflow: "hidden", marginBottom: 14 }}>
        {s.title && <div style={{ padding: "10px 16px", background: V.surfaceAlt, fontSize: 12, fontWeight: 700, color: V.textSecondary, fontFamily: V.font, borderBottom: "1px solid " + V.borderLight }}>{s.title}</div>}
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: V.font, fontSize: 13 }}>
          <tbody>{s.rows.map((row, ri) => (
            <tr key={ri}>{row.map((cell, ci) => (
              <td key={ci} style={{ padding: "10px 16px", borderBottom: ri < s.rows.length - 1 ? "1px solid " + V.borderLight : "none", color: ci === 0 ? V.textSecondary : V.text, fontWeight: ci === 0 ? 400 : 600, fontFamily: ci > 0 ? V.mono : V.font, fontSize: 13 }}>{cell}</td>
            ))}</tr>
          ))}</tbody>
        </table>
      </div>
    );
    return null;
  };

  return (
    <div style={{ maxWidth: 820, margin: "0 auto" }}>
      <div style={{ background: "linear-gradient(135deg, " + V.teal + "08, " + V.accent + "06)", borderRadius: V.radiusLg, padding: "32px 36px", marginBottom: 36, border: "1px solid " + V.teal + "15" }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: V.text, fontFamily: V.font, letterSpacing: -0.5, marginBottom: 8 }}>A/B Testing Fundamentals</div>
        <p style={{ fontSize: 15, color: V.textSecondary, lineHeight: 1.7, fontFamily: V.font, margin: 0, maxWidth: 600 }}>
          Everything you need to design an experiment, plus the mental models to read it once results land. Real analogies, six worked case studies, and a pre-launch checklist.
        </p>
      </div>

      <div style={{ background: V.surface, borderRadius: V.radiusLg, padding: "24px 28px", border: "1px solid " + V.borderLight, boxShadow: V.shadow, marginBottom: 36 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: V.text, fontFamily: V.font, marginBottom: 12 }}>The Big Picture</div>
        <p style={{ fontSize: 14, color: V.textSecondary, lineHeight: 1.75, fontFamily: V.font, margin: "0 0 12px" }}>
          An A/B test splits users into groups, shows each a different experience, and checks if the difference in a metric is real or just random noise. The challenge: random variation ALWAYS exists. Even with no change, Group A's rate will never exactly equal Group B's.
        </p>
        <p style={{ fontSize: 14, color: V.textSecondary, lineHeight: 1.75, fontFamily: V.font, margin: "0 0 16px" }}>
          You need enough data to tell the difference between "this is a real improvement" and "this is just a lucky fluctuation." The first six concepts below determine how much data that takes. The last two, P-Move and the Prior, are about reading the result once it lands.
        </p>
        <div style={{ background: V.tealBg, borderRadius: V.radiusSm, padding: "16px 20px", fontSize: 14, color: V.text, fontFamily: V.font, lineHeight: 1.65, fontWeight: 500 }}>
          <strong style={{ color: V.teal }}>The formula in plain English:</strong> Sample size = the price you pay to hear a quiet signal (small MDE) through loud noise (high SD) with high certainty (confidence) and high sensitivity (power).
        </div>
      </div>

      {/* Concepts */}
      <div style={{ marginBottom: 48 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: V.textTertiary, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12, fontFamily: V.font }}>Core Concepts</div>
        <p style={{ fontSize: 14, color: V.textSecondary, fontFamily: V.font, margin: "0 0 16px", lineHeight: 1.6 }}>Tap each to expand. Read in order {"\u2014"} each builds on the last.</p>
        <div style={{ background: V.surface, borderRadius: V.radiusLg, border: "1px solid " + V.borderLight, boxShadow: V.shadow, overflow: "hidden" }}>
          {CONCEPTS.map((c, i) => (
            <div key={c.id}>
              <div onClick={() => setExpandedConcept(expandedConcept === c.id ? null : c.id)}
                style={{ padding: "18px 24px", cursor: "pointer", display: "flex", alignItems: "center", gap: 16, background: expandedConcept === c.id ? V.surfaceAlt : "transparent", transition: "background 0.15s" }}>
                <div style={{ width: 42, height: 42, borderRadius: 12, background: c.color + "10", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{c.emoji}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: V.text, fontFamily: V.font }}>{c.title}</div>
                  <div style={{ fontSize: 13, color: V.textTertiary, fontFamily: V.font, marginTop: 1 }}>{c.subtitle}</div>
                </div>
                <span style={{ color: V.textTertiary, fontSize: 14, transition: "transform 0.25s", transform: expandedConcept === c.id ? "rotate(180deg)" : "rotate(0)", display: "inline-block" }}>{"\u25BE"}</span>
              </div>
              {expandedConcept === c.id && <div style={{ padding: "4px 24px 24px 82px" }}>{c.sections.map((s, si) => renderSection(s, si, c))}</div>}
              {i < CONCEPTS.length - 1 && <div style={{ height: 1, background: V.borderLight, marginLeft: 82 }} />}
            </div>
          ))}
        </div>
      </div>

      {/* Case Studies */}
      <div style={{ marginBottom: 48 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: V.textTertiary, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12, fontFamily: V.font }}>Worked Case Studies</div>
        <p style={{ fontSize: 14, color: V.textSecondary, fontFamily: V.font, margin: "0 0 16px", lineHeight: 1.6 }}>Complete walkthroughs showing the thought process for each metric type.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {CASE_STUDIES.map(cs => {
            const open = expandedCase === cs.id;
            return (
              <div key={cs.id} style={{ background: V.surface, borderRadius: V.radiusLg, border: "1px solid " + (open ? cs.color + "30" : V.borderLight), boxShadow: open ? V.shadowLg : V.shadow, overflow: "hidden", transition: "all 0.25s" }}>
                <div onClick={() => setExpandedCase(open ? null : cs.id)} style={{ padding: "22px 26px", cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 16 }}>
                  <div style={{ width: 42, height: 42, borderRadius: 12, background: cs.color + "10", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 800, color: cs.color, fontFamily: V.mono, flexShrink: 0 }}>{cs.id}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: cs.color, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 4, fontFamily: V.font }}>{cs.tag} {"\u00B7"} {cs.company}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: V.text, fontFamily: V.font, lineHeight: 1.4 }}>{cs.title}</div>
                  </div>
                  <span style={{ color: V.textTertiary, fontSize: 14, transition: "transform 0.25s", transform: open ? "rotate(180deg)" : "rotate(0)", display: "inline-block", marginTop: 8 }}>{"\u25BE"}</span>
                </div>
                {open && (
                  <div style={{ padding: "0 26px 26px 84px" }}>
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: V.textTertiary, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, fontFamily: V.font }}>Scenario</div>
                      <p style={{ fontSize: 14, color: V.textSecondary, lineHeight: 1.7, fontFamily: V.font, margin: 0 }}>{cs.scenario}</p>
                    </div>
                    <div style={{ background: V.surfaceAlt, borderRadius: V.radiusSm, padding: "14px 18px", marginBottom: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: V.textTertiary, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, fontFamily: V.font }}>Setup</div>
                      <p style={{ fontSize: 13, color: V.textSecondary, lineHeight: 1.6, fontFamily: V.font, margin: 0 }}>{cs.setup}</p>
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: cs.color, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10, fontFamily: V.font }}>Step-by-step</div>
                      {cs.walkthrough.map((step, si) => (
                        <div key={si} style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 8 }}>
                          <div style={{ width: 22, height: 22, borderRadius: 11, background: cs.color + "15", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: cs.color, fontFamily: V.mono, flexShrink: 0, marginTop: 1 }}>{si + 1}</div>
                          <div style={{ fontSize: 13, color: V.textSecondary, lineHeight: 1.6, fontFamily: V.font }}>{step}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ background: cs.color + "08", borderRadius: V.radiusSm, padding: "16px 20px", marginBottom: 14, textAlign: "center" }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: cs.color, fontFamily: V.mono }}>{cs.result}</div>
                      <div style={{ fontSize: 12, color: V.textTertiary, marginTop: 4, fontFamily: V.font }}>{cs.duration}</div>
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: V.text, marginBottom: 6, fontFamily: V.font }}>Why this number?</div>
                      <p style={{ fontSize: 14, color: V.textSecondary, lineHeight: 1.7, fontFamily: V.font, margin: 0 }}>{cs.insight}</p>
                    </div>
                    <div style={{ background: V.greenBg, borderRadius: V.radiusSm, padding: "16px 20px" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: V.green, marginBottom: 10, fontFamily: V.font }}>Lessons</div>
                      {cs.lessons.map((l, li) => (
                        <div key={li} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: li < cs.lessons.length - 1 ? 8 : 0 }}>
                          <span style={{ color: V.green, fontSize: 12, marginTop: 2 }}>{"\u2714"}</span>
                          <span style={{ fontSize: 13, color: V.textSecondary, lineHeight: 1.6, fontFamily: V.font }}>{l}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Checklist */}
      <div style={{ marginBottom: 40 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: V.textTertiary, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12, fontFamily: V.font }}>Pre-Launch Checklist</div>
        <div style={{ background: V.surface, borderRadius: V.radiusLg, border: "1px solid " + V.borderLight, boxShadow: V.shadow, padding: "24px 28px" }}>
          {[
            { icon: "\uD83C\uDFAF", title: "Define one primary metric", text: "Pick the single metric that defines success. Testing 10 metrics at 95% confidence gives ~1 false positive by chance. Track secondaries for learning, but don't use them to pick winners." },
            { icon: "\uD83D\uDCCF", title: "Calculate sample size first", text: "Use this tool BEFORE starting. Know how many users and days you need. If traffic is insufficient, adjust MDE or metric \u2014 not rigor." },
            { icon: "\uD83D\uDEAB", title: "Don't peek at results", text: "Checking daily and stopping when it 'looks significant' inflates false positives from 5% to 20-30%. Commit to the full duration." },
            { icon: "\uD83D\uDCC5", title: "Run full weeks", text: "Behavior differs by day of week. Running Mon\u2013Thu misses weekends. Minimum 7 days, ideal 14 days." },
            { icon: "\uD83D\uDD00", title: "Verify randomization", text: "After launch, check that groups are balanced on key dimensions (new vs returning, mobile vs desktop). Imbalanced groups produce biased results." },
            { icon: "\uD83D\uDCDD", title: "Document everything", text: "Record hypothesis, primary metric, MDE, duration, and analysis plan BEFORE starting. Prevents post-hoc rationalization." },
            { icon: "\uD83D\uDD04", title: "Plan for every outcome", text: "Decide upfront: what if it wins? Loses? Inconclusive? This prevents decision paralysis after results arrive." },
          ].map((item, i) => (
            <div key={i} style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: "14px 0", borderBottom: i < 6 ? "1px solid " + V.borderLight : "none" }}>
              <span style={{ fontSize: 18, marginTop: 1 }}>{item.icon}</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: V.text, fontFamily: V.font, marginBottom: 2 }}>{item.title}</div>
                <div style={{ fontSize: 13, color: V.textSecondary, lineHeight: 1.6, fontFamily: V.font }}>{item.text}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── DECIDE TAB (Decision Synthesizer) ─── */
const VERDICTS = [
  { key: "bug", name: "The Bug", color: V.red, bg: V.redBg, emoji: "⛔",
    action: "Abort the test immediately. Do not read any other metric.",
    reason: "Sample Ratio Mismatch means your intended 50/50 split actually landed at, say, 51/49. The randomizer is broken, so every downstream number is poisoned by selection bias. Fix the logging, then rerun from scratch." },
  { key: "cannibal", name: "The Cannibal", color: V.orange, bg: V.orangeBg, emoji: "⚠️",
    action: "Hold. Redesign to fix the trade-off, then retest.",
    reason: "The primary metric is up and real, but it wins by breaking a guardrail: stealing higher-value clicks, adding latency, or shrinking the basket. A win that breaks the ecosystem is not a win, it is a bill you pay later." },
  { key: "win", name: "The Clean Win", color: V.green, bg: V.greenBg, emoji: "✅",
    action: "Ship to 100% of production.",
    reason: "The p-value proves it is not noise. The P-Move forecasts it will hold up against the platform's history. The guardrails confirm it does no harm elsewhere. All three gates are green." },
  { key: "trend", name: "The Trend", color: V.accent, bg: V.accentSoft, emoji: "📈",
    action: "Extend the test. Gather more traffic.",
    reason: "The Bayesian prior suspects a real win is hiding here, but you do not yet have the power to push the p-value across the line. More data shrinks the variance. Give it another full week before you judge." },
  { key: "flatline", name: "The Flatline", color: V.textSecondary, bg: V.surfaceAlt, emoji: "〰️",
    action: "Deprecate. Remove the code and the debt.",
    reason: "Direction is a coin toss and the prior is not pulling for it. This is genuine zero, not unproven. Do not ship just because it was built: every shipped line is maintained forever." },
  { key: "alarm", name: "False Alarm", color: V.textTertiary, bg: V.surfaceAlt, emoji: "ℹ️",
    action: "Do not ship. Treat it as a statistical anomaly.",
    reason: "The frequentist and Bayesian models disagree: significant today, but the prior says it will not replicate. Run 20 flat tests and one will look like a winner by pure chance. This is probably that one." },
];

function decide({ srm, guardrails, pvalue, pmove }) {
  if (srm === "fail") return "bug";
  if (guardrails === "broken" && pvalue === "sig") return "cannibal";
  if (pvalue === "sig" && pmove === "high" && guardrails === "clean") return "win";
  if (pvalue === "notsig" && (pmove === "medium" || pmove === "high")) return "trend";
  if (pvalue === "notsig" && pmove === "low") return "flatline";
  return "alarm";
}

function DecideControl({ label, help, children, last }) {
  return (
    <div style={{ marginBottom: last ? 0 : 18 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: V.text, fontFamily: V.font, marginBottom: help ? 2 : 8 }}>{label}</div>
      {help && <div style={{ fontSize: 12, color: V.textTertiary, fontFamily: V.font, marginBottom: 8, lineHeight: 1.5 }}>{help}</div>}
      {children}
    </div>
  );
}

function DecideTab() {
  const [srm, setSrm] = useState("pass");
  const [guardrails, setGuardrails] = useState("clean");
  const [pvalue, setPvalue] = useState("sig");
  const [pmove, setPmove] = useState("high");
  const rec = VERDICTS.find(v => v.key === decide({ srm, guardrails, pvalue, pmove }));

  const matrix = [
    { srm: "Fail", guard: "—", pv: "—", pm: "—", v: "bug" },
    { srm: "Pass", guard: "Broken", pv: "Sig", pm: "High", v: "cannibal" },
    { srm: "Pass", guard: "Clean", pv: "Sig", pm: "High", v: "win" },
    { srm: "Pass", guard: "Clean", pv: "Sig", pm: "Low", v: "alarm" },
    { srm: "Pass", guard: "Clean", pv: "Not sig", pm: "Trending", v: "trend" },
    { srm: "Pass", guard: "Clean", pv: "Not sig", pm: "Low", v: "flatline" },
  ];

  const signals = [
    { t: "1. Health (SRM)", c: V.purple, d: "Sample Ratio Mismatch. Did the 50/50 split actually land 50/50? If not, randomization is broken and nothing else matters." },
    { t: "2. Guardrails", c: V.orange, d: "The do-no-harm metrics: latency, AOV, core CTR. A primary win that breaks one of these is a trap, not a win." },
    { t: "3. P-Value", c: V.accent, d: "The frequentist noise check. Is the result weird enough to rule out pure chance? A low p-value means probably not noise." },
    { t: "4. P-Move", c: V.green, d: "The Bayesian compass. Given the data and the platform's history, will this actually hold up if you ship it?" },
  ];

  return (
    <div style={{ maxWidth: 960, margin: "0 auto" }}>
      <div style={{ background: "linear-gradient(135deg, " + V.text + "0a, " + V.accent + "06)", borderRadius: V.radiusLg, padding: "32px 36px", marginBottom: 28, border: "1px solid " + V.borderLight }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: V.text, fontFamily: V.font, letterSpacing: -0.5, marginBottom: 8 }}>The Decision Synthesizer</div>
        <p style={{ fontSize: 15, color: V.textSecondary, lineHeight: 1.7, fontFamily: V.font, margin: 0, maxWidth: 640 }}>
          Sizing the test was the easy half. The hard half is reading the results without fooling yourself. Set the four signals below and the synthesizer names the situation and the move. You can only judge guardrails if you defined them up front: primary, secondary, guardrail.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginBottom: 28 }}>
        {signals.map((s, i) => (
          <div key={i} style={{ background: V.surface, border: "1px solid " + V.borderLight, borderTop: "3px solid " + s.c, borderRadius: V.radius, padding: "16px 18px", boxShadow: V.shadow }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: s.c, fontFamily: V.font, marginBottom: 6 }}>{s.t}</div>
            <div style={{ fontSize: 12.5, color: V.textSecondary, lineHeight: 1.6, fontFamily: V.font }}>{s.d}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.3fr)", gap: 24, alignItems: "start", marginBottom: 44 }}>
        <div style={{ background: V.surface, border: "1px solid " + V.borderLight, borderRadius: V.radiusLg, boxShadow: V.shadow, padding: "24px 26px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: V.textTertiary, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 18, fontFamily: V.font }}>Set your signals</div>
          <DecideControl label="System health (SRM)">
            <Seg options={[{ value: "pass", label: "Pass" }, { value: "fail", label: "Fail" }]} value={srm} onChange={setSrm} />
          </DecideControl>
          <DecideControl label="Guardrail metrics">
            <Seg options={[{ value: "clean", label: "Clean" }, { value: "broken", label: "Broken" }]} value={guardrails} onChange={setGuardrails} />
          </DecideControl>
          <DecideControl label="Primary p-value (frequentist)">
            <Seg options={[{ value: "sig", label: "Significant" }, { value: "notsig", label: "Not sig" }]} value={pvalue} onChange={setPvalue} />
          </DecideControl>
          <DecideControl label="Primary P-Move (Bayesian)" last>
            <Seg options={[{ value: "high", label: ">85%" }, { value: "medium", label: "70-85%" }, { value: "low", label: "~50%" }]} value={pmove} onChange={setPmove} />
          </DecideControl>
        </div>

        <div style={{ background: rec.bg, border: "1.5px solid " + rec.color + "55", borderRadius: V.radiusLg, padding: "26px 28px", minHeight: 300 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
            <span style={{ fontSize: 30 }}>{rec.emoji}</span>
            <div style={{ fontSize: 26, fontWeight: 800, color: rec.color, fontFamily: V.font, letterSpacing: -0.5 }}>{rec.name}</div>
          </div>
          <div style={{ background: V.surface, borderRadius: V.radius, padding: "20px 22px", boxShadow: V.shadow }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: V.textTertiary, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6, fontFamily: V.font }}>The move</div>
            <p style={{ fontSize: 17, fontWeight: 600, color: V.text, fontFamily: V.font, margin: "0 0 18px", lineHeight: 1.4 }}>{rec.action}</p>
            <div style={{ fontSize: 11, fontWeight: 700, color: V.textTertiary, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6, fontFamily: V.font }}>Why</div>
            <p style={{ fontSize: 14, color: V.textSecondary, fontFamily: V.font, margin: 0, lineHeight: 1.7 }}>{rec.reason}</p>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 40 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: V.textTertiary, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12, fontFamily: V.font }}>The Decision Matrix</div>
        <p style={{ fontSize: 14, color: V.textSecondary, fontFamily: V.font, margin: "0 0 16px", lineHeight: 1.6 }}>Every combination of signals maps to one of six situations. Read SRM first: if it fails, stop and ignore the rest.</p>
        <div style={{ background: V.surface, borderRadius: V.radiusLg, border: "1px solid " + V.borderLight, boxShadow: V.shadow, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: V.font, fontSize: 13, minWidth: 680 }}>
              <thead><tr style={{ background: V.surfaceAlt }}>
                {["Health", "Guardrails", "P-Value", "P-Move", "Situation", "Action"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700, color: V.textTertiary, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>{matrix.map((row, i) => {
                const v = VERDICTS.find(x => x.key === row.v);
                return (
                  <tr key={i} style={{ borderTop: "1px solid " + V.borderLight }}>
                    <td style={{ padding: "12px 16px", color: V.textSecondary, fontFamily: V.mono, fontSize: 12 }}>{row.srm}</td>
                    <td style={{ padding: "12px 16px", color: V.textSecondary, fontFamily: V.mono, fontSize: 12 }}>{row.guard}</td>
                    <td style={{ padding: "12px 16px", color: V.textSecondary, fontFamily: V.mono, fontSize: 12 }}>{row.pv}</td>
                    <td style={{ padding: "12px 16px", color: V.textSecondary, fontFamily: V.mono, fontSize: 12 }}>{row.pm}</td>
                    <td style={{ padding: "12px 16px", fontWeight: 700, color: v.color, fontFamily: V.font, whiteSpace: "nowrap" }}>{v.emoji} {v.name}</td>
                    <td style={{ padding: "12px 16px", color: V.text, fontWeight: 500 }}>{v.action}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <div style={{ background: V.surfaceAlt, padding: "12px 16px", borderTop: "1px solid " + V.borderLight, fontSize: 12.5, color: V.textSecondary, fontFamily: V.font, lineHeight: 1.6 }}>
            <strong style={{ color: V.text }}>Practice:</strong> the exact P-Move thresholds depend on your org's risk tolerance. When signals conflict, protect the guardrails first and trust the prior second.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Main App ─── */
function App() {
  const [activeTab, setActiveTab] = useState("binary");
  const [confidence, setConfidence] = useState(95);
  const [power, setPower] = useState(80);
  const [tails, setTails] = useState(2);
  const [variants, setVariants] = useState(2);
  const [dailyTraffic, setDailyTraffic] = useState("");
  const [showSettingsHelp, setShowSettingsHelp] = useState(false);
  const sharedProps = { confidence, power, tails, variants, dailyTraffic };
  const isCalc = activeTab !== "learn" && activeTab !== "decide";

  return (
    <div style={{ minHeight: "100vh", background: V.bg, fontFamily: V.font }}>
      <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
      <style>{`*,*::before,*::after{box-sizing:border-box}input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield}::selection{background:${V.accent}22}`}</style>

      <header style={{ background: "rgba(250,250,249,0.85)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderBottom: "1px solid " + V.borderLight, position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 1120, margin: "0 auto", padding: "0 28px" }}>
          <div style={{ padding: "16px 0 0" }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: V.text, margin: 0, letterSpacing: -0.5, fontFamily: V.font }}>{"\uD83E\uDDEA"} Experiment Lab</h1>
            <p style={{ fontSize: 12, color: V.textTertiary, margin: "2px 0 0", fontFamily: V.font }}>Design statistically rigorous A/B tests</p>
          </div>
          <nav style={{ display: "flex", gap: 2, paddingTop: 16, overflowX: "auto" }}>
            {TABS.map(tab => {
              const active = activeTab === tab.id;
              return (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
                  padding: "10px 20px", border: "none", cursor: "pointer", background: "transparent",
                  fontFamily: V.font, fontSize: 14, fontWeight: active ? 700 : 500,
                  color: active ? tab.color : V.textTertiary,
                  borderBottom: "2.5px solid " + (active ? tab.color : "transparent"),
                  transition: "all 0.2s", display: "flex", alignItems: "center", gap: 7,
                  whiteSpace: "nowrap", paddingBottom: 12,
                }}>
                  <span style={{ fontSize: 16, fontWeight: 700, fontFamily: V.mono, opacity: active ? 1 : 0.5 }}>{tab.icon}</span>
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 1120, margin: "0 auto", padding: "28px 28px 80px" }}>
        {isCalc && <div style={{ marginBottom: 28 }}><SettingsPanel confidence={confidence} setConfidence={setConfidence} power={power} setPower={setPower} tails={tails} setTails={setTails} variants={variants} setVariants={setVariants} dailyTraffic={dailyTraffic} setDailyTraffic={setDailyTraffic} showHelp={showSettingsHelp} setShowHelp={setShowSettingsHelp} /></div>}
        <div>
          {activeTab === "binary" && <BinaryTab {...sharedProps} />}
          {activeTab === "continuous" && <ContinuousTab {...sharedProps} />}
          {activeTab === "count" && <CountTab {...sharedProps} />}
          {activeTab === "revenue" && <RevenueTab {...sharedProps} />}
          {activeTab === "learn" && <LearnTab />}
          {activeTab === "decide" && <DecideTab />}
        </div>
      </main>
    </div>
  );
}

export default App;
