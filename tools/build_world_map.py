# Build world-map/maps.js from the bundled GPL plugin data (Pet Soul Tracker's
# sources.js and pets.js, Event Timers' schedule.js): each overworld map's
# Kibelisks (teleports), pet soul monster areas and field bosses.
import json, re, sys
root = sys.argv[1]
def js_object(path, name):
    s = open(path, encoding="utf-8").read()
    i = s.index(f"const {name} =")
    start = s.index("{", i)
    depth = 0
    for j in range(start, len(s)):
        c = s[j]
        if c == "{": depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                text = s[start:j + 1]
                # pets.js uses bare numeric keys: quote them.
                text = re.sub(r'(\n\s*)(\d+):', r'\1"\2":', text)
                return json.loads(text)
src = js_object(f"{root}/pet-souls/sources.js", "PET_SOURCES")
text = js_object(f"{root}/pet-souls/sources.js", "SOURCE_TEXT")
pets = js_object(f"{root}/pet-souls/pets.js", "PET_NAMES")
bosses = js_object(f"{root}/event-timers/schedule.js", "FIELD_BOSSES")
etext = js_object(f"{root}/event-timers/schedule.js", "EVENT_TEXT")
en = lambda key, table=text: (table.get(key) or {}).get("en") or key
maps = {}
for pet_id, p in src.items():
    for d in p.get("drops", []):
        kb = d.get("kibelisk")
        # `to` is the Kibelisk, `at` the monster's spawn it is measured from.
        if not kb or not kb.get("at") or not kb.get("to"): continue
        m = maps.setdefault(d["mapId"], {"name": d.get("region") or en(d["map"]), "key": d["map"], "kibelisks": {}, "monsters": {}, "bosses": []})
        kname = en(kb["name"])
        m["kibelisks"][kname] = {"name": kname, "x": kb["to"][0], "y": kb["to"][1]}
        mon = m["monsters"].setdefault(d["npcId"], {"name": en(d["npc"]), "npcId": d["npcId"], "level": d.get("level"), "x": kb["at"][0], "y": kb["at"][1], "spawns": d.get("spawns"), "kibelisk": kname, "pets": []})
        name = (pets.get(pet_id) or {}).get("en") or pet_id
        if name not in mon["pets"]: mon["pets"].append(name)
for bid, b in bosses.items():
    for m in maps.values():
        if b.get("where") == m["key"]:
            m["bosses"].append({"id": int(bid), "name": en(b["name"], etext), "level": b.get("level"), "side": b.get("side")})
out = {str(k): {"name": v["name"], "kibelisks": list(v["kibelisks"].values()), "monsters": list(v["monsters"].values()), "bosses": v["bosses"]} for k, v in maps.items()}
with open(f"{root}/world-map/maps.js", "w", encoding="utf-8") as f:
    f.write("// The overworld maps' known places, in game coordinates: Kibelisks (teleports),\n"
            "// pet soul monster areas (one of their spawns) and field bosses. Built from\n"
            "// Pet Soul Tracker's and Event Timers' data (A2Tools-Plugins, GPL-3.0) by\n"
            "// tools/build_world_map.py: don't edit by hand.\n")
    f.write("const MAPS = " + json.dumps(out, ensure_ascii=False) + ";\n")
for k, v in out.items(): print(k, v["name"], len(v["kibelisks"]), "kibelisks", len(v["monsters"]), "monsters", len(v["bosses"]), "bosses")
