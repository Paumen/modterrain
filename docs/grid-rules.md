# Walkable grid rules

The grid is built from these rules and nothing else (`tools/build/build-grid-cells.mjs`).

1. A grid cell is a 1x1x1 unit, connection if no obstacles, only travel to the 9
   cells around it in its 3x3x3, if they have a node too.
2. If a cell has a walkable node, its node is always at its center.
3. Magic number one never gets a node: `Prop_Bridge_Rope_Middle_Cracked_2_1x1`.
4. Magic number ten always get a node, regardless of any following rules:
   - `atoms/Docks_Decking_Flat_1x1.glb`
   - `atoms/Docks_Decking_Flat_1x2.glb`
   - `atoms/Docks_Decking_Steps_1x2.glb`
   - `atoms/Prop_Bridge_Rope_Middle_Cracked_1_1x1.glb`
   - `atoms/Prop_Bridge_Rope_Middle_Basic_1x1.glb`
   - `atoms/Prop_Bridge_Rope_End_Basic_1x3.glb`
   - `atoms/Path_Bridge_Center_Top_1x2.glb`
   - `atoms/Path_Bridge_Edge_Top_1x2.glb`
   - `atoms/Prop_Bridge_Center_1x2.glb`
   - `atoms/Prop_Bridge_End_2x2.glb`
5. If a cell contains water it's not walkable or crossable (basically the 1x1x1
   cube around it is closed on all six sides, no nodes, no edges, no
   connections). Even when grass or sand below it.
6. If a cell contains cliff it's never walkable / crossable (basically the 1x1x1
   cube around it is closed on all six sides, no nodes, no edges, no
   connections). Except when rule 4 applies.
7. If a cell contains an obstacle that prevents a 0.5/0.5/0.5 unit cube to cross
   its upper half in two edges and the center, the cell does not get a node or
   any connections.
8. If rule 7 is not triggered, and terrain is eligible node, it gets a node; any
   obstacles that prevent a 0.5/0.5/0.5 unit cube to cross it an edge block
   connections via those edges.
9. A node with grass gets a node except if any of above rules restrict it.
10. A node with dirt gets a node except if any of above rules restrict it.
11. A node with cave floor gets a node except if any of above rules restrict it.
12. Tiered walkway steps always get node.
13. Tiered retaining wall always block connection on the edge they sit on.
14. Slope is allowed by less than 0.5 per 0.5 unit, and the cell above it has to
    have free space too.

## Answers given on these rules

- Rule 7's cube: 0.5 from the solid ground empty, then the cube. So the ground
  to ground+0.5 is empty and the cube occupies ground+0.5 to ground+1.0. The
  cube goes hard up down vertically while on slopes.
- Rule 7 is 3 spots: the middle, and 2 directions.
- The cube crossing a cell is 0.5 x 1.0 x 0.5 — the 1.0 is the length across the
  cell, not the height.
- Rule 1: travel to the 8 surrounding columns at level -1, 0 or +1; rule 7's
  directions are the 8 horizontal ones (4 edges and 4 diagonals).
- Rule 2: the node is at the cell's horizontal center, at the height of the
  floor.
- Rule 6: cliff is defined by piece family for now, by material later, when cave
  gets a different material.
