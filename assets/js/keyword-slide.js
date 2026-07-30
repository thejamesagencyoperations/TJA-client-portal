/* ============================================================
   KEYWORD SLIDE RENDERER — TJA "Brand Keywords" template

   Present Docs deliverables are proof IMAGES. A keyword exercise is
   structured data (three fixed columns of words), so this module paints
   that data onto the agency's Brand Keywords slide and hands back a JPEG
   data URL. That image then IS the deliverable: the gallery thumbnail,
   the review modal, the markup layer and the proof PDF (with its
   signature box + status checkboxes) all work untouched — which is
   exactly how Cameron asked for it to slot in (2026-07-30).

   Geometry is measured from the source template (720x405pt = 10x5.625in,
   the Google Slides 16:9 default), so every number below is in POINTS and
   scaled once by S. Do not "tidy" these into round numbers — they were
   sampled from the artwork.

   Columns are fixed: LOOK / TONE / AUDIENCE, with the header bands
   stepping light→dark (#EFEFEF / #CCCCCC / #999999).
   ============================================================ */
window.TJA_KEYWORD_SLIDE = (function () {
  const PT_W = 720, PT_H = 405;          // source slide size in points
  const OUT_W = 1600;                    // render width (matches processFile's max)
  const S = OUT_W / PT_W;                // points → pixels
  const px = (pt) => pt * S;

  // ---- measured layout (points) ----
  const PANEL = { y: 107.5, w: 152, headH: 32.5, bodyBottom: 331 };
  const COL_X = [37, 197.6, 358.2];      // LOOK / TONE / AUDIENCE
  const PHOTO = { x: 518.8, w: 151.5 };
  const HEAD_FILL = ["#EFEFEF", "#CCCCCC", "#999999"];
  const COLS = ["LOOK", "TONE", "AUDIENCE"];
  const ITEM_FIRST_Y = 162;              // baseline of the first keyword
  const ITEM_STEP = 24;                  // line spacing
  const ITEM_PT = 14;                    // Inter LIGHT 14pt — Cameron's spec
  const BG = "#0A0A0A";

  const IMG_BG = "assets/img/kw-bg.jpg";
  const IMG_PHOTO = "assets/img/kw-photo.jpg";

  function loadImg(src) {
    return new Promise((res) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => res(null);       // missing asset must never break a send
      i.src = src;
    });
  }
  // Inter must be DECODED before we paint, or the canvas silently falls back to a
  // system face and the slide ships with the wrong type.
  async function fonts() {
    if (!document.fonts) return;
    try {
      await Promise.all([
        document.fonts.load(`300 ${px(ITEM_PT)}px Inter`),
        document.fonts.load(`700 ${px(11)}px Inter`),
        document.fonts.load(`900 ${px(38)}px Inter`),
      ]);
      await document.fonts.ready;
    } catch (e) { /* proceed — better a fallback face than no deliverable */ }
  }
  // letterSpacing is Chromium-only on canvas; set it when available, no-op elsewhere.
  const spacing = (x, v) => { try { x.letterSpacing = v; } catch (e) {} };

  /* data: { look:[], tone:[], audience:[] } → JPEG data URL */
  async function render(data) {
    const cols = [data.look || [], data.tone || [], data.audience || []];
    await fonts();
    const [bg, photo] = await Promise.all([loadImg(IMG_BG), loadImg(IMG_PHOTO)]);

    const c = document.createElement("canvas");
    c.width = OUT_W; c.height = Math.round(OUT_W * PT_H / PT_W);
    const x = c.getContext("2d");

    // background: the textured plate, else the flat near-black it samples to
    x.fillStyle = BG; x.fillRect(0, 0, c.width, c.height);
    if (bg) x.drawImage(bg, 0, 0, c.width, c.height);

    // ---- header type ----
    x.textBaseline = "alphabetic";
    x.fillStyle = "#fff";
    // Eyebrow + title LEFT-ALIGN with the first panel (x=37pt) in the source artwork.
    x.font = `700 ${px(8)}px Inter, sans-serif`;
    spacing(x, `${px(0.3)}px`);
    x.fillText("Brand Messaging", px(39), px(45));
    spacing(x, "0px");
    x.font = `900 ${px(38)}px Inter, sans-serif`;
    spacing(x, `${px(-0.6)}px`);
    x.fillText("BRAND KEYWORDS", px(37), px(88));
    spacing(x, "0px");

    // agency wordmark, top right (drawn as type — same treatment as the proof PDF footer)
    x.fillStyle = "#8a8a8a";
    x.font = `600 ${px(6)}px Inter, sans-serif`;
    spacing(x, `${px(1.1)}px`);
    x.textAlign = "right";
    x.fillText("THE JAMES AGENCY", px(670.5), px(40));
    x.textAlign = "left";
    spacing(x, "0px");

    // ---- the three keyword panels ----
    COLS.forEach((title, i) => {
      const X = COL_X[i];
      // header band
      x.fillStyle = HEAD_FILL[i];
      x.fillRect(px(X), px(PANEL.y), px(PANEL.w), px(PANEL.headH));
      x.fillStyle = "#111";
      x.font = `700 ${px(13)}px Inter, sans-serif`;
      spacing(x, `${px(0.2)}px`);
      x.fillText(title, px(X + 12), px(PANEL.y + 22.5));
      spacing(x, "0px");
      // body box — transparent, thin light outline
      x.strokeStyle = "#f2f2f2";
      x.lineWidth = Math.max(1, px(0.7));
      x.strokeRect(px(X) + 0.5, px(PANEL.y + PANEL.headH) + 0.5,
                   px(PANEL.w) - 1, px(PANEL.bodyBottom - PANEL.y - PANEL.headH) - 1);
      // keywords — Inter Light, clipped to the box so a long list can't overflow the art
      x.save();
      x.beginPath();
      x.rect(px(X), px(PANEL.y + PANEL.headH), px(PANEL.w), px(PANEL.bodyBottom - PANEL.y - PANEL.headH));
      x.clip();
      x.fillStyle = "#fff";
      x.font = `300 ${px(ITEM_PT)}px Inter, sans-serif`;
      cols[i].forEach((word, n) => {
        const yPt = ITEM_FIRST_Y + n * ITEM_STEP;
        if (yPt > PANEL.bodyBottom - 4) return;      // past the box — don't paint outside
        x.fillText(String(word), px(X + 18), px(yPt));
      });
      x.restore();
    });

    // ---- fixed photo panel (decorative; not client-specific by design) ----
    if (photo) {
      const dx = px(PHOTO.x), dy = px(PANEL.y),
            dw = px(PHOTO.w), dh = px(PANEL.bodyBottom - PANEL.y);
      // cover-fit so the portrait source fills the panel without distorting
      const sr = photo.naturalWidth / photo.naturalHeight, dr = dw / dh;
      let sw = photo.naturalWidth, sh = photo.naturalHeight, sx = 0, sy = 0;
      if (sr > dr) { sw = sh * dr; sx = (photo.naturalWidth - sw) / 2; }
      else { sh = sw / dr; sy = (photo.naturalHeight - sh) / 2; }
      x.drawImage(photo, sx, sy, sw, sh, dx, dy, dw, dh);
    }

    // "Client Name" slug, bottom right — matches the template's placeholder
    x.fillStyle = "#8a8a8a";
    x.font = `400 ${px(6)}px Inter, sans-serif`;
    x.textAlign = "right";
    x.fillText(String(data.clientName || "Client Name"), px(670.5), px(392));
    x.textAlign = "left";

    return c.toDataURL("image/jpeg", 0.92);
  }

  // How many keywords fit a column before the art would clip them.
  const MAX_ITEMS = Math.floor((PANEL.bodyBottom - 4 - ITEM_FIRST_Y) / ITEM_STEP) + 1;

  return { render, COLS, MAX_ITEMS };
})();
