

For building or adjusting terrain:

Never assume the kit is wrong or has bugs and adjust it. If something seems wrong, it's your placement and understanding how the kit works.

The modular terrain blocks are color-coded and shows which sides/sockets fit together. You can and must blindly trust this. Colour = profile identity; same colour means the two cross-sections are geometrically identical and butt together exactly. The socket colours are in the glTF material names, not vertex colours or textures.

Sides called only "hidden" (no color), typically don't need to connect to something on that side because it's usually not something that a user sees if the pieces are connected as suposse to. Which doesn't mean there's never a good reason to connect something on that side, like another piece facing the other side with also grey in the back, or terrain that's on same square to fill half of bottom in the other side. 

make sure you're renderer doesn't draws backfaces, which hides one-sided shells. A real glTF viewer culls them. Most pieces are one-sided shells.

Mirrored pieces mostly don't exist. Mirroring / flipping is allowed and to be done manually.

Piece origins are cell centres, and multi-cell pieces anchor on one specific cel.
