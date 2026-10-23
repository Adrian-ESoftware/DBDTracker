import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatWikiDescription,
  normalizeWikiData,
  createWikiCatalog
} from "./wiki-catalog.js";

test("formatWikiDescription resolve placeholders Tunable, Keyword e Input", () => {
  const raw = "Whenever you vault, gain {Tunable.S02P03.Haste%}% {Keyword.Haste} for {Tunable.S02P03.ExhaustionDuration}s using {Input.ActivatableButton1}.";
  const tunables = {
    "haste%": [50],
    exhaustionduration: [60, 50, 40]
  };
  const formatted = formatWikiDescription(raw, tunables);
  assert.ok(formatted.includes('<strong class="wiki-tunable">50</strong>'));
  assert.ok(formatted.includes('<strong class="wiki-tunable">60/50/40</strong>'));
  assert.ok(formatted.includes("Pressa (Haste)"));
  assert.ok(formatted.includes("Botão de Habilidade Ativa"));
});

test("createWikiCatalog normaliza e salva cache local de perks e addons", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "dbd-wiki-test-"));
  const cachePath = join(tempDir, "dbd-wiki-cache.json");

  const mockFetch = async url => {
    const u = String(url);
    if (u.endsWith("/perks")) {
      return {
        ok: true,
        async json() {
          return {
            WindowsOfOpportunity: {
              name: "Windows of Opportunity",
              description: "See auras within {Tunable.S13P02.Cooldown}m.",
              role: "survivor",
              character: 10,
              tunables: { cooldown: [24, 28, 32] }
            }
          };
        }
      };
    }
    if (u.endsWith("/addons")) {
      return {
        ok: true,
        async json() {
          return {
            Addon_Beartrap_001: {
              name: "Honing Stone",
              description: "Inflicts deep wounds.",
              role: "killer",
              rarity: "veryrare"
            }
          };
        }
      };
    }
    if (u.endsWith("/characters")) {
      return {
        ok: true,
        async json() {
          return {
            "10": { id: "Kate", name: "Kate Denson", role: "survivor" }
          };
        }
      };
    }
    return { ok: true, async json() { return {}; } };
  };

  const catalog = createWikiCatalog({ cachePath, fetchImpl: mockFetch });
  const data = await catalog.refresh({ force: true });

  assert.ok(existsSync(cachePath));
  assert.equal(data.perks.WindowsOfOpportunity.name, "Windows of Opportunity");
  assert.equal(data.perks.WindowsOfOpportunity.owner, "Kate Denson");
  assert.ok(data.perks.WindowsOfOpportunity.description.includes("24/28/32"));
  assert.equal(data.addons.Addon_Beartrap_001.name, "Honing Stone");
  assert.equal(data.addons.Addon_Beartrap_001.rarity, "veryrare");
});
