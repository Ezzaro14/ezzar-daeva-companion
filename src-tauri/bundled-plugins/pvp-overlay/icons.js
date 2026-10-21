// An <img> that tries each of the game's icon URLs in turn (the feed lists
// them best first), and falls back to the name's first letter.
function iconElement(icons, name, className = "icon") {
  const wrap = document.createElement("span");
  wrap.className = className;
  const list = Array.isArray(icons) ? icons.slice() : [];
  const letter = () => {
    wrap.replaceChildren();
    wrap.classList.add("letter");
    wrap.textContent = (String(name || "?").trim()[0] || "?").toUpperCase();
  };
  const next = () => {
    const url = list.shift();
    if (!url) return letter();
    const img = new Image();
    img.alt = "";
    img.draggable = false;
    img.onerror = next;
    img.onload = () => wrap.replaceChildren(img);
    img.src = url;
  };
  next();
  return wrap;
}
