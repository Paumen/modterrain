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
6. A cell containing cliff-family geometry (`Basic_`, `Cracked_`, `Wall_`,
   `Cave_Edge_`) is sealed the same way. Except where rule 4 applies.
   (For now cliff is defined by piece family; later by material, when cave
   floors get their own material.)
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

Implementation readings, calibrated against the kit and confirmed in play:

- Rule 5 is tested at the standing point, not per cell: a spot is wet when the
  water surface there is at or above its floor. Riverbank cells whose dry
  floor rises above the waterline stay walkable; wading and water crossings
  stay impossible.
- Rule 6 seals a cell when cliff geometry enters its heart (the middle
  0.5×0.5); surface relief spilling less than 0.25 over a border does not
  count as occupying the neighbour cell.
- Rule 7 counts all 8 exit directions, so a corner cell whose only
  continuation is diagonal survives.
- Rule 8's cube may cross anywhere along an edge, not only dead center: the
  sweep tries corridors shifted sideways up to 0.25.
- Rule 14's limit is 0.5 plus float tolerance (0.55), because the kit's own
  stair and terrace risers are exactly 0.5; ground relief lower than the
  0.28 step-over never counts as an obstacle.

