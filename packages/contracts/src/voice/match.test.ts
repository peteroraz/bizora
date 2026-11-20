import { describe, expect, it } from "vitest";
import { decide, nameScore, rank, soundKey } from "./match.js";

const products = [
  { id: "rice", name: "Rice (Mama Gold) 50kg" },
  { id: "indomie", name: "Indomie Noodles 70g" },
  { id: "indomie-belle", name: "Indomie Belle Full 120g" },
  { id: "cement", name: "Dangote Cement" },
  { id: "bua", name: "BUA Cement" },
  { id: "peak", name: "Peak Milk" },
  { id: "coke", name: "Coca-Cola 50cl" },
  { id: "sugar", name: "Dangote Sugar" },
];
const find = (spoken: string) => decide(rank(spoken, products, (item) => [item.name]));

describe("matching spoken names", () => {
  it("finds a product from part of its name", () => {
    expect(find("rice")).toMatchObject({ status: "sure", best: { id: "rice" } });
    expect(find("Dangote cement")).toMatchObject({ status: "sure", best: { id: "cement" } });
    expect(find("carton of Indomie noodles")).toMatchObject({ status: "sure", best: { id: "indomie" } });
  });

  it("finds names that sound alike or are misheard", () => {
    expect(soundKey("peak")).toBe(soundKey("pick"));
    expect(find("pick milk")).toMatchObject({ best: { id: "peak" } });
    expect(find("indomi noodles")).toMatchObject({ best: { id: "indomie" } });
    expect(find("coca cola")).toMatchObject({ status: "sure", best: { id: "coke" } });
  });

  it("asks when two products fit about as well", () => {
    const indomie = find("Indomie");
    expect(indomie.status).toBe("choose");
    expect(indomie.options.map((item) => item.id).slice(0, 2).sort()).toEqual(["indomie", "indomie-belle"]);
    expect(find("cement").status).toBe("choose");
    expect(find("Dangote").status).toBe("choose");
  });

  it("finds nothing rather than something wrong", () => {
    expect(find("generator").status).toBe("none");
    expect(find("").status).toBe("none");
  });

  it("matches customers, with titles and repeated first names", () => {
    const customers = [
      { id: "1", name: "Emeka Obi" },
      { id: "2", name: "Emeka Nwosu" },
      { id: "3", name: "Mama Ngozi" },
      { id: "4", name: "Chinedu Eze" },
    ];
    const who = (spoken: string) => decide(rank(spoken, customers, (item) => [item.name], { people: true }));
    expect(who("Emeka").status).toBe("choose");
    expect(who("Emeka").options.map((item) => item.id).sort()).toEqual(["1", "2"]);
    expect(who("Emeka Obi")).toMatchObject({ status: "sure", best: { id: "1" } });
    expect(who("Chinedu")).toMatchObject({ status: "sure", best: { id: "4" } });
    expect(who("Ngozi")).toMatchObject({ best: { id: "3" } });
    expect(who("Bola").status).toBe("none");
  });

  it("keeps sizes apart", () => {
    expect(nameScore("rice 25kg", "Rice (Mama Gold) 50kg")).toBeLessThan(nameScore("rice 50kg", "Rice (Mama Gold) 50kg"));
  });
});
