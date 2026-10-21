// The World Bosses list on the overlay (bosslist.js sends it what to show).
// Its title folds it open or shut; each boss's bell turns its popup on or
// off. Both work while the overlay is locked (the widget is clickable);
// unlocked, the title can be dragged too.
(() => {
  if (a2.widget.name !== "bosses") return;
  window.bossListWidget = true;
  document.body.classList.add("bosslist");
  const box = document.querySelector(".bossList");
  box.hidden = false;
  let data = null;
  let locked = true;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const BELL = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const HEADS = { up: "Up now", window: "Spawning", upcoming: "Next" };
  let scroll = 0;

  function render() {
    if (!data) {
      box.innerHTML = `<div class="blHead"><span class="blTitle w-kicker">Timers</span></div>`;
      return reportArea();
    }
    // Folded: only what is up or starts within 30 minutes; open: all of it.
    const shown = data.expanded ? data.rows : data.rows.filter((r) => r.near);
    const later = data.rows.length - data.rows.filter((r) => r.near).length + (data.more || 0);
    box.classList.toggle("open", !!data.expanded);
    box.classList.toggle("near", !data.expanded && shown.length > 0);
    const summary = !data.tracked
      ? "Nothing tracked yet: click to pick"
      : data.noServer
      ? "Log in to see your server's"
      : data.expanded || !shown.length
      ? [data.up ? `<span class="blUp">${data.up} up</span>` : "", data.next ? `next <b>${esc(data.next.name)}</b> <span class="w-num${data.next.soon ? " soon" : ""}">${esc(data.next.when)}</span>` : data.up ? "" : "no timers yet"]
          .filter(Boolean)
          .join(" · ")
      : later
      ? `${later} later`
      : "";
    let html = `<button type="button" class="blHead" data-act="toggle">
        <span class="blTitle w-kicker">Timers</span><span class="blSum">${summary}</span>${CHEVRON}</button>`;
    if (data.expanded || shown.length) {
      let group = "";
      html += '<ol class="blRows">';
      for (const r of shown) {
        if (r.group !== group) {
          group = r.group;
          html += `<li class="blGroup ${group}">${HEADS[group]}</li>`;
        }
        const hp = r.hp != null ? `<i class="blHp" style="--hp:${r.hp}%"></i>` : "";
        html += `<li class="blRow ${r.group}${r.soon ? " soon" : ""}">
            <div class="blMain"><div class="blName">${esc(r.name)}${r.level ? ` <span class="blLv">Lv ${r.level}</span>` : ""}</div>
            <div class="blWhere">${r.tag ? `<span class="blTag">${esc(r.tag)}</span>` : ""}${esc(r.where)}</div>${hp}</div>
            <div class="blWhen"><span class="w-num">${esc(r.hp != null ? `${Math.round(r.hp)}%` : r.when)}</span>${r.at ? `<small>${esc(r.at)}</small>` : r.hp != null ? `<small>${esc(r.when)}</small>` : ""}</div>
            <button type="button" class="blBell${r.alert ? " on" : ""}" data-act="bell" data-id="${esc(r.id)}" title="${r.alert ? "Popup on: click to turn it off" : `Popup ${data.lead} min before it spawns`}">${BELL}</button>
          </li>`;
      }
      if (data.expanded && !data.rows.length) html += `<li class="blEmpty">${!data.tracked ? "Pick the bosses and events you follow on Event Timers' Track tab." : data.noServer ? "Log in to a character to see your server's timers." : "No timers reported yet for what you track."}</li>`;
      html += "</ol>";
    }
    if (data.expanded) {
      const foot = [data.more ? `${data.more} more on the Bosses tab` : "", data.unknown ? `${data.unknown} tracked without a timer yet` : ""].filter(Boolean).join(" · ");
      html += `<div class="blFoot">${foot ? `${foot} · ` : ""}<span class="bellHint">${BELL}</span> = popup before it spawns</div>`;
    }
    // Drawn anew each second: the scroll stays where it was.
    const before = box.querySelector(".blRows");
    if (before) scroll = before.scrollTop;
    box.innerHTML = html;
    const rows = box.querySelector(".blRows");
    if (rows) {
      rows.scrollTop = scroll;
      rows.addEventListener("scroll", () => (scroll = rows.scrollTop), { passive: true });
    }
    reportArea();
  }

  // Only the list takes the mouse; around it clicks go to the game.
  let lastArea = "";
  function reportArea() {
    const r = box.getBoundingClientRect();
    const area = { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    const key = JSON.stringify(area);
    if (key === lastArea) return;
    lastArea = key;
    a2.widget.area(area).catch(() => {});
  }

  // A click on the title folds it; on a bell, that boss's popup. Unlocked, a
  // press on the title that moves drags the list instead.
  let press = null;
  box.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const head = e.target.closest?.(".blHead");
    if (head && !locked) press = { x: e.screenX, y: e.screenY };
  });
  document.addEventListener("mousemove", (e) => {
    if (!press || !(e.buttons & 1)) return void (press = null);
    if (Math.abs(e.screenX - press.x) + Math.abs(e.screenY - press.y) >= 4) {
      press = { dragged: true };
      a2.widget.drag().catch(() => {});
    }
  });
  box.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-act]");
    if (!btn) return;
    if (press?.dragged) return void (press = null);
    press = null;
    if (btn.dataset.act === "toggle" && data && !data.tracked) {
      a2.widget.post({ open: true, track: true }).catch(() => {});
    } else if (btn.dataset.act === "toggle") {
      data && (data.expanded = !data.expanded);
      render();
      a2.widget.post({ toggle: true }).catch(() => {});
    } else if (btn.dataset.act === "bell") {
      btn.classList.toggle("on");
      a2.widget.post({ bossAlert: btn.dataset.id }).catch(() => {});
    }
  });
  box.addEventListener("dblclick", (e) => {
    if (e.target.closest?.(".blRow")) a2.widget.post({ open: true }).catch(() => {});
  });
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  a2.on("widget", (d) => {
    if (!d || d.kind !== "bosslist") return;
    data = d;
    render();
  });
  a2.on("locked", (on) => {
    locked = !!on;
    document.body.classList.toggle("locked", locked);
  });
  addEventListener("resize", () => {
    lastArea = "";
    reportArea();
  });
  render();
})();
