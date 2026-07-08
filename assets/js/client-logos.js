/* ============================================================
   CLIENT LOGOS
   Maps a client (by normalized name) to its website domain, and
   builds a logo URL via icon.horse (returns the site's best
   logo/icon for a domain). Used by the WMJ sync to set each
   client's tile logo. Tiles fall back to initials if the image
   fails to load (the <img onerror> handles that).

   Domains researched from each company's official site. Any client
   not listed (or with a null domain) keeps its initials avatar, and
   admins can still upload a real logo via Edit client.
   ============================================================ */
window.CLIENT_LOGOS = (function () {
  // normalized name (lowercase, alphanumeric only) → primary website domain
  const DOMAINS = {
    anewleaf: "turnanewleaf.org",
    arizonadepartmentofchildsafety: "dcs.az.gov",
    arizonadepartmentofhealthservices: "azdhs.gov",
    azhumanesociety: "azhumane.org",
    cityofscottsdale: "scottsdaleaz.gov",
    customcontrolsofarizona: "customcontrolsaz.com",
    dellshireresort: "dellshireresort.com",
    donornetworkofarizona: "dnaz.org",
    foxrestaurantconcepts: "foxrc.com",
    greenlightcommunitiesllc: "livegreenlight.com",
    healthcareoutcomeperformancecompany: "hopco.com",
    hotelvalleyho: "hotelvalleyho.com",
    hughlytlepoliticalbrand: "hughlytle.com",
    innerbloomdarkretreats: "innerbloomdarkretreats.com",
    jojocoffeehousebreakfastbrunch: "jojocoffeehouse.com",
    maricopacountyfair: "maricopacountyfair.org",
    mountainshadows: "mountainshadows.com",
    phoenixchildrenshospital: "phoenixchildrens.org",
    professionalpipingsystemsllc: "ppsphx.com",
    rcsinc: "rcsfun.com",
    restorationhq: "restorationhq.us",
    saddleback: "saddlebackarizona.com",
    sagehospitalitygroup: "sagehospitalitygroup.com",
    saltriverproject: "srpnet.com",
    santanbrewing: "santanbrewing.com",
    sellahomes: "sellahomes.com",
    subzerogroupsouthwest: "subzero-wolf.com",
    usapickleball: "usapickleball.org",
    vixxofacilitysolutions: "vixxo.com",
    woodpartnersgoldwater: "woodpartners.com",
  };
  // Dominant brand colour sampled from each client's real logo (the vivid, non-white/grey
  // pixel that carries the most weight). Precomputed from the logos above because the colourful
  // icon services (DuckDuckGo/Google) don't send CORS headers, so a browser canvas can't read
  // their pixels at runtime. Used as the DEFAULT "Client" colour for To-Do tags; an admin colour
  // override always wins. null = logo was monochrome/greyscale → falls back to the default blue.
  const COLORS = {
    anewleaf: "#b6d03b",
    arizonadepartmentofchildsafety: "#cb6c21",
    arizonadepartmentofhealthservices: "#369992",
    azhumanesociety: "#f17132",
    cityofscottsdale: "#0376bb",
    customcontrolsofarizona: "#86b1fb",
    dellshireresort: "#6d0013",
    donornetworkofarizona: "#aec58a",
    foxrestaurantconcepts: null,
    greenlightcommunitiesllc: "#17a36d",
    healthcareoutcomeperformancecompany: null,
    hotelvalleyho: "#ef862e",
    hughlytlepoliticalbrand: "#e15d26",
    innerbloomdarkretreats: null,
    jojocoffeehousebreakfastbrunch: "#9aa9cd",
    maricopacountyfair: "#1368b2",
    mountainshadows: "#b89930",
    phoenixchildrenshospital: "#f91e26",
    professionalpipingsystemsllc: null,
    rcsinc: "#fa0202",
    restorationhq: "#d95931",
    saddleback: "#d25e33",
    sagehospitalitygroup: "#ea7b58",
    saltriverproject: "#39639c",
    santanbrewing: "#ee3224",
    sellahomes: null,
    subzerogroupsouthwest: "#bdd02c",
    usapickleball: "#12324c",
    vixxofacilitysolutions: null,
    woodpartnersgoldwater: null,
  };
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function domainFor(name) { return DOMAINS[norm(name)] || null; }
  function logoColorFor(name) { return COLORS[norm(name)] || null; }
  // DuckDuckGo's icon service: fast, cached, reliable, and higher-res than most.
  function logoUrlFor(name) { const d = domainFor(name); return d ? "https://icons.duckduckgo.com/ip3/" + d + ".ico" : ""; }
  return { DOMAINS, COLORS, domainFor, logoColorFor, logoUrlFor };
})();
