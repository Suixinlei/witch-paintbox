import type { ExtractionState } from "../domain/types";

/** Used only when the shared library has never been saved; an empty saved list stays empty. */
export const defaultOutfits: NonNullable<ExtractionState["outfits"]> = [
  {
    id: "black-bunny-suit",
    name: "黑色兔女郎 · 黑丝裤袜",
    description:
      "Black bunny girl outfit: a fitted black strapless bunny bodysuit with a sweetheart neckline, high-cut leg openings, a small white fluffy bunny tail, and a black bunny-ear headband. A crisp white collar with a clearly visible black bow tie at the neck. Matching white cuffs on both wrists, each decorated with a clearly visible black wrist bow. Sheer black full-length pantyhose covering both legs and feet, with a continuous fine nylon texture rather than separate thigh-high stockings. Black high heels. Keep the neck bow tie and both wrist bows visible whenever those areas are in frame.",
  },
];
