# Walkable grid rules

The grid is built from these rules and nothing else (`tools/build-grid-cells.mjs`).
The avatar is a 0.5×0.5×0.5 cube. Cells are 1×1×1 units.

1. A cell is a 1×1×1 unit. A node connects only to the 8 surrounding columns at
   level −1, 0 or +1, and only if the target cell has a node too. No vertical moves.
2. A cell's node is always at its horizontal center, at the height of its floor.
3. Never a node: `Prop_Bridge_Rope_Middle_Cracked_2_1x1` (the broken-bridge gap).
4. Always a node, regardless of rules 5–7 (still honouring 3, and edge rules 8/14):
   `Docks_Decking_Flat_1x1`, `Docks_Decking_Flat_1x2`, `Docks_Decking_Steps_1x2`,
   `Prop_Bridge_Rope_Middle_Cracked_1_1x1`, `Prop_Bridge_Rope_Middle_Basic_1x1`,
   `Prop_Bridge_Rope_End_Basic_1x3`, `Path_Bridge_Center_Top_1x2`,
   `Path_Bridge_Edge_Top_1x2`, `Prop_Bridge_Center_1x2`, `Prop_Bridge_End_2x2` —
   on the cells where the piece has a top surface with standing clearance.
5. A cell containing water is sealed: no node, no edge may pass through it.
   Even when grass or sand lies below the water.
6. A cell containing cliff-family geometry (`Basic_`, `Cracked_`,
   `Cave_Edge_`) is sealed the same way. Except where rule 4 applies.
   (For now cliff is defined by piece family; later by material, when cave
   floors get their own material. `Wall_` pieces are not in the family: their
   sloped foot spills into the passage cells beside them, so they are left to
   the cube like any other obstacle.)
7. A cell only gets a node if the cube, standing on the floor, has clear space
   (the 0.5 above the local floor) at the center and can cross out via at least
   two of its four edges.
8. An obstacle that stops the cube crossing a particular edge blocks the
   connections through that edge only.
9. Grass floors get a node, unless restricted above.
10. Dirt floors (including sand and dirt paths) get a node, unless restricted above.
11. Cave floors (`Cave_Center_`, `Floor_` pieces) get a node, unless restricted above.
12. `Tiered_Walkway_*` pieces always get a node.
13. Tiered retaining walls block the edge they sit on (they are obstacles under
    rule 8; no special code).
14. The cube climbs and descends the ground as long as it changes less than
    0.5 per 0.5 of run, measured at 0.5 granularity; the clear space travels
    with it, 0.5 above the local ground. Missing ground (a void) blocks.

Implementation readings, per the confirmed answers:

- The cube is a real volume: standing and every crossing test the 0.5 box
  itself against geometry (no rays, no piece lists for obstacles). It rests
  on the highest ground under its footprint; anything else inside the box
  blocks - fences, rails, crates, walls, whatever is added later.
- Ground belongs to rule 14, not to collision: faces walkable-steep or
  flatter carry the cube; the strict <0.5 per 0.5 rise limit decides what it
  may climb. Kit slopes max 0.375, walkway risers 0.25; terrace walls at 0.5
  are blocked by the limit itself.
- Ground is read over the whole 0.5×0.5 footprint (the highest up-facing
  surface anywhere under the square), never at points. The kit's plank seams
  sit exactly on the quarter lines of a cell, so point probes at the centre
  and corners all fall through them; the footprint reading makes a seam
  narrower than the cube invisible, and the cube stands and climbs on what
  is really under it.
- Rules 5 and 6 are literal: a cell containing any water or cliff-family
  geometry (beyond 0.02 float tolerance) is sealed shut.
- Rule 13 is not redundant: retaining walls block their edge even when the
  cube would fit - the one declared exception, because a wall flush with the
  upper terrace is invisible to collision from above.
- Rule 7 counts all 8 exit directions; rule 8's cube may cross anywhere
  along an edge (corridors shifted sideways up to 0.25).
- A floor exactly on a cell boundary belongs to the cell above it.
- Decoration lower than 0.25 resting on an eligible floor is ground relief:
  the cube stands on it, the floor beneath grants the node.
