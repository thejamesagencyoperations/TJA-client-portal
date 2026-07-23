# Monthly Services — Burn Speedometer

This is the exact spec for the retainer / monthly-services **burn speedometer** as built in
the TJA Client Portal (Executive Summary → Retainer Burn tile). Copy/paste the standalone
example at the bottom to reproduce it 1:1.

---

## What it is

A 240°-sweep gauge (from −120° to +120°) that shows **% of monthly retainer hours used**.

- The filled arc uses the **official TJA gradient** (yellow-orange → deep orange).
- A needle + hub point to the current %.
- Tick marks every 10% (major ticks at 0/50/100).
- The big readout below shows the **%** (TJA orange) and `X of Y hrs used`.
- Admin can **drag the needle** or **edit the %** to set burn; used-hours are derived
  from `% × contracted hours`.

## Key numbers (do not change — these keep the dial un-clipped & centered)

| Property | Value |
|---|---|
| viewBox | `0 25 260 180` |
| centre (cx, cy) | `130, 140` |
| radius (r) | `100` |
| sweep | start `-120°` → end `+120°` (240° total) |
| arc stroke width | `14`, round caps |
| track colour | `rgba(130,130,140,.22)` |
| fill gradient (`#gz2`, left→right) | `#EFAE41` (0) → `#EC9C39` (0.55) → `#DA662A` (1) |
| needle + hub | `#F68E21` (TJA orange) |
| major tick | `#9a9a9f`, width `2.2` · minor tick `#48484e`, width `1.4` |
| big % readout colour | TJA accent orange (`#F68E21`, darkened to `#b5610b` on light bg) |

> Note on the viewBox: the arc's bottom ends sit at y≈190 (+7px stroke). The viewBox is
> shifted to `0 25 260 180` (shows y 25→205) so the bottom corners are **not clipped**.

---

## Generator (the exact code used in the portal)

```js
function polar(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
function arc(cx, cy, r, s, e) {
  const a = polar(cx, cy, r, e), b = polar(cx, cy, r, s);
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${e - s <= 180 ? 0 : 1} 0 ${b.x} ${b.y}`;
}

// pct = 0..100
function gauge(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const cx = 130, cy = 140, r = 100, S = -120, E = 120, SWEEP = E - S;
  const nd = S + (p / 100) * SWEEP;                 // needle angle
  const tip = polar(cx, cy, r - 20, nd);
  const back = polar(cx, cy, 14, nd + 180);
  let ticks = "";
  for (let i = 0; i <= 10; i++) {
    const d = S + (i / 10) * SWEEP;
    const o = polar(cx, cy, r, d);
    const inn = polar(cx, cy, r - (i % 5 === 0 ? 15 : 9), d);
    ticks += `<line x1="${o.x}" y1="${o.y}" x2="${inn.x}" y2="${inn.y}"
      stroke="${i % 5 === 0 ? "#9a9a9f" : "#48484e"}" stroke-width="${i % 5 === 0 ? 2.2 : 1.4}"/>`;
  }
  return `<svg viewBox="0 25 260 180" width="100%" style="max-width:240px">
    <defs>
      <linearGradient id="gz2" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#EFAE41"/>
        <stop offset="0.55" stop-color="#EC9C39"/>
        <stop offset="1" stop-color="#DA662A"/>
      </linearGradient>
    </defs>
    <path d="${arc(cx, cy, r, S, E)}"  fill="none" stroke="rgba(130,130,140,.22)" stroke-width="14" stroke-linecap="round"/>
    <path d="${arc(cx, cy, r, S, nd)}" fill="none" stroke="url(#gz2)"            stroke-width="14" stroke-linecap="round"/>
    ${ticks}
    <line x1="${back.x}" y1="${back.y}" x2="${tip.x}" y2="${tip.y}" stroke="#F68E21" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="9" fill="#F68E21" stroke="rgba(128,128,128,.35)" stroke-width="2"/>
  </svg>`;
}
```

### Readout markup (below the dial)

```html
<div class="burn-readout">
  <div class="big">64%</div>                      <!-- colour: #F68E21 -->
  <div class="sub">72 of 113 hrs used</div>
</div>
```

```css
.burn-readout .big { font-size: 2rem; font-weight: 800; letter-spacing: -.02em; color: #F68E21; }
.burn-readout .sub { font-size: .8rem; color: #8a8a90; }
```

---

## Standalone, copy-paste example

Save as `gauge.html` and open in a browser — renders the dial at 64% exactly as the portal does.

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { background:#161616; font-family: Inter, system-ui, sans-serif; display:grid; place-items:center; height:100vh; }
  .burn-readout .big { font-size:2rem; font-weight:800; letter-spacing:-.02em; color:#F68E21; }
  .burn-readout .sub { font-size:.8rem; color:#8a8a90; }
</style></head>
<body>
  <div style="text-align:center">
    <div id="dial"></div>
    <div class="burn-readout">
      <div class="big" id="pct">64%</div>
      <div class="sub">72 of 113 hrs used</div>
    </div>
  </div>
<script>
  const polar=(cx,cy,r,deg)=>{const a=(deg-90)*Math.PI/180;return{x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};};
  const arc=(cx,cy,r,s,e)=>{const a=polar(cx,cy,r,e),b=polar(cx,cy,r,s);return `M ${a.x} ${a.y} A ${r} ${r} 0 ${e-s<=180?0:1} 0 ${b.x} ${b.y}`;};
  function gauge(pct){
    const p=Math.max(0,Math.min(100,pct)),cx=130,cy=140,r=100,S=-120,E=120,SW=E-S;
    const nd=S+p/100*SW,tip=polar(cx,cy,r-20,nd),back=polar(cx,cy,14,nd+180);
    let t="";for(let i=0;i<=10;i++){const d=S+i/10*SW,o=polar(cx,cy,r,d),inn=polar(cx,cy,r-(i%5===0?15:9),d);
      t+=`<line x1="${o.x}" y1="${o.y}" x2="${inn.x}" y2="${inn.y}" stroke="${i%5===0?"#9a9a9f":"#48484e"}" stroke-width="${i%5===0?2.2:1.4}"/>`;}
    return `<svg viewBox="0 25 260 180" width="240"><defs><linearGradient id="gz2" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#EFAE41"/><stop offset="0.55" stop-color="#EC9C39"/><stop offset="1" stop-color="#DA662A"/></linearGradient></defs>
      <path d="${arc(cx,cy,r,S,E)}" fill="none" stroke="rgba(130,130,140,.22)" stroke-width="14" stroke-linecap="round"/>
      <path d="${arc(cx,cy,r,S,nd)}" fill="none" stroke="url(#gz2)" stroke-width="14" stroke-linecap="round"/>${t}
      <line x1="${back.x}" y1="${back.y}" x2="${tip.x}" y2="${tip.y}" stroke="#F68E21" stroke-width="3.5" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="9" fill="#F68E21" stroke="rgba(128,128,128,.35)" stroke-width="2"/></svg>`;
  }
  const PCT = 64;                       // ← set the burn %
  document.getElementById('dial').innerHTML = gauge(PCT);
  document.getElementById('pct').textContent = PCT + '%';
</script>
</body>
</html>
```

---

*From the TJA Client Portal (Executive Summary · Retainer Burn). Generated for reference.*
