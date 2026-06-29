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
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function domainFor(name) { return DOMAINS[norm(name)] || null; }
  // DuckDuckGo's icon service: fast, cached, reliable, and higher-res than most.
  function logoUrlFor(name) { const d = domainFor(name); return d ? "https://icons.duckduckgo.com/ip3/" + d + ".ico" : ""; }
  return { DOMAINS, domainFor, logoUrlFor };
})();
