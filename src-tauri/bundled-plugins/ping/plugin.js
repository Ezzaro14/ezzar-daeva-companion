// Ping: the meter's ping to the game server (a2.on("ping"), meter 2.0.73 on)
// in a widget the player drags anywhere and locks in place. This page holds
// the settings and hands each new ping to the widget.
const $ = (s) => document.querySelector(s);
const els = { value: $(".now .value"), show: $(".show"), lock: $(".lock"), background: $(".background"), bars: $(".bars"), size: $(".size"), good: $(".good"), fair: $(".fair") };

const UI = {
  en: { now: "Ping now", show: "Show the ping widget", lock: "Lock the widget", lockNote: "Clicks pass through to the game. Unlock to move it.", background: "Show the background", bars: "Show the signal bars", size: "Size", small: "Small", medium: "Medium", large: "Large", good: "Green up to", fair: "Amber up to", help: "Drag the widget anywhere. Double-click it to open this window.", old: "Needs meter 2.0.73 or newer" },
  ko: { now: "현재 핑", show: "핑 위젯 표시", lock: "위젯 잠금", lockNote: "클릭이 게임으로 통과됩니다. 옮기려면 잠금을 푸세요.", background: "배경 표시", bars: "신호 막대 표시", size: "크기", small: "작게", medium: "보통", large: "크게", good: "초록색 최대", fair: "주황색 최대", help: "위젯을 원하는 곳으로 끌어 놓으세요. 더블클릭하면 이 창이 열립니다.", old: "미터 2.0.73 이상이 필요합니다" },
  ja: { now: "現在のPing", show: "Pingウィジェットを表示", lock: "ウィジェットをロック", lockNote: "クリックがゲームに通ります。動かすにはロックを解除。", background: "背景を表示", bars: "電波バーを表示", size: "サイズ", small: "小", medium: "中", large: "大", good: "緑の上限", fair: "橙の上限", help: "ウィジェットは好きな場所にドラッグできます。ダブルクリックでこの画面を開きます。", old: "メーター2.0.73以降が必要です" },
  de: { now: "Ping jetzt", show: "Ping-Widget anzeigen", lock: "Widget sperren", lockNote: "Klicks gehen zum Spiel durch. Zum Verschieben entsperren.", background: "Hintergrund anzeigen", bars: "Signalbalken anzeigen", size: "Größe", small: "Klein", medium: "Mittel", large: "Groß", good: "Grün bis", fair: "Gelb bis", help: "Zieh das Widget an eine beliebige Stelle. Doppelklick öffnet dieses Fenster.", old: "Benötigt Meter 2.0.73 oder neuer" },
  fr: { now: "Ping actuel", show: "Afficher le widget de ping", lock: "Verrouiller le widget", lockNote: "Les clics passent au jeu. Déverrouille pour le déplacer.", background: "Afficher le fond", bars: "Afficher les barres de signal", size: "Taille", small: "Petit", medium: "Moyen", large: "Grand", good: "Vert jusqu'à", fair: "Orange jusqu'à", help: "Fais glisser le widget où tu veux. Double-clique dessus pour ouvrir cette fenêtre.", old: "Nécessite le compteur 2.0.73 ou plus récent" },
  es: { now: "Ping actual", show: "Mostrar el widget de ping", lock: "Bloquear el widget", lockNote: "Los clics pasan al juego. Desbloquéalo para moverlo.", background: "Mostrar el fondo", bars: "Mostrar las barras de señal", size: "Tamaño", small: "Pequeño", medium: "Mediano", large: "Grande", good: "Verde hasta", fair: "Ámbar hasta", help: "Arrastra el widget a donde quieras. Haz doble clic para abrir esta ventana.", old: "Necesita el medidor 2.0.73 o posterior" },
  pt: { now: "Ping agora", show: "Mostrar o widget de ping", lock: "Travar o widget", lockNote: "Os cliques passam para o jogo. Destrave para movê-lo.", background: "Mostrar o fundo", bars: "Mostrar as barras de sinal", size: "Tamanho", small: "Pequeno", medium: "Médio", large: "Grande", good: "Verde até", fair: "Âmbar até", help: "Arraste o widget para onde quiser. Clique duas vezes para abrir esta janela.", old: "Requer o medidor 2.0.73 ou mais recente" },
  ru: { now: "Пинг сейчас", show: "Показывать виджет пинга", lock: "Закрепить виджет", lockNote: "Клики проходят в игру. Открепите, чтобы переместить.", background: "Показывать фон", bars: "Показывать полоски сигнала", size: "Размер", small: "Маленький", medium: "Средний", large: "Большой", good: "Зелёный до", fair: "Жёлтый до", help: "Перетащите виджет куда угодно. Двойной щелчок открывает это окно.", old: "Нужен метр 2.0.73 или новее" },
  "zh-Hant": { now: "目前延遲", show: "顯示延遲小工具", lock: "鎖定小工具", lockNote: "點擊會穿透到遊戲。解鎖後才能移動。", background: "顯示背景", bars: "顯示訊號格", size: "大小", small: "小", medium: "中", large: "大", good: "綠色上限", fair: "橘色上限", help: "可將小工具拖到任何位置。按兩下開啟此視窗。", old: "需要計量器 2.0.73 或更新版本" },
  "zh-Hans": { now: "当前延迟", show: "显示延迟小组件", lock: "锁定小组件", lockNote: "点击会穿透到游戏。解锁后才能移动。", background: "显示背景", bars: "显示信号格", size: "大小", small: "小", medium: "中", large: "大", good: "绿色上限", fair: "橙色上限", help: "可将小组件拖到任意位置。双击打开此窗口。", old: "需要计量器 2.0.73 或更新版本" },
};
let words = UI.en;

