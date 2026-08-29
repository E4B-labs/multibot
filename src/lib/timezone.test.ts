import { describe, expect, it } from "vitest";
import {
  AUTO_TIMEZONE,
  detectTimeZone,
  filterTimeZones,
  listTimeZones,
  readTimeZone,
  resolveTimeZone,
  writeTimeZone,
  zoneLabel,
  zoneTime,
} from "./timezone";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("strefa czasowa", () => {
  it("lista jest pełna i w kolejności IANA", () => {
    const zones = listTimeZones();
    expect(zones.length).toBeGreaterThan(100);
    expect(zones).toContain("Europe/Warsaw");
    expect(zones).toContain("Africa/Addis_Ababa");
    // pierwsze pozycje ze zdjęcia: lista nie jest przesortowana po swojemu
    expect(zones.slice(0, 3)).toEqual(["Africa/Abidjan", "Africa/Accra", "Africa/Addis_Ababa"]);
  });

  it("podkreślenia znikają dopiero na ekranie, nie w danych", () => {
    expect(zoneLabel("Africa/Addis_Ababa")).toBe("Africa/Addis Ababa");
    expect(zoneLabel("Europe/Warsaw")).toBe("Europe/Warsaw");
    expect(listTimeZones()).toContain("Africa/Addis_Ababa");
  });

  it("szuka tak, jak użytkownik widzi nazwę — ze spacją i bez ogonków", () => {
    const zones = ["Africa/Addis_Ababa", "Europe/Warsaw", "America/New_York"];
    expect(filterTimeZones(zones, "addis ababa")).toEqual(["Africa/Addis_Ababa"]);
    expect(filterTimeZones(zones, "addis_ababa")).toEqual(["Africa/Addis_Ababa"]);
    expect(filterTimeZones(zones, "NEW YORK")).toEqual(["America/New_York"]);
    expect(filterTimeZones(zones, "  ")).toEqual(zones);
    expect(filterTimeZones(zones, "nie ma takiej")).toEqual([]);
  });

  it("godzina liczy się w wybranej strefie, a nieznana strefa nie wywraca listy", () => {
    const noon = new Date("2026-08-29T12:00:00Z");
    expect(zoneTime("UTC", noon)).toBe("12:00");
    expect(zoneTime("Europe/Warsaw", noon)).toBe("14:00");
    expect(zoneTime("Nie/Istnieje", noon)).toBe("");
  });

  it("automatyczna nie zapisuje nazwy, więc idzie za zegarem komputera", () => {
    const storage = memoryStorage();
    writeTimeZone("Asia/Tokyo", storage);
    expect(readTimeZone(storage)).toBe("Asia/Tokyo");
    writeTimeZone(AUTO_TIMEZONE, storage);
    expect(storage.map.size).toBe(0);
    expect(readTimeZone(storage)).toBe(AUTO_TIMEZONE);
  });

  it("do użycia wchodzi wybrana strefa, a przy automatycznej — wykryta", () => {
    expect(resolveTimeZone("Asia/Tokyo", "Europe/Warsaw")).toBe("Asia/Tokyo");
    expect(resolveTimeZone(AUTO_TIMEZONE, "Europe/Warsaw")).toBe("Europe/Warsaw");
    expect(detectTimeZone().length).toBeGreaterThan(0);
  });

  it("brak pamięci nie wywraca odczytu ani zapisu", () => {
    expect(readTimeZone(undefined)).toBe(AUTO_TIMEZONE);
    expect(() => writeTimeZone("Asia/Tokyo", undefined)).not.toThrow();
  });
});
