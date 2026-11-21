/* Move Map — client-side scoring + windy-style smoothed raster layer. */
(async function () {
  "use strict";

  // ------------------------------------------------------------------ data
  const DATA_V = "20261121b";  // bump when web/data changes so cached files are not mixed with new code
  const [cj, gm, gbuf, ITAX] = await Promise.all([
    fetch("data/counties.json?v=" + DATA_V).then(r => r.json()),
    fetch("data/grid.json?v=" + DATA_V).then(r => r.json()),
    fetch("data/grid.bin?v=" + DATA_V).then(r => r.arrayBuffer()),
    fetch("data/income_tax.json?v=" + DATA_V).then(r => r.json()),
  ]);
  const C = cj.cols, META = cj.meta, N = C.geoid.length;
  const GRID = new Uint16Array(gbuf), GW = gm.w, GH = gm.h;
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const MY0 = mercY(gm.lat0), MY1 = mercY(gm.lat1);

  // ------------------------------------------------------------------ formatting
  const money = v => v == null ? "–" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : "$" + Math.round(v / 1000) + "k";
  const km = v => v == null ? "–" : v < 10 ? v.toFixed(1) + " km" : Math.round(v) + " km";
  const num = d => v => v == null ? "–" : v.toFixed(d);
  const pct = v => v == null ? "–" : v.toFixed(0) + "%";

  // ------------------------------------------------------------------ params & factors
  const P = { income: 500000, spend: 35, cg: 0, housing: "own", newBuyer: true, mode: "sum", smooth: 4, opacity: 0.78, minPop: 0, stretch: true, view: "total", demo: "wa", roadW: [1, 1, 0.5], hospW: [1, 1, 1], docW: [1, 1, 0.5], dry: true };

  const DEMO = {
    wa: { label: "Non-Hispanic white + Asian", get: i => sum2(C.pct_nh_white[i], C.pct_nh_asian[i]) },
    w: { label: "Non-Hispanic white", get: i => C.pct_nh_white[i] },
    a: { label: "Non-Hispanic Asian", get: i => C.pct_nh_asian[i] },
    b: { label: "Non-Hispanic Black", get: i => C.pct_nh_black[i] },
    h: { label: "Hispanic (any race)", get: i => C.pct_hispanic[i] },
    div: { label: "Diversity index (0–100)", get: i => C.diversity[i] },
  };
  function sum2(a, b) { return a == null || b == null ? null : a + b; }

  // progressive brackets [[from, rate%], ...] -> tax on x
  const bt = (b, x) => {
    let t = 0;
    for (let k = 0; k < b.length; k++) {
      const lo = b[k][0], hi = k + 1 < b.length ? b[k + 1][0] : Infinity;
      if (x > lo) t += (Math.min(x, hi) - lo) * b[k][1] / 100;
    }
    return t;
  };
  // state + local income tax for the reference household; gains stack on top of ordinary income
  function incomeTax(i) {
    const s = ITAX.states[C.state[i]];
    if (!s) return null;
    const inc = P.income, g = inc * Math.min(100, Math.max(0, P.cg)) / 100, o = inc - g;
    const so = bt(s.b, o);
    let sg;
    if (s.cgB) sg = bt(s.cgB, g);
    else {
      const gt = g * (s.cg ?? 1);
      sg = bt(s.b, o + gt) - so;
      if (s.cgMax != null) sg = Math.min(sg, gt * s.cgMax / 100);
    }
    if (s.cgExtra) { const e = s.cgExtra; sg += e.base === "income" ? (inc > e.over ? g * e.rate / 100 : 0) : Math.max(0, g - e.over) * e.rate / 100; }
    const lc = ITAX.county[C.geoid[i]], lb = lc ? lc.b : s.local, lcg = lc ? lc.cg : s.localCG;
    let lo = 0, lg = 0;
    if (lb) { lo = bt(lb, o); if (lcg) lg = bt(lb, o + g) - lo; }
    return { ord: so + lo, cg: sg + lg };
  }
  // property tax on the local 4-bed; renters pay none directly (it is inside the rent)
  function propTax(i) {
    if (P.housing === "rent") return 0;
    const h = C.home4[i], pr = C.prop_tax_rate[i];
    if (h == null || pr == null) return null;
    let t = h * pr / 100;
    const nb = P.newBuyer && ITAX.propNewBuyer && ITAX.propNewBuyer[C.state[i]];
    if (nb) t = Math.max(t, Math.max(0, h - nb.exempt) * nb.rate / 100);
    return t;
  }
  function taxParts(i) {
    const it = incomeTax(i), prop = propTax(i);
    if (prop == null || !it) return null;
    return { inc: it.ord + it.cg, cg: it.cg, sales: P.income * P.spend / 100 * C.sales_tax[i] / 100, prop };
  }
  const taxDollars = i => { const t = taxParts(i); return t && t.inc + t.sales + t.prop; };

  // Road danger: geometric mean of three FARS measures, each relative to the median county (1.0 = typical)
  const median = arr => { const v = arr.filter(x => x != null).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const ROAD = [
    { key: "road_deaths_pc", label: "deaths/100k residents", eps: 0, fmt: v => v.toFixed(1) },
    { key: "road_vru_pc", label: "ped+cyclist deaths/100k", eps: 0, fmt: v => v.toFixed(1) },
    { key: "road_near", label: "fatal crashes/yr within 15 km", eps: 0.5, fmt: v => Math.round(v) + "" },
  ];
  ROAD.forEach(r => r.med = median(C[r.key]) + r.eps);
  const roadIndex = i => {
    let acc = 0, ws = 0;
    ROAD.forEach((r, k) => { const v = C[r.key][i], w = P.roadW[k]; if (v == null || !w) return; acc += w * Math.log((v + r.eps) / r.med); ws += w; });
    return ws ? Math.exp(acc / ws) : null;
  };

  // Hospitals: 0-100 from three sub-curves; a missing star rating counts as unknown, not bad
  const lin01 = (x, worst, best, log) => {
    if (x == null || !isFinite(x)) return NaN;
    if (log) { x = Math.log(Math.max(x, 1e-3)); worst = Math.log(worst); best = Math.log(best); }
    return Math.min(1, Math.max(0, (x - worst) / (best - worst)));
  };
  const HOSP = [
    { key: "er_km", label: "km to nearest hospital", sc: x => lin01(x, 40, 3, true), fmt: v => v == null ? "–" : v.toFixed(v < 10 ? 1 : 0) },
    { key: "best_star_40", label: "best CMS stars within 40 km", sc: x => lin01(x, 2, 5, false), fmt: v => v == null ? "none rated" : v + "★" },
    { key: "trauma_km", label: "km to Level I/II trauma", sc: x => lin01(x, 150, 10, true), fmt: v => v == null ? "–" : Math.round(v) + "" },
  ];
  const hospScore = i => {
    let acc = 0, ws = 0;
    HOSP.forEach((h, k) => { const s = h.sc(C[h.key][i]), w = P.hospW[k]; if (isNaN(s) || !w) return; acc += w * s; ws += w; });
    return ws ? 100 * acc / ws : null;
  };
  // Doctors: geometric mean of per-capita supply within 30 km, each relative to the median county
  const DOC = [
    { key: "pcp_100k", label: "primary care/100k" }, { key: "spec_100k", label: "specialists/100k" }, { key: "mh_100k", label: "mental health/100k" },
  ];
  DOC.forEach(r => r.med = median(C[r.key]));
  const docIndex = i => {
    let acc = 0, ws = 0;
    DOC.forEach((r, k) => { const v = C[r.key][i], w = P.docW[k]; if (v == null || !w) return; acc += w * Math.log(v / r.med); ws += w; });
    return ws ? Math.exp(acc / ws) : null;
  };

  // best/worst are anchor raw values: score 1 at best, 0 at worst (clamped), interpolated linearly or in log space.
  const FACTORS = [
    { id: "home", label: "4-bed home price", color: "#ff7a7a", w: 3, best: 300000, worst: 1200000, log: true,
      fmt: v => v == null ? "–" : P.housing === "rent" ? "$" + Math.round(v).toLocaleString() + "/mo" : money(v),
      get: i => P.housing === "rent" ? C.rent4[i] : C.home4[i], unit: "$",
      housingToggle: true, anchors: { own: [300000, 1200000], rent: [1500, 4500] }, labels: { own: "4-bed home price", rent: "4-bed rent (monthly)" },
      src: "Buy: Zillow ZHVI, 4-bedroom, county, latest month; counties without a Zillow series use ACS median home value × national ratio. Rent: HUD Fair Market Rent FY2026, 4 bedrooms, for the HUD rent area (metro or county) containing the county's population center. It is the 40th-percentile gross rent (rent + utilities) paid by recent movers, so a nicer house will cost more; whole metros share one value.",
      flag: i => P.housing === "own" && C.home4_imputed[i] ? "imputed from ACS" : "" },
    { id: "tax", label: "Annual tax burden", color: "#ffb35c", w: 2, best: 15000, worst: 65000, log: false, fmt: money,
      get: taxDollars, unit: "$/yr",
      sub: i => { const t = taxParts(i); return t ? `income ${money(t.inc)}${P.cg > 0 ? ` (on gains ${money(t.cg)})` : ""} · sales ${money(t.sales)} · property ${P.housing === "rent" ? "in rent" : money(t.prop)}` : ""; },
      src: "Reference household: state + local income tax from 2025 married-filing-jointly brackets (capital-gains share taxed per state rules: WA's 7%/9.9% gains tax, exclusions in AR/AZ/ND/SC/VT/WI, MO exempt, HI/MT caps, MD surtax), plus combined sales tax on taxable spending, plus property tax: the county effective rate (ACS median taxes ÷ median value) × the local 4-bed price, raised to a new-buyer rate in CA (≈1.15%) and FL (≈1.75% above the $50k homestead exemption) when “new-buyer property tax” is on. Renters pay no property tax directly. Federal tax is the same everywhere and is left out. Deductions are ignored. Rates live in pipeline/ref/.",
      warn: "Other states with caps that reset on sale (e.g. Michigan) still use the county median rate, which understates a new buyer's bill." },
    { id: "costco", label: "Distance to Costco", color: "#e8e05a", w: 1, best: 5, worst: 80, log: true, fmt: km,
      get: i => C.costco_km[i], src: "OpenStreetMap shop=wholesale with Costco brand tag (" + META.n_costco + " warehouses). Distance from county population center." },
    { id: "uniqlo", label: "Distance to Uniqlo", color: "#b48cff", w: 0.5, best: 15, worst: 500, log: true, fmt: km,
      get: i => C.uniqlo_km[i], src: "OpenStreetMap + Overture Maps Uniqlo stores (" + META.n_uniqlo + " found).",
      warn: "Merged OSM + Overture Places; a few newer stores (e.g. Texas) may be missing. A coarse big-metro proxy." },
    { id: "pleasant", label: "Pleasant days (15–28°C)", color: "#5ad19a", w: 2, best: 160, worst: 100, log: false, fmt: v => v == null ? "–" : Math.round(v) + " d/yr",
      get: i => P.dry ? C.pleasant_dry[i] : C.pleasant[i], dryToggle: true,
      anchors: { dry: [160, 100], all: [200, 125] },
      src: "NOAA 1991–2020 daily normals (" + META.n_stations + " stations). Expected days/yr with a daily high of 15–28°C, from each day's normal and std-dev. With “dry days only”, each day is also weighted by the chance it stays under 2.5 mm of rain (assumes temperature and rain are independent). IDW from the 4 nearest stations." },
    { id: "rainy", label: "Rainy days (≥2.5 mm)", color: "#6f9bff", w: 0.5, best: 30, worst: 110, log: false, fmt: v => v == null ? "–" : Math.round(v) + " d/yr",
      get: i => C.rainy[i],
      src: "NOAA 1991–2020 daily precipitation normals: expected days/yr with at least 0.10\" (2.5 mm) of rain or melted snow, summed from each calendar day's probability; IDW from the 4 nearest of ~8,900 stations.",
      warn: "With “dry days only” on, rain already lowers Pleasant days, so this weight adds a penalty for rain in every season (the winter drizzle in the Pacific Northwest, say)." },
    { id: "hot", label: "Hot days (>32°C)", color: "#ff5c8a", w: 0, best: 0, worst: 100, log: false, fmt: v => v == null ? "–" : Math.round(v) + " d/yr",
      get: i => C.hot[i], src: "Same NOAA normals: expected days/yr with daily high above 32°C." },
    { id: "frost", label: "Frost nights (<0°C)", color: "#7ad7ff", w: 0, best: 0, worst: 160, log: false, fmt: v => v == null ? "–" : Math.round(v) + " d/yr",
      get: i => C.frost[i], src: "Same NOAA normals: expected nights/yr with low below 0°C." },
    { id: "hiking", label: "Trails & parks within 40 km", color: "#8fd14f", w: 1, best: 100, worst: 2, log: true, fmt: v => v == null ? "–" : Math.round(v) + "",
      get: i => C.hiking_50km[i] == null ? null : C.hiking_50km[i] + 1, show: i => C.hiking_50km[i],
      src: "Count of Overture Maps places tagged hiking trail, mountain-bike trail, national/state park, nature reserve or forest (" + META.n_hiking + " in the lower 48) within 40 km of the population center.",
      warn: "A POI count, not trail kilometres: it rewards places with many named trails and parks. USGS National Digital Trails (13 GB) would be the precise upgrade." },
    { id: "relief", label: "Hills & mountains nearby", color: "#b08a5a", w: 1, best: 800, worst: 40, log: true, fmt: v => v == null ? "–" : Math.round(v) + " m",
      get: i => C.relief_m[i], sub: i => `highest point ${Math.round(C.max_elev_m[i])} m · home ${Math.round(C.elev_m[i])} m (within 40 km)`,
      src: "Terrain relief within 40 km of the population center: 97th minus 3rd percentile of land elevation (NOAA ETOPO1, 1 arc-minute ≈ 1.8 km). Lakes and the sea floor are masked out. Flat Florida ≈ 10 m, Chicago ≈ 70 m, Asheville and Denver ≈ 950 m.",
      warn: "At ~1.8 km resolution, small sharp hills (bluffs, river valleys) are understated; it captures real ridges and mountains well." },
    { id: "water", label: "Distance to sea / big lake", color: "#4aa8ff", w: 1, best: 3, worst: 150, log: true, fmt: km,
      get: i => C.water_km[i], src: "Natural Earth 1:10m ocean coastline + large lakes (incl. Great Lakes). Rivers and small lakes are not included." },
    { id: "road", label: "Road danger", color: "#ff4d4d", w: 1.5, best: 0.6, worst: 3, log: true,
      fmt: v => v == null ? "–" : v.toFixed(1) + "× typ.", get: roadIndex, subs: ROAD, subW: "roadW",
      sub: i => ROAD.map(r => `${r.fmt(C[r.key][i])} ${r.label}`).join(" · "),
      src: "NHTSA FARS " + (META.fars_years || 5) + " years (2020–2024), every fatal crash (" + (META.n_fars || 0).toLocaleString() + "), placed in counties by coordinates. Index = weighted geometric mean of the three measures, each divided by the median county; 1.0× = typical, 2× = twice as deadly. Per-resident rates are shrunk toward the national rate (100k person-year prior) so tiny counties aren't all-or-nothing.",
      warn: "“Crashes within 15 km” grows with density (Manhattan scores high on it while having a very low per-resident rate), so it gets half weight by default. Fatal crashes only; injury crashes have no national dataset." },
    { id: "hosp", label: "Hospitals", color: "#ff8fd0", w: 1.5, best: 90, worst: 30, log: false,
      fmt: v => v == null ? "–" : Math.round(v) + "/100", get: hospScore, subs: HOSP, subW: "hospW",
      sub: i => HOSP.map(h => `${h.fmt(C[h.key][i])} ${h.label}`).join(" · "),
      src: "Sub-scores (0–1): nearest acute/critical-access hospital (3 km → 1, 40 km → 0, log); best CMS overall star rating within 40 km (5★ → 1, 2★ → 0); nearest adult Level I/II trauma center (10 km → 1, 150 km → 0, log). CMS Hospital General Information (" + (META.n_hosp || 0).toLocaleString() + " hospitals, " + (META.n_rated || 0).toLocaleString() + " rated, Oct 2026), geocoded with the Census geocoder; trauma levels from HIFLD (" + (META.n_trauma || 0) + " Level I/II).",
      warn: "About 40% of hospitals have no CMS star rating (mostly small and rural); where none within 40 km is rated, that part is skipped rather than scored as bad. Trauma levels are from 2019." },
    { id: "docs", label: "Doctors nearby", color: "#c58bff", w: 1, best: 2, worst: 0.4, log: true,
      fmt: v => v == null ? "–" : v.toFixed(1) + "× typ.", get: docIndex, subs: DOC, subW: "docW",
      sub: i => DOC.map(r => `${Math.round(C[r.key][i])} ${r.label}`).join(" · "),
      src: "CMS Doctors & Clinicians national file (Oct 2026): Medicare-enrolled physicians and mental-health clinicians by practice ZIP, counted within 30 km of the population center per 100k residents in that radius. Index = weighted geometric mean of the three rates vs the median county.",
      warn: "Medicare-enrolled clinicians only (most physicians are, but some concierge and pediatric practices aren't). Measures supply, not wait times or whether practices take new patients." },
    { id: "bikewalk", label: "Bike/walk commuting", color: "#3ee0c8", w: 0.5, best: 10, worst: 1, log: true, fmt: v => v == null ? "–" : v.toFixed(1) + "%",
      get: i => C.bikewalk_pct[i],
      src: "ACS 2019–2023 5-year, table B08301: share of commuters who bike or walk to work (work-from-home excluded from the base).",
      warn: "College towns and dense cores score high; it shows what people do, not whether the bike infrastructure is safe." },
    { id: "income", label: "Median household income", color: "#f2a65a", w: 1, best: 120000, worst: 45000, log: false, fmt: money,
      get: i => C.income[i], src: "ACS 2019–2023 5-year, table B19013. Direct affluence measure." },
    { id: "demo", label: "Demographics", color: "#c9c9c9", w: 0, best: 85, worst: 30, log: false, fmt: pct,
      get: i => DEMO[P.demo].get(i), src: "ACS 2019–2023 5-year, table B03002 (residents). Off by default; pick a group below.", demo: true },
  ];
  FACTORS.forEach(f => { f.dealbreaker = false; f.default = { w: f.w, best: f.best, worst: f.worst, log: f.log }; });

  // restore from URL hash
  loadHash();
  { const f = FACTORS.find(x => x.housingToggle); f.label = f.labels[P.housing] || f.labels.own; }

  // ------------------------------------------------------------------ scoring
  const raw = {}, score = {};
  FACTORS.forEach(f => { raw[f.id] = new Float32Array(N); score[f.id] = new Float32Array(N); });
  const total = new Float32Array(N), excluded = new Uint8Array(N);

  function curve(f, x) {
    if (x == null || !isFinite(x)) return NaN;
    let a = f.worst, b = f.best, v = x;
    if (f.log) { a = Math.log(Math.max(a, 1e-3)); b = Math.log(Math.max(b, 1e-3)); v = Math.log(Math.max(v, 1e-3)); }
    if (a === b) return v === a ? 1 : 0;
    return Math.min(1, Math.max(0, (v - a) / (b - a)));
  }

  function compute() {
    const act = FACTORS.filter(f => f.w > 0);
    const W = act.reduce((s, f) => s + f.w, 0);
    for (const f of FACTORS) {
      const r = raw[f.id], s = score[f.id];
      for (let i = 0; i < N; i++) { const x = f.get(i); r[i] = x == null ? NaN : x; s[i] = curve(f, r[i]); }
    }
    for (let i = 0; i < N; i++) {
      let ex = (C.pop[i] || 0) < P.minPop;
      let acc = P.mode === "sum" ? 0 : 0, wsum = 0;
      for (const f of act) {
        let s = score[f.id][i];
        if (isNaN(s)) continue;            // missing data: renormalise over available factors
        if (f.dealbreaker && s <= 0) ex = true;
        if (P.mode === "sum") acc += f.w * s; else acc += f.w * Math.log(Math.max(s, 0.02));
        wsum += f.w;
      }
      for (const f of FACTORS) if (f.w === 0 && f.dealbreaker && score[f.id][i] <= 0) ex = true;
      excluded[i] = ex ? 1 : 0;
      total[i] = wsum === 0 ? NaN : 100 * (P.mode === "sum" ? acc / wsum : Math.exp(acc / wsum));
    }
    return W;
  }

  // ------------------------------------------------------------------ raster
  const canvas = document.createElement("canvas");
  canvas.width = GW; canvas.height = GH;
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(GW, GH);
  const vals = new Float32Array(GW * GH), wts = new Float32Array(GW * GH);
  const tmpV = new Float32Array(GW * GH), tmpW = new Float32Array(GW * GH);

  // viridis-like ramp: works on dark basemap, colour-blind safe, high = good
  const STOPS = [[0, [68, 1, 84]], [0.2, [65, 68, 135]], [0.4, [42, 120, 142]], [0.6, [34, 168, 132]], [0.8, [122, 209, 81]], [1, [253, 231, 37]]];
  const LUT = new Uint8Array(256 * 3);
  for (let k = 0; k < 256; k++) {
    const t = k / 255; let j = 0; while (j < STOPS.length - 2 && t > STOPS[j + 1][0]) j++;
    const [t0, c0] = STOPS[j], [t1, c1] = STOPS[j + 1], u = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c++) LUT[k * 3 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * u);
  }
  const rampCss = "linear-gradient(90deg," + STOPS.map(([t, c]) => `rgb(${c}) ${t * 100}%`).join(",") + ")";

  function boxBlur(src, dst, r, horiz) {
    const n = horiz ? GW : GH, m = horiz ? GH : GW, st = horiz ? 1 : GW, lst = horiz ? GW : 1;
    for (let l = 0; l < m; l++) {
      const base = l * lst; let acc = 0;
      for (let k = -r; k <= r; k++) { const q = Math.min(n - 1, Math.max(0, k)); acc += src[base + q * st]; }
      for (let p = 0; p < n; p++) {
        dst[base + p * st] = acc;
        const add = Math.min(n - 1, p + r + 1), rem = Math.max(0, p - r);
        acc += src[base + add * st] - src[base + rem * st];
      }
    }
  }

  let currentField = null, domain = [0, 100];

  function viewField() {
    if (P.view === "total") return { arr: total, scale: 1, label: "Goodness score" };
    const f = FACTORS.find(x => x.id === P.view);
    return { arr: score[f.id], scale: 100, label: f.label + " — factor score" };
  }

  function quantile(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]; }

  function render() {
    const vf = viewField(); currentField = vf;
    const a = vf.arr, sc = vf.scale;
    const live = [];
    for (let i = 0; i < N; i++) if (!excluded[i] && isFinite(a[i])) live.push(a[i] * sc);
    live.sort((x, y) => x - y);
    domain = P.stretch && live.length > 10 ? [quantile(live, 0.02), quantile(live, 0.98)] : [0, 100];
    if (domain[1] - domain[0] < 1) domain = [Math.max(0, domain[0] - 1), domain[0] + 1];
    const d0 = domain[0], dr = domain[1] - domain[0];

    for (let p = 0; p < GW * GH; p++) {
      const g = GRID[p];
      if (g === 0) { vals[p] = 0; wts[p] = 0; continue; }
      const i = g - 1, v = a[i];
      if (excluded[i] || !isFinite(v)) { vals[p] = 0; wts[p] = 0; continue; }
      vals[p] = v * sc; wts[p] = 1;
    }
    const r = P.smooth;
    if (r > 0) {  // normalised convolution: 2 box passes ≈ gaussian, missing cells don't bleed zeros in
      for (let pass = 0; pass < 2; pass++) {
        boxBlur(vals, tmpV, r, true); boxBlur(tmpV, vals, r, false);
        boxBlur(wts, tmpW, r, true); boxBlur(tmpW, wts, r, false);
        if (pass === 0) for (let p = 0; p < GW * GH; p++) if (wts[p] > 0) { vals[p] /= wts[p]; wts[p] = 1; } else vals[p] = 0;
      }
    }
    const D = imgData.data;
    for (let p = 0; p < GW * GH; p++) {
      const o = p * 4, g = GRID[p];
      if (g === 0) { D[o + 3] = 0; continue; }
      const i = g - 1;
      if (excluded[i] || !isFinite(a[i])) {  // excluded / no data: dark hatch-grey
        D[o] = 40; D[o + 1] = 42; D[o + 2] = 48; D[o + 3] = 170; continue;
      }
      const v = r > 0 ? (wts[p] > 0 ? vals[p] / wts[p] : a[i] * sc) : vals[p];
      const k = Math.max(0, Math.min(255, Math.round((v - d0) / dr * 255))) * 3;
      D[o] = LUT[k]; D[o + 1] = LUT[k + 1]; D[o + 2] = LUT[k + 2]; D[o + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    const src = map.getSource("score");
    if (src) { src.play(); requestAnimationFrame(() => requestAnimationFrame(() => src.pause())); }
    drawLegend(vf);
  }

  function drawLegend(vf) {
    document.getElementById("legend-title").textContent = vf.label + (P.stretch ? " (stretched)" : "");
    document.getElementById("legend-bar").style.background = rampCss;
    const t = document.getElementById("legend-ticks"); t.innerHTML = "";
    for (let k = 0; k <= 4; k++) { const s = document.createElement("span"); s.textContent = Math.round(domain[0] + (domain[1] - domain[0]) * k / 4); t.appendChild(s); }
  }

  // ------------------------------------------------------------------ map
  const map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [-96, 38.5], zoom: 3.7, minZoom: 2.5, maxZoom: 11, attributionControl: { compact: true },
    customAttribution: "Zillow · US Census ACS · NOAA · © OpenStreetMap · Natural Earth",
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  let hoverGeoid = null;
  map.on("load", () => {
    const firstSymbol = map.getStyle().layers.find(l => l.type === "symbol");
    map.addSource("score", { type: "canvas", canvas, animate: false,
      coordinates: [[gm.lon0, gm.lat1], [gm.lon1, gm.lat1], [gm.lon1, gm.lat0], [gm.lon0, gm.lat0]] });
    map.addLayer({ id: "score", type: "raster", source: "score", paint: { "raster-opacity": P.opacity, "raster-resampling": "linear", "raster-fade-duration": 0 } }, firstSymbol && firstSymbol.id);
    map.addSource("counties", { type: "geojson", data: "data/counties.geojson" });
    map.addLayer({ id: "county-hl", type: "line", source: "counties", filter: ["==", ["get", "geoid"], ""],
      paint: { "line-color": "#ffffff", "line-width": 2 } }, firstSymbol && firstSymbol.id);
    // put boundary lines above the heat layer (windy-style)
    for (const l of map.getStyle().layers) if (l.type === "line" && /boundary|admin/i.test(l.id)) map.moveLayer(l.id, firstSymbol && firstSymbol.id);
    recompute();
    document.getElementById("loading").remove();
  });

  function countyAt(lngLat) {
    const x = Math.floor((lngLat.lng - gm.lon0) / (gm.lon1 - gm.lon0) * GW);
    const y = Math.floor((MY1 - mercY(lngLat.lat)) / (MY1 - MY0) * GH);
    if (x < 0 || y < 0 || x >= GW || y >= GH) return -1;
    return GRID[y * GW + x] - 1;
  }

  const hover = document.getElementById("hover");
  let pinned = false;
  map.on("mousemove", e => { if (!pinned) showHover(countyAt(e.lngLat), e.point); });
  map.on("mouseout", () => { if (!pinned) hideHover(); });
  map.on("click", e => { const i = countyAt(e.lngLat); if (i < 0) { pinned = false; hideHover(); return; } pinned = true; showHover(i, e.point); });

  function hideHover() { hover.hidden = true; setHL(null); }
  function setHL(g) { if (g === hoverGeoid) return; hoverGeoid = g; if (map.getLayer("county-hl")) map.setFilter("county-hl", ["==", ["get", "geoid"], g || ""]); }

  function showHover(i, pt) {
    if (i < 0) { hideHover(); return; }
    setHL(C.geoid[i]);
    hover.innerHTML = breakdownHTML(i);
    hover.hidden = false;
    const mw = map.getContainer().clientWidth, mh = map.getContainer().clientHeight;
    const w = hover.offsetWidth, h = hover.offsetHeight;
    let x = pt.x + 16, y = pt.y + 16;
    if (x + w > mw - 8) x = pt.x - w - 16;
    if (y + h > mh - 8) y = Math.max(8, mh - h - 8);
    hover.style.left = x + "px"; hover.style.top = y + "px";
  }

  function breakdownHTML(i) {
    const act = FACTORS.filter(f => f.w > 0 && isFinite(score[f.id][i]));
    const W = act.reduce((s, f) => s + f.w, 0);
    const t = total[i];
    let stack = "", rows = "";
    for (const f of FACTORS) {
      const s = score[f.id][i], on = f.w > 0;
      const pts = on && isFinite(s) && P.mode === "sum" ? 100 * f.w * s / W : null;
      if (pts != null) stack += `<i style="width:${pts}%;background:${f.color}"></i>`;
      const shown = f.show ? f.show(i) : raw[f.id][i];
      const val = f.fmt(isFinite(shown) ? shown : null);
      const flag = f.flag ? f.flag(i) : "";
      const dead = f.dealbreaker && s <= 0;
      rows += `<tr class="${on ? "" : "dim"}"><td><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${f.color};margin-right:6px"></span>${f.label}${dead ? ' <span class="x">✕</span>' : ""}</td>
        <td class="v" title="${flag}">${val}${flag ? "*" : ""}</td>
        <td class="bar"><div class="sbar"><i style="width:${isFinite(s) ? s * 100 : 0}%;background:${f.color}"></i></div></td>
        <td class="pts">${pts != null ? "+" + pts.toFixed(1) : on ? "" : "off"}</td></tr>`;
      if (f.sub && on) rows += `<tr class="dim"><td colspan="4" style="padding:0 0 3px 14px;font-size:11px">${f.sub(i)}</td></tr>`;
    }
    const rank = rankOf(i);
    return `<h3>${C.name[i]}, ${C.state[i]}</h3>
      <div class="sub">pop ${(C.pop[i] || 0).toLocaleString()} · rank ${rank ? rank.toLocaleString() : "–"} of ${liveCount.toLocaleString()}${excluded[i] ? ' · <span class="x">excluded</span>' : ""}</div>
      <div class="big">${isFinite(t) ? t.toFixed(1) : "–"}<small> / 100</small></div>
      ${P.mode === "sum" ? `<div class="stack">${stack}</div>` : '<div class="sub">geometric mode: score = 100 × Π sᵢ^(wᵢ/Σw)</div>'}
      <table><tr class="dim"><td>factor</td><td class="v">value</td><td>score</td><td class="pts">pts</td></tr>${rows}</table>`;
  }

  // ------------------------------------------------------------------ ranking
  let order = [], rankIdx = new Int32Array(N), liveCount = 0;
  function rerank() {
    order = [];
    for (let i = 0; i < N; i++) if (!excluded[i] && isFinite(total[i])) order.push(i);
    order.sort((a, b) => total[b] - total[a]);
    liveCount = order.length; rankIdx.fill(0);
    order.forEach((i, k) => rankIdx[i] = k + 1);
    const ol = document.getElementById("top"); ol.innerHTML = "";
    for (const i of order.slice(0, 15)) {
      const li = document.createElement("li");
      li.innerHTML = `${C.name[i]}, ${C.state[i]}<span>${total[i].toFixed(1)}</span>`;
      li.onclick = () => { map.flyTo({ center: [C.lon[i], C.lat[i]], zoom: 7.5 }); pinned = true; setTimeout(() => showHover(i, map.project([C.lon[i], C.lat[i]])), 1200); };
      ol.appendChild(li);
    }
    document.getElementById("top-sub").textContent = `${liveCount.toLocaleString()} counties scored`;
  }
  const rankOf = i => rankIdx[i];

  // ------------------------------------------------------------------ UI
  function formulaText() {
    const act = FACTORS.filter(f => f.w > 0);
    const W = act.reduce((s, f) => s + f.w, 0);
    const terms = act.map(f => `<span style="color:${f.color}">${(f.w / W * 100).toFixed(0)}%·s<sub>${f.id}</sub></span>`).join(" + ");
    const head = P.mode === "sum" ? "Score = 100 × Σ wᵢ·sᵢ / Σ wᵢ" : "Score = 100 × Π sᵢ^(wᵢ/Σwᵢ)";
    return `${head}<br>sᵢ = clamp((f(x) − f(worst)) / (f(best) − f(worst)), 0, 1), f = x or ln x<br><br>${terms || "<i>all weights are 0</i>"}`;
  }

  const fBox = document.getElementById("factors");
  function buildFactors() {
    fBox.innerHTML = "";
    for (const f of FACTORS) {
      const el = document.createElement("div");
      el.className = "factor" + (f.w > 0 ? "" : " off") + (P.view === f.id ? " viewing" : "");
      el.innerHTML = `
        <div class="row">
          <span class="dot" style="background:${f.color}"></span>
          <span class="name" title="${f.label}">${f.label}</span>
          <input class="w" type="range" min="0" max="5" step="0.5" value="${f.w}" aria-label="${f.label} weight">
          <span class="wv">${f.w}</span>
          <button class="eye" title="Show this factor on the map">◉</button>
        </div>
        <div class="detail">
          <div class="grid2">
            ${f.demo ? `<label>Group</label><select class="demo">${Object.entries(DEMO).map(([k, d]) => `<option value="${k}" ${k === P.demo ? "selected" : ""}>${d.label}</option>`).join("")}</select>` : ""}
            ${f.housingToggle ? `<label>Housing</label><select class="housing"><option value="own" ${P.housing === "own" ? "selected" : ""}>Buy</option><option value="rent" ${P.housing === "rent" ? "selected" : ""}>Rent</option></select>` : ""}
            ${f.dryToggle ? `<label>Dry days only</label><input class="dry" type="checkbox" ${P.dry ? "checked" : ""}>` : ""}
            ${f.subs ? f.subs.map((r, k) => `<label>Weight: ${r.label}</label><input class="rw" data-k="${k}" type="number" min="0" step="0.5" value="${P[f.subW][k]}">`).join("") : ""}
            <label>Best (score 1)</label><input class="best" type="number" value="${f.best}">
            <label>Worst (score 0)</label><input class="worst" type="number" value="${f.worst}">
            <label>Scale</label><select class="scale"><option value="lin" ${f.log ? "" : "selected"}>linear</option><option value="log" ${f.log ? "selected" : ""}>logarithmic</option></select>
          </div>
          <label class="chk"><input class="deal" type="checkbox" ${f.dealbreaker ? "checked" : ""}> Dealbreaker: hide areas at or past “worst”</label>
          <div class="curve"></div>
          <div class="src">${f.src}${f.warn ? `<br><span class="warn">⚠ ${f.warn}</span>` : ""}</div>
        </div>`;
      const q = s => el.querySelector(s);
      q(".name").onclick = () => el.classList.toggle("open");
      q(".w").oninput = e => { f.w = +e.target.value; q(".wv").textContent = f.w; el.classList.toggle("off", f.w === 0); schedule(); };
      q(".eye").onclick = () => setView(P.view === f.id ? "total" : f.id);
      q(".best").onchange = e => { f.best = +e.target.value; schedule(); drawCurve(f, q(".curve")); };
      q(".worst").onchange = e => { f.worst = +e.target.value; schedule(); drawCurve(f, q(".curve")); };
      q(".scale").onchange = e => { f.log = e.target.value === "log"; schedule(); drawCurve(f, q(".curve")); };
      q(".deal").onchange = e => { f.dealbreaker = e.target.checked; schedule(); };
      if (f.dryToggle) q(".dry").onchange = e => {
        const was = P.dry ? f.anchors.dry : f.anchors.all;
        P.dry = e.target.checked;
        // swap anchors to the new mode's defaults unless the user already moved them
        if (f.best === was[0] && f.worst === was[1]) [f.best, f.worst] = P.dry ? f.anchors.dry : f.anchors.all;
        q(".best").value = f.best; q(".worst").value = f.worst;
        schedule(); drawCurve(f, q(".curve"));
      };
      if (f.housingToggle) q(".housing").onchange = e => setHousing(e.target.value);
      if (f.subs) el.querySelectorAll(".rw").forEach(inp => inp.onchange = e => { P[f.subW][+inp.dataset.k] = Math.max(0, +e.target.value || 0); schedule(); drawCurve(f, q(".curve")); });
      if (f.demo) q(".demo").onchange = e => { P.demo = e.target.value; schedule(); drawCurve(f, q(".curve")); };
      drawCurve(f, q(".curve"));
      fBox.appendChild(el);
    }
  }

  // tiny histogram of the factor's raw values with the scoring curve on top
  function drawCurve(f, host) {
    const vals = [];
    for (let i = 0; i < N; i++) { const x = f.get(i); if (x != null && isFinite(x)) vals.push(x); }
    if (!vals.length) { host.innerHTML = ""; return; }
    vals.sort((a, b) => a - b);
    let lo = quantile(vals, 0.01), hi = quantile(vals, 0.99);
    lo = Math.min(lo, f.best, f.worst); hi = Math.max(hi, f.best, f.worst);
    const T = f.log ? x => Math.log(Math.max(x, 1e-3)) : x => x;
    const tl = T(lo), th = T(hi), B = 40, bins = new Array(B).fill(0);
    for (const v of vals) { const b = Math.floor((T(v) - tl) / (th - tl) * B); if (b >= 0 && b < B) bins[b]++; }
    const mx = Math.max(...bins), Wd = 300, Hd = 54;
    let svg = `<svg viewBox="0 0 ${Wd} ${Hd + 14}" width="100%" style="display:block">`;
    bins.forEach((c, b) => { const h = c / mx * (Hd - 6); svg += `<rect x="${b * Wd / B + .5}" y="${Hd - h}" width="${Wd / B - 1}" height="${h}" fill="rgba(255,255,255,.18)"/>`; });
    let path = "";
    for (let k = 0; k <= 100; k++) { const tx = tl + (th - tl) * k / 100; const x = f.log ? Math.exp(tx) : tx; path += (k ? "L" : "M") + (k * Wd / 100).toFixed(1) + "," + (Hd - curve(f, x) * (Hd - 6)).toFixed(1); }
    svg += `<path d="${path}" fill="none" stroke="${f.color}" stroke-width="2"/>`;
    svg += `<text x="0" y="${Hd + 12}" fill="#8d96a3" font-size="10">${f.fmt(lo)}</text><text x="${Wd}" y="${Hd + 12}" fill="#8d96a3" font-size="10" text-anchor="end">${f.fmt(hi)}</text>`;
    svg += `<text x="${Wd / 2}" y="${Hd + 12}" fill="#8d96a3" font-size="10" text-anchor="middle">counties (bars) · score curve (line)</text></svg>`;
    host.innerHTML = svg;
  }

  function buildLayerbar() {
    const bar = document.getElementById("layerbar"); bar.innerHTML = "";
    const mk = (id, label, color) => {
      const b = document.createElement("button");
      b.className = P.view === id ? "on" : "";
      b.innerHTML = (color ? `<span class="d" style="background:${color}"></span>` : "") + label;
      b.onclick = () => setView(id);
      bar.appendChild(b);
    };
    mk("total", "Total score");
    for (const f of FACTORS) if (f.w > 0 || P.view === f.id) mk(f.id, f.label.replace(/ \(.*\)/, ""), f.color);
  }

  // Buy/Rent switches the housing factor's data, label and (default) anchors, and drops property tax
  function setHousing(v) {
    const f = FACTORS.find(x => x.housingToggle), was = f.anchors[P.housing];
    P.housing = v;
    if (f.best === was[0] && f.worst === was[1]) [f.best, f.worst] = f.anchors[v];
    f.label = f.labels[v];
    document.getElementById("p-housing").value = v;
    const open = [...document.querySelectorAll(".factor")].map(el => el.classList.contains("open"));
    buildFactors();
    document.querySelectorAll(".factor").forEach((el, k) => el.classList.toggle("open", open[k]));
    schedule();
  }
  function setView(v) { P.view = v; buildLayerbar(); document.querySelectorAll(".factor").forEach((el, k) => el.classList.toggle("viewing", FACTORS[k].id === v)); render(); saveHash(); }

  const bind = (id, key, ev, conv, fn) => { const el = document.getElementById(id); el.value = P[key]; el.addEventListener(ev, () => { P[key] = conv(el.value); fn(); }); };
  bind("p-income", "income", "change", Number, schedule);
  bind("p-spend", "spend", "change", Number, schedule);
  bind("p-cg", "cg", "change", Number, schedule);
  { const h = document.getElementById("p-housing"); h.value = P.housing; h.onchange = () => setHousing(h.value); }
  { const nb = document.getElementById("p-newbuyer"); nb.checked = P.newBuyer; nb.onchange = () => { P.newBuyer = nb.checked; schedule(); }; }
  bind("p-smooth", "smooth", "input", Number, () => requestAnimationFrame(render));
  bind("p-opacity", "opacity", "input", Number, () => map.setPaintProperty("score", "raster-opacity", P.opacity));
  bind("p-minpop", "minPop", "change", Number, schedule);
  const st = document.getElementById("p-stretch"); st.checked = P.stretch; st.onchange = () => { P.stretch = st.checked; render(); };
  document.querySelectorAll('input[name=mode]').forEach(r => { r.checked = r.value === P.mode; r.onchange = () => { P.mode = r.value; schedule(); }; });
  document.getElementById("collapse").onclick = () => document.getElementById("panel").classList.toggle("collapsed");

  let pending = false;
  function schedule() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; recompute(); }); }
  function recompute() {
    compute(); rerank(); render(); buildLayerbar();
    document.getElementById("formula-text").innerHTML = formulaText();
    saveHash();
  }

  // ------------------------------------------------------------------ permalink state
  function saveHash() {
    const s = { P: { income: P.income, spend: P.spend, cg: P.cg, housing: P.housing, newBuyer: P.newBuyer, mode: P.mode, smooth: P.smooth, minPop: P.minPop, view: P.view, demo: P.demo, roadW: P.roadW, hospW: P.hospW, docW: P.docW, dry: P.dry },
      F: Object.fromEntries(FACTORS.map(f => [f.id, [f.w, f.best, f.worst, f.log ? 1 : 0, f.dealbreaker ? 1 : 0]])) };
    history.replaceState(null, "", "#" + encodeURIComponent(JSON.stringify(s)));
  }
  function loadHash() {
    try {
      if (!location.hash) return;
      const s = JSON.parse(decodeURIComponent(location.hash.slice(1)));
      Object.assign(P, s.P || {});
      for (const f of FACTORS) { const v = s.F && s.F[f.id]; if (v) [f.w, f.best, f.worst, f.log, f.dealbreaker] = [v[0], v[1], v[2], !!v[3], !!v[4]]; }
    } catch (e) { /* ignore bad hash */ }
  }

  document.getElementById("notes").innerHTML = `
    <p><b>Unit:</b> ${N.toLocaleString()} counties (lower 48 + DC). Point-based factors are measured from each county's 2020 population center, so large western counties are approximated by where people live.</p>
    <p><b>Data:</b> Zillow ZHVI 4BR (${META.zillow_month}), ACS 2019–23 5-yr, NOAA 1991–2020 normals, OpenStreetMap, Natural Earth, Tax Foundation-style state rates (approx., editable in <code>pipeline/ref/</code>).</p>
    <p>Settings are saved in the URL, so you can bookmark a weighting.</p>`;

  buildFactors();
  buildLayerbar();
})();