const DEFAULTS = { show: true, background: true, bars: true, size: "1", good: 80, fair: 150 };
let prefs = { ...DEFAULTS };
let ms = null;
let heard = false;
// Whether AION2 is open: the widget only shows while it is. The meter says
// at start (after a2.ready) and on each change; until then, closed, so the
// widget doesn't flash up with the game shut.
let gameOpen = false;

const stateOf = (v) => (typeof v !== "number" ? "none" : v <= prefs.good ? "good" : v <= prefs.fair ? "fair" : "poor");
// The widget's window: the pill and a little room for its shadow.
const sizeOf = (scale) => ({ width: Math.round(118 * scale), height: Math.round(38 * scale) });

function translate() {
  for (const el of document.querySelectorAll("[data-t]")) {
    const text = words[el.dataset.t];
    if (text) el.textContent = text;
  }
}

function render() {
  els.value.dataset.state = stateOf(ms);
  els.value.textContent = typeof ms === "number" ? `${ms} ms` : heard ? "– ms" : words.old;
}

const widgetShown = () => prefs.show && gameOpen;

async function sendWidget() {
  if (!widgetShown()) return;
  await a2.widgets.send("ping", { ms, state: stateOf(ms), scale: Number(prefs.size), background: prefs.background, bars: prefs.bars }).catch(() => {});
}

async function placeWidget() {
  if (widgetShown()) {
    await a2.widgets.open("ping", sizeOf(Number(prefs.size))).catch(() => {});
    await sendWidget();
  } else {
    await a2.widgets.close("ping").catch(() => {});
  }
}

async function save() {
  await a2.storage.set("prefs", prefs).catch(() => {});
}

a2.on("ping", (d) => {
  heard = true;
  ms = d && typeof d.ms === "number" ? d.ms : null;
  render();
  sendWidget();
});
a2.on("game", (d) => {
  const open = !!(d && d.running);
  if (open === gameOpen) return;
  gameOpen = open;
  placeWidget();
});
a2.on("language", (code) => {
  words = UI[code] || UI[String(code).split("-")[0]] || UI.en;
  translate();
  render();
});
a2.on("locked", (on) => {
  els.lock.checked = !!on;
});
// The widget's double-click: this window.
a2.on("widget-message", ({ data }) => {
  if (data && data.open) a2.window?.show?.();
});

els.show.addEventListener("change", async () => {
  prefs.show = els.show.checked;
  await save();
  placeWidget();
});
els.lock.addEventListener("change", () => a2.widgets.lock(els.lock.checked).catch(() => {}));
for (const key of ["background", "bars"]) {
  els[key].addEventListener("change", async () => {
    prefs[key] = els[key].checked;
    await save();
    sendWidget();
  });
}
els.size.addEventListener("change", async () => {
  prefs.size = els.size.value;
  await save();
  placeWidget();
});
for (const key of ["good", "fair"]) {
  els[key].addEventListener("change", async () => {
    const v = Math.round(Number(els[key].value));
    if (!Number.isFinite(v) || v <= 0) {
      els[key].value = prefs[key];
      return;
    }
    prefs[key] = v;
    // Amber starts where green ends.
    if (prefs.fair <= prefs.good) prefs.fair = prefs.good + 10;
    els.good.value = prefs.good;
    els.fair.value = prefs.fair;
    await save();
    render();
    sendWidget();
  });
}

(async () => {
  const stored = await a2.storage.get("prefs").catch(() => null);
  if (stored && typeof stored === "object") prefs = { ...DEFAULTS, ...stored };
  els.show.checked = prefs.show;
  els.background.checked = prefs.background;
  els.bars.checked = prefs.bars;
  els.size.value = String(prefs.size);
  els.good.value = prefs.good;
  els.fair.value = prefs.fair;
  els.lock.checked = await a2.widgets.locked().catch(() => false);
  translate();
  render();
  await placeWidget();
  a2.ready();
})();
