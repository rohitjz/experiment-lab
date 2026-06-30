# Experiment Lab

**Design statistically rigorous A/B tests, then read the results without fooling yourself.**

A single-file teaching tool for product teams. It covers the two hard halves of experimentation that most calculators skip: sizing a test correctly *before* you spend traffic, and synthesizing a ship/hold/extend/kill decision *after* the data lands. Every number comes with the reasoning behind it.

**Live demo:** [rohitjz.github.io/experiment-lab](https://rohitjz.github.io/experiment-lab/)

## The lifecycle

Experiment Lab walks the full loop in three moves:

1. **Learn** the mental models (the statistics, in plain analogies).
2. **Design** the test (pick a metric type, get an honest sample size and duration).
3. **Decide** once results arrive (combine four signals into one of six named verdicts).

### Design: four calculator modes

| Mode | Metric Type | Example Use Cases |
|------|-------------|-------------------|
| **Conversion** | Binary (yes/no) | Signup rate, click-through rate, purchase rate, day-N retention |
| **Averages** | Continuous (numeric) | Session duration, page load time, average order value, NPS |
| **Counts** | Discrete occurrences | Pages viewed, items added to cart, messages sent, support tickets |
| **Revenue** | Zero-inflated | Revenue per visitor, spend per session, donations per user |

Each mode returns sample size per group and total, a duration estimate from your daily traffic, a sensitivity table showing how MDE moves the cost, and metric-specific warnings and tips.

### Decide: the decision synthesizer

The half most tools ignore. Set four signals and the synthesizer names the situation and the move:

- **Health (SRM):** did the 50/50 split actually land 50/50? If not, stop.
- **Guardrails:** did a do-no-harm metric (latency, AOV, core CTR) break?
- **P-Value (frequentist):** is the result distinguishable from noise?
- **P-Move (Bayesian):** given the data and the platform's history, will it hold up in production?

Those collapse into six archetypes, each with a clear action:

| Situation | When | Action |
|-----------|------|--------|
| **The Bug** | SRM fails | Abort. Randomization is broken. |
| **The Cannibal** | Primary wins, guardrail breaks | Hold and redesign the trade-off. |
| **The Clean Win** | Significant, high P-Move, clean | Ship to 100%. |
| **False Alarm** | Significant, low P-Move | Do not ship. Likely a fluke. |
| **The Trend** | Not significant, P-Move trending | Extend the test for power. |
| **The Flatline** | Not significant, P-Move ~50% | Deprecate. Kill the debt. |

### Learn: the concepts

- **Eight core concepts**, each taught through real analogies: SD, MDE, Confidence, Power, Sample Size, and Distribution type for sizing, plus **P-Move** (Bayesian confidence) and **The Prior** (why mature products demand more proof) for reading results.
- **Six worked case studies**: checkout conversion, content engagement, push notifications, marketplace trust badges, a guardrail cannibalization trap, and a flatlined backend change.
- **Pre-launch checklist** covering the seven things teams get wrong most often.

### Configurable settings

Confidence (90/95/99%), power (70/80/90%), one vs two-sided hypothesis, number of variants, and daily traffic for duration estimates.

## Why this exists

Most sample size calculators hand you a number and nothing else. Teams plug in values they do not understand, get a result they cannot interpret, run underpowered tests, and then ship on a p-value spike that never replicates. This tool teaches the tradeoffs while you use it, on both ends of the experiment.

## Tech

Single self-contained `index.html`: React 18 via CDN, Babel standalone for in-browser JSX, no build step. Open the file and it runs.

- Statistical engine: normal-PPF approximation for z-scores, handling binary, continuous, count, and zero-inflated distributions
- Apple-inspired design system using Figtree + JetBrains Mono, inline styles with a design-token object (no CSS framework)
- Sensitivity analysis from 0.5x to 2x MDE, skew buffer (+30%) for non-normal continuous metrics, zero-inflation buffer (+40%) for revenue, overdispersion detection for counts
- Decision synthesizer: a six-archetype rule engine combining SRM, guardrails, frequentist, and Bayesian signals

`experiment-lab.jsx` is the same component as an ES module with a default export, for dropping into an existing React project.

## Run locally

Just open `index.html` in a browser. Nothing to install.

To use the component inside a React app, import the default export from `experiment-lab.jsx` (it needs React 18).

## License

MIT
